// Compares the public feed + tips library with YOUR setup. Runs 100% locally; nothing is uploaded.
// Reads only: slash-command NAMES from ~/.claude/history.jsonl (never prompt text), settings keys,
// enabled plugin names, installed skill names, and ~/.codex/config.toml.
// Usage: node scripts/gaps.mjs [--feed <url|path>] [--json]
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_FEED = path.resolve(HERE, '..', '..', 'docs', 'feed.json'); // when run from the repo checkout
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const wantJson = args.includes('--json');
// Installed copies carry delta.config.json ({"home": "<path to your delta checkout>"}) so they can find the feed.
let HOME_DIR = ''; try { HOME_DIR = JSON.parse(readFileSync(path.join(HERE, 'delta.config.json'), 'utf8')).home || ''; } catch {}
const HOME_FEED = HOME_DIR ? path.join(HOME_DIR, 'docs', 'feed.json') : '';
const feedSrc = argVal('--feed') || process.env.DELTA_FEED_URL || (existsSync(DEV_FEED) ? DEV_FEED : existsSync(HOME_FEED) ? HOME_FEED : 'https://omarica.github.io/delta/feed.json');

const home = os.homedir();
const tryRead = async (p) => { try { return await readFile(p, 'utf8'); } catch { return ''; } };
const tryJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
async function load(src) {
  if (/^https?:/.test(src)) return (await fetch(src)).json();
  return JSON.parse(await readFile(src, 'utf8'));
}

const feed = await load(feedSrc);
const tipsSrc = /^https?:/.test(feedSrc) ? feedSrc.replace(/feed\.json$/, 'tips.json') : path.join(path.dirname(feedSrc), 'tips.json');
const tips = await load(tipsSrc);

// --- gather local facts ---
const slash = {};
let historyEntries = 0;
for (const line of (await tryRead(path.join(home, '.claude', 'history.jsonl'))).split('\n')) {
  if (!line) continue;
  let d; try { d = JSON.parse(line); } catch { continue; }
  historyEntries++;
  const m = /^\/([\w:-]+)/.exec(d.display || '');
  if (m) slash[m[1]] = (slash[m[1]] || 0) + 1;
}
const settingsRaw = (await tryRead(path.join(home, '.claude', 'settings.json'))) + (await tryRead(path.join(home, '.claude', 'settings.local.json')));
const settings = await tryJson(path.join(home, '.claude', 'settings.json')) || {};
const plugins = Object.entries(settings.enabledPlugins || {}).filter(([, on]) => on).map(([k]) => k.split('@')[0].toLowerCase());
let skills = [];
try { skills = (await readdir(path.join(home, '.claude', 'skills'))).map((s) => s.toLowerCase()); } catch {}
const codexCfg = await tryRead(path.join(home, '.codex', 'config.toml'));
let version = ''; try { version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000 }).trim(); } catch {}
const used = (n) => slash[n] || 0;

// --- findings ---
const actions = [];
const inFeed = new Set(feed.items.map((i) => i.tipId).filter(Boolean));

for (const t of tips) {
  if (t.tool === 'Codex' && !codexCfg) continue;
  const d = t.detect || {};
  let adopted = false;
  if (d.slash) adopted = d.slash.some((c) => used(c) > 0);
  if (d.setting) adopted = d.setting.some((k) => settingsRaw.includes(`"${k}"`));
  if (d.codexConfig) adopted = d.codexConfig.some((k) => new RegExp(`${k}\\s*=\\s*true`).test(codexCfg));
  if (d.never) adopted = !inFeed.has(t.id); // only surface "never"-detectable tips when the feed is talking about them
  if (adopted) continue;
  actions.push({ kind: 'try', weight: (inFeed.has(t.id) ? 20 : 0) + (t.since ? 5 : 0), title: t.title, command: t.try, why: t.why, id: t.id });
}

// Habit: heavy /clear, almost no compacting.
if (used('clear') >= 100 && used('compact') < used('clear') / 20) {
  actions.push({ kind: 'habit', weight: 18, title: `You ran /clear ${used('clear')}x but /compact ${used('compact')}x`,
    command: '/rewind → "Summarize up to here"   (or let auto-compact run)',
    why: 'Each /clear throws away context you may have wanted. Summarizing keeps the useful part and the prompt cache.' });
}

// Overlapping plugins/skills.
const overlaps = JSON.parse(await readFile(path.join(HERE, 'overlaps.json'), 'utf8'));
for (const g of overlaps) {
  const have = g.plugins.filter((p) => plugins.some((x) => x.includes(p)) || skills.some((x) => x.includes(p)));
  if (have.length >= 2) actions.push({ kind: 'swap', weight: 16, title: `${g.group}: you have ${have.join(' + ')}`, command: 'Keep one as primary; disable the rest in /plugin', why: g.note });
}

// Feed items worth a look (skip tools you do not use).
const feedPicks = feed.items.filter((i) => i.tool !== 'Codex' || codexCfg).map((i) => ({
  kind: i.kind, title: i.title, command: i.action || '', why: i.why, url: i.url,
}));

actions.sort((a, b) => b.weight - a.weight);
const result = {
  generated: new Date().toISOString(), claudeVersion: version, historyEntries,
  plugins: plugins.length, skills: skills.length, codexInstalled: !!codexCfg,
  forYou: actions.slice(0, 5), fromFeed: feedPicks,
};

if (wantJson) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
console.log(`# Your delta  (${version || 'Claude Code'}; ${plugins.length} plugins, ${skills.length} skills${codexCfg ? ', Codex' : ''}; analysed ${historyEntries} history entries locally)\n`);
console.log('## Change in your setup');
for (const a of result.forYou) console.log(`- [${a.kind.toUpperCase()}] ${a.title}\n    ${a.command}\n    ${a.why}`);
console.log('\n## New this week');
for (const f of result.fromFeed) console.log(`- [${f.kind.toUpperCase()}] ${f.title}${f.command ? `\n    ${f.command}` : ''}\n    ${f.why}  ${f.url || ''}`);
