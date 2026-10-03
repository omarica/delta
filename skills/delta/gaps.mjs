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
const communitySrc = /^https?:/.test(feedSrc) ? feedSrc.replace(/feed.json$/, 'community.json') : path.join(path.dirname(feedSrc), 'community.json');

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

// --- setup assessment (stack + real usage vs. the live marketplace) ---
let assessment = null;
if (!args.includes('--no-assess')) {
  try { const { assess } = await import('./assess.mjs'); assessment = await assess({ HERE, plugins, enabledMap: settings.enabledPlugins || {}, skills, slash }); }
  catch (e) { console.error(`[assess skipped] ${e.message}`); }
}

// Codex: works from files on disk (config.toml, skills, a bounded sample of recent sessions); no CLI or keys needed.
let codex = null;
if (!args.includes('--no-codex')) {
  try { const { assessCodex } = await import('./codex.mjs'); codex = await assessCodex({ budgetMB: Number(argVal('--codex-mb')) || 150 }); }
  catch (e) { console.error(`[codex skipped] ${e.message}`); }
}

// Community buzz (from a saved /last30days run) and the popular/rising landscape; both are local reads, no keys.
let buzz = null, landscapeData = null;
if (assessment && !args.includes('--no-community')) {
  try { const { loadBuzz } = await import('./buzz.mjs'); buzz = await loadBuzz(); } catch (e) { console.error(`[buzz skipped] ${e.message}`); }
  if (!args.includes('--no-landscape')) {
    try { const { landscape } = await import('./community.mjs'); landscapeData = await landscape({ HERE, src: communitySrc, stackTags: assessment.stackTags, installedNames: assessment.installedNames, displayNames: assessment.installedPlugins, buzz, perCategory: args.includes('--landscape-all') ? 5 : 2 }); }
    catch (e) { console.error(`[landscape skipped] ${e.message}`); }
  }
}

let community = null;
if (assessment && !args.includes('--no-community')) {
  try { const { matchCommunity } = await import('./community.mjs'); community = await matchCommunity({ HERE, src: communitySrc, stackTags: assessment.stackTags, installedNames: assessment.installedNames, includeLow: args.includes('--community-all') }); }
  catch (e) { console.error(`[community skipped] ${e.message}`); }
}

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
  forYou: actions.slice(0, 5), assessment, codex, community, landscape: landscapeData, buzz, fromFeed: feedPicks,
};

if (wantJson) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
console.log(`# Your delta  (${version || 'Claude Code'}; ${plugins.length} plugins, ${skills.length} skills${codexCfg ? ', Codex' : ''}; analysed ${historyEntries} history entries locally)\n`);
if (codex) {
  console.log(`## Codex: ~${codex.totalTokens.toLocaleString()} tokens of skill list load in EVERY Codex session (${codex.skillCount} skills from ${codex.enabledPlugins.length} enabled plugins + your skill folders)`);
  if (codex.usage) console.log(`Usage is a SAMPLE: your newest ${codex.usage.scanned} of ${codex.usage.totalSessions} sessions (${codex.usage.megabytes} MB), counting only real skill reads. Estimate calibrated against a real injected skill list; a skill you use rarely may show 0 reads.`);
  for (const s of codex.unusedSources) {
    console.log(`- [${s.key ? 'DISABLE' : 'REVIEW'}] ${s.source.replace(/^plugin:/, '')}: ~${s.tokens.toLocaleString()} tok/session (${s.skills} skills), 0 reads in the sample`);
    if (s.key) console.log(`    ~/.codex/config.toml:  [plugins."${s.key}"]  enabled = false      (or: codex plugin remove ${s.key})`);
    else console.log(`    These live in your own skill folder; remove or move the ones you don't use.`);
  }
  const used = codex.sources.filter((s) => s.reads > 0).map((s) => `${s.source.replace(/^plugin:/, '')} (${s.reads})`);
  if (used.length) console.log(`- Kept (read in the sample): ${used.join(', ')}`);
  for (const a of codex.agents.filter((x) => x.heavy)) console.log(`- [TRIM] ${a.label} is ~${a.tokens.toLocaleString()} tokens, loaded every session.`);
  console.log('');
}
if (assessment?.ledger && assessment.ledger.totalTokens > 0) {
  const L = assessment.ledger;
  const acts = L.rows.filter((r) => r.action !== 'keep');
  console.log(`## Token ledger: ${L.totalTokens.toLocaleString()} tokens of plugin context load at the start of EVERY session`);
  console.log(`Applying the changes below would cut that to ~${L.afterTokens.toLocaleString()} (-${L.potentialSavings.toLocaleString()}, ${Math.round(100 * L.potentialSavings / Math.max(1, L.totalTokens))}%). Based on ${L.sessions} recorded sessions; a plugin you use rarely may look unused.${L.estimated ? ' Token costs are ESTIMATED from plugin files because the claude CLI was not available.' : ''}`);
  for (const r of acts) {
    console.log(`- [${r.action.toUpperCase()}] ${r.plugin}: ${r.tokens.toLocaleString()} tok/session, saves ~${r.savings.toLocaleString()} (${r.note})`);
    for (const c of r.commands) console.log(`    ${c}`);
  }
  const kept = L.rows.filter((r) => r.action === 'keep' && r.tokens >= 400).map((r) => `${r.plugin} (${r.tokens})`);
  if (kept.length) console.log(`- Kept as is: ${kept.join(', ')}`);
  const cm = (assessment.claudeMd || []).filter((c) => c.heavy);
  for (const c of cm) console.log(`- [TRIM] ${c.label} CLAUDE.md is ~${c.tokens.toLocaleString()} tokens, loaded every session there. Move rarely-needed rules into path-scoped .claude/rules/*.md files or delete stale ones.`);
  console.log('');
}
if (assessment) {
  console.log(`## Your setup (stack: ${assessment.stack.join(', ') || 'unknown'}; ${assessment.projects} projects, ${assessment.sessions} sessions since ${assessment.since})`);
  console.log('\n## Install (fits your stack)');
  if (!assessment.install.length) console.log('- Nothing missing for your stack.');
  for (const i of assessment.install) console.log(`- ${i.plugin}: ${i.why}\n    ${i.command}\n    Why you: ${i.evidence}`);
  // The token ledger above supersedes the older prune list; only fall back to it when the ledger is unavailable.
  if (!assessment.ledger) {
    console.log('\n## Prune (installed, never used)');
    if (!assessment.prune.length) console.log('- Everything installed has been used.');
    for (const i of assessment.prune) console.log(`- ${i.plugin}: ${i.why}\n    ${i.command}`);
    if (assessment.harmless?.length) console.log(`- (unused but ~free, keep or remove as you like: ${assessment.harmless.join(', ')})`);
    if (assessment.unmeasurable?.length) console.log(`- (not measurable, run through hooks: ${assessment.unmeasurable.join(', ')})`);
  } else if (assessment.harmless?.length) {
    console.log(`\n(Unused but ~free, no action needed: ${assessment.harmless.join(', ')})`);
  }
  console.log('');
}
if (community) {
  console.log('## Community picks (GitHub, not vetted by Anthropic)');
  if (!community.picks.length) console.log('- No high-confidence pick for your setup today.');
  if (community.hiddenLowConfidence) console.log(`  (${community.hiddenLowConfidence} lower-confidence keyword matches hidden; run with --community-all to see them)`);
  for (const c of community.picks) {
    const flags = [c.risk.hooks && 'runs hooks', c.risk.mcp && 'starts an MCP server', c.risk.scripts && 'has install scripts'].filter(Boolean);
    console.log(`- ${c.plugin} (${c.repo})${c.confidence === 'low' ? ' [LOW CONFIDENCE]' : ''}: ${c.description}`);
    console.log(`    Why you: ${c.why}`);
    console.log(`    Trust ${c.trust}/100 | ${c.stars.toLocaleString()} stars | ${/NOASSERTION|none/.test(c.license) ? 'license unclear' : c.license} | pushed ${c.pushedDaysAgo}d ago | repo ${c.ageDays}d old${c.isNew ? ' | NEW this week' : ''}${c.starsDelta ? ` | +${c.starsDelta} stars/wk` : ''}`);
    const baseTok = assessment?.ledger?.totalTokens;
    console.log(`    Context cost: ${c.estTokens === null ? 'unknown (run `claude plugin details` after adding its marketplace)' : `~${c.estTokens.toLocaleString()} tokens/session${baseTok ? ` (+${Math.round(100 * c.estTokens / baseTok)}% on your current ${baseTok.toLocaleString()})` : ''}${c.risk.hooks || c.risk.mcp ? ', plus whatever its hooks/MCP inject' : ''}`}`);
    console.log(`    Review first: ${flags.length ? flags.join(', ') : 'none detected from file names, so still read its hooks and .mcp.json'}  ${c.url}`);
    for (const i of c.installs) console.log(`    ${i}`);
  }
  console.log('');
}
if (buzz?.mentions?.length) {
  console.log(`## Community buzz (what people are naming right now, from your saved /last30days run of ${String(buzz.generated).slice(0, 10)})`);
  for (const m of buzz.mentions.slice(0, 8)) {
    const srcs = Object.keys(m.sources || {}).join('/');
    console.log(`- ${m.name}: ${m.count}x across ${srcs}, reach ~${Math.round(m.reach / 1000).toLocaleString()}K${m.repo ? `  ${m.repo}` : ''}${m.indexed ? '' : m.repo ? '  [not in the index yet' + (m.resolved?.unverified ? '; repo guessed from the name, verify the owner' : '') + ']' : '  [could not resolve to a repo]'}`);
  }
  console.log('');
}
if (landscapeData) {
  const V = { CONSIDER: 'CONSIDER', WATCH: 'WATCH', SKIP: 'SKIP', HAVE: 'HAVE', FYI: 'FYI' };
  const line = (e) => `  - ${e.plugin} (${e.inMarketplace ? 'in ' + e.repo + ' marketplace' : e.repo}) ${e.stars === null ? '' : Math.round(e.stars / 1000) + 'K stars, '}trust ${e.trust}, ${e.estTokens === null ? 'cost unknown' : '~' + e.estTokens.toLocaleString() + ' tok'}${e.risk.hooks || e.risk.mcp ? ', hooks/MCP' : ''}${e.buzz ? `, buzz ${e.buzz.count}x` : ''}  [${V[e.verdict]}: ${e.why}]`;
  console.log(`## Community landscape: popular per category and rising, with how each fits you (${landscapeData.repos} repos indexed)`);
  for (const c of landscapeData.categories.filter((x) => x.top.length)) {
    console.log(`- ${c.label}${c.youHave.length ? ` (you have: ${c.youHave.join(', ')})` : ' (you have nothing here)'}`);
    for (const e of c.top) console.log(line(e));
  }
  if (landscapeData.rising.length) {
    console.log('- Rising (new in the last 120 days, fastest growing; hype is common here, so treat as leads)');
    for (const e of landscapeData.rising) console.log(line(e) + `  +${e.starsPerDay} stars/day`);
  }
  console.log('');
}
console.log('## Change in your setup');
for (const a of result.forYou) console.log(`- [${a.kind.toUpperCase()}] ${a.title}\n    ${a.command}\n    ${a.why}`);
console.log('\n## New this week');
for (const f of result.fromFeed) console.log(`- [${f.kind.toUpperCase()}] ${f.title}${f.command ? `\n    ${f.command}` : ''}\n    ${f.why}  ${f.url || ''}`);
if (args.includes('--more') && feed.more?.length) {
  console.log('\n## More this week');
  for (const f of feed.more) console.log(`- [${f.kind.toUpperCase()}] ${f.title}  ${f.url || ''}`);
}
