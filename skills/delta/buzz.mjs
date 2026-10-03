// Community buzz: turns a saved /last30days research file (Reddit, X, YouTube, TikTok, Instagram, HN...) into a ranked list of the
// plugins/skills people are actually naming, and resolves unknown names to GitHub repos so they can join the index.
// Delta never calls last30days' APIs itself: it only READS the markdown file that /last30days already saved, so it needs no keys.
// Usage: node buzz.mjs --ingest <raw.md> [--index <community.json>] [--seeds <seeds.json>]    (writes ~/.claude/delta-cache/buzz.json)
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
export const BUZZ_FILE = path.join(home, '.claude', 'delta-cache', 'buzz.json');
const SAFE = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
import { defang } from './safe.mjs';
const clean = (s, n = 160) => defang(s, n);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const STOP = new Set(['claude', 'code', 'codex', 'skills', 'skill', 'plugins', 'plugin', 'agents', 'agent', 'mcp', 'github', 'anthropic', 'openai', 'cursor', 'review', 'planning', 'memory', 'context', 'free', 'open', 'source', 'first', 'second', 'third', 'fourth', 'fifth', 'this', 'that', 'comment', 'stop', 'using', 'dont', 'don', 'tools', 'tool', 'install', 'installed', 'subagents', 'hooks', 'model', 'models', 'chat', 'gemini', 'gpt', 'copilot', 'windsurf', 'vscode', 'docker', 'python', 'node', 'react', 'learn', 'security', 'connect', 'workflow', 'design', 'research', 'writing', 'browser', 'testing', 'deploy', 'planning', 'docs', 'simple', 'basic', 'starter', 'helper', 'utils', 'open-source', 'opensource', 'automation', 'productivity', 'development', 'commands', 'prompts', 'template', 'templates']);

// Split the saved research into evidence items: source tag, engagement and text.
function parseItems(md) {
  const items = []; const re = /^\s*\d+\. \[(reddit|x|youtube|tiktok|instagram|hackernews|github|bluesky|threads|web)\] ([^\n]*)\n([\s\S]*?)(?=^\s*\d+\. \[|^### |^## |\Z)/gim;
  for (const m of md.matchAll(re)) {
    const block = `${m[2]}\n${m[3]}`;
    const views = Number((/\[([\d,]+)views/.exec(block)?.[1] || '0').replace(/,/g, ''));
    const likes = Number((/([\d,]+)likes/.exec(block)?.[1] || '0').replace(/,/g, ''));
    const pts = Number((/([\d,]+)pts/.exec(block)?.[1] || '0').replace(/,/g, ''));
    items.push({ source: m[1].toLowerCase(), text: block, reach: views || likes * 20 || pts * 30 || 50 });
  }
  return items;
}

// Names people say out loud: numbered lists, "First is X", "it's called X", GitHub links, and anything already in the index.
function candidates(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:[1-9]️?⃣|\b[1-9][.)])\s*([A-Za-z][A-Za-z0-9 .+_-]{2,28}?)\s*(?:[:—–-]|\n|$)/g)) out.add(m[1].trim());
  for (const m of text.matchAll(/\b(?:First|Second|Third|Fourth|Fifth)(?: one)?(?: is|:)\s+([A-Z][A-Za-z0-9._-]+(?: [A-Z][A-Za-z0-9._-]+)?)/g)) out.add(m[1].trim());
  for (const m of text.matchAll(/\b(?:It's called|it is called|called)\s+([A-Z][A-Za-z0-9._-]+(?: [A-Z][A-Za-z0-9._-]+){0,2})/g)) out.add(m[1].trim());
  return [...out].filter((n) => n.length >= 3 && n.length <= 30 && !STOP.has(norm(n)) && norm(n).length >= 4);
}
const repoLinks = (text) => [...text.matchAll(/github\.com\/([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})/g)].map((m) => m[1].replace(/\.git$/, '')).filter((r) => SAFE_REPO.test(r));

function token() { if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN; try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 8000 }).trim(); } catch { return ''; } }
export async function resolveRepo(name, tok) {
  const h = { 'User-Agent': 'delta', Accept: 'application/vnd.github+json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
  try {
    const j = await (await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${name} in:name`)}&sort=stars&per_page=8`, { headers: h, signal: AbortSignal.timeout(15000) })).json();
    const n = norm(name);
    const pool = (j.items || []).filter((r) => norm(r.name) === n && !r.archived && !r.fork && SAFE_REPO.test(r.full_name)).sort((x, y) => y.stargazers_count - x.stargazers_count);
    // Anyone can create a lookalike repo (and buy stars), so a name alone is only trusted when one exact-name repo clearly dominates.
    if (pool.length > 1 && pool[0].stargazers_count < 10 * pool[1].stargazers_count) return null;
    const hit = pool.find((r) => r.stargazers_count >= 500 && (r.forks_count || 0) >= 10 && (Date.now() - new Date(r.created_at).getTime()) / 864e5 >= 45
      && /claude|agent|skill|plugin|mcp|codex|llm|context|token|prompt/i.test(`${r.description || ''} ${(r.topics || []).join(' ')}`));
    return hit ? { unverified: true, runnerUp: (j.items || []).filter((r) => r.full_name !== hit.full_name && norm(r.name).includes(n)).slice(0, 2).map((r) => `${r.full_name} (${r.stargazers_count})`), repo: hit.full_name, stars: hit.stargazers_count, license: hit.license?.spdx_id || 'none', pushed: hit.pushed_at?.slice(0, 10), description: clean(hit.description) } : null;
  } catch { return null; }
}

export async function ingest(rawPath, { indexPath, resolve = true } = {}) {
  const md = await readFile(rawPath, 'utf8');
  const index = JSON.parse(await readFile(indexPath || path.join(HERE, '..', '..', 'docs', 'community.json'), 'utf8').catch(() => '{"items":[]}'));
  const known = new Map(); // normalized name -> {repo, plugin}
  for (const it of index.items) {
    if (!SAFE_REPO.test(it.repo || '') || it.aggregator) continue;
    for (const n of [it.plugin, it.repo.split('/')[1]]) if (n && norm(n).length >= 5 && !STOP.has(norm(n)) && !known.has(norm(n))) known.set(norm(n), { repo: it.repo, plugin: it.plugin, re: new RegExp(`(^|[^a-z0-9])${n.toLowerCase().split(/[-_.s]+/).filter(Boolean).map((t) => t.replace(/[^a-z0-9]/g, '')).join('[-_. ]?')}($|[^a-z0-9])`, 'i') });
  }
  const mentions = new Map();
  const bump = (key, display, item, repo, viaLink = false) => {
    const m = mentions.get(key) || { name: clean(display, 40), repo: repo || null, viaLink: false, count: 0, reach: 0, sources: {}, quotes: [] };
    m.count++; m.reach += item.reach; m.sources[item.source] = (m.sources[item.source] || 0) + 1;
    if (!m.repo && repo) m.repo = repo;
    if (viaLink) m.viaLink = true;
    if (m.quotes.length < 2) { const i = item.text.toLowerCase().indexOf(display.toLowerCase()); m.quotes.push(clean(item.text.slice(Math.max(0, i - 30), i + 150), 170)); }
    mentions.set(key, m);
  };
  for (const item of parseItems(md)) {
    const seen = new Set(); const low = norm(item.text);
    for (const [k, v] of known) if (!seen.has(k) && v.re.test(item.text)) { seen.add(k); bump(k, v.plugin || v.repo.split('/')[1], item, v.repo); }
    for (const c of candidates(item.text)) { const k = norm(c); if (!seen.has(k)) { seen.add(k); bump(k, c, item, known.get(k)?.repo); } }
    for (const r of repoLinks(item.text)) { const k = norm(r.split('/')[1]); if (!seen.has(k) && !STOP.has(k)) { seen.add(k); bump(k, r.split('/')[1], item, r, true); } }
  }
  // Keep names heard in 2+ items or with real reach; resolve the unknown ones to repos.
  const ranked = [...mentions.values()].filter((m) => m.count >= 2 || m.reach >= 5000).sort((a, b) => b.reach - a.reach).slice(0, 40);
  const tok = resolve ? token() : '';
  for (const m of ranked) {
    if (m.repo || !resolve) { m.indexed = !!m.repo && index.items.some((i) => i.repo === m.repo); continue; }
    const r = await resolveRepo(m.name, tok); if (r) { m.repo = r.repo; m.resolved = r; } m.indexed = false;
  }
  const result = { generated: new Date().toISOString(), source: path.basename(rawPath), items: parseItems(md).length,
    mentions: ranked.filter((m) => m.repo || m.count >= 2).map((m) => ({ name: m.name, viaLink: !!m.viaLink, repo: m.repo, indexed: !!m.indexed, count: m.count, reach: m.reach, sources: m.sources, quotes: m.quotes, resolved: m.resolved || null })) };
  await mkdir(path.dirname(BUZZ_FILE), { recursive: true }); await writeFile(BUZZ_FILE, JSON.stringify(result, null, 1));
  return result;
}

// Load cached buzz (validated shape). Returns null when absent or older than `maxDays`.
export async function loadBuzz(maxDays = 10) {
  try {
    const j = JSON.parse(await readFile(BUZZ_FILE, 'utf8'));
    if (Date.now() - new Date(j.generated).getTime() > maxDays * 864e5 || !Array.isArray(j.mentions)) return null;
    j.mentions = j.mentions.filter((m) => m && typeof m.name === 'string' && (m.repo === null || SAFE_REPO.test(m.repo || '')) && Number.isFinite(m.count) && Number.isFinite(m.reach))
      .map((m) => ({ ...m, name: clean(m.name, 40), quotes: (m.quotes || []).map((q) => clean(q, 170)).slice(0, 2) }));
    return j;
  } catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2); const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  let raw = val('--ingest');
  if (!raw) { // default: newest saved last30days brief on plugins/skills
    const dir = path.join(home, 'Documents', 'Last30Days'); const fs = (await readdir(dir).catch(() => [])).filter((f) => /raw-v3\.md$/.test(f) && /plugin|skill|mcp/i.test(f));
    const withTime = await Promise.all(fs.map(async (f) => [f, (await stat(path.join(dir, f))).mtimeMs])); raw = withTime.sort((x, y) => y[1] - x[1])[0]?.[0]; if (raw) raw = path.join(dir, raw);
  }
  if (!raw) { console.error('No /last30days file found. Run /last30days on "best Claude Code plugins and skills" first.'); process.exit(2); }
  const r = await ingest(raw, { indexPath: val('--index') });
  console.log(`ingested ${path.basename(raw)}: ${r.items} evidence items -> ${r.mentions.length} named tools`);
  for (const m of r.mentions.slice(0, 20)) console.log(`  ${String(m.count).padStart(2)}x reach ${String(m.reach).padStart(8)}  ${m.name.padEnd(26)} ${m.repo || '(unresolved)'}${m.indexed ? '' : m.repo ? '  [NOT IN INDEX]' : ''}  ${Object.keys(m.sources).join(',')}`);
  const seeds = val('--seeds');
  if (seeds) { const withGuesses = a.includes('--seeds-include-guesses');
    const list = [...new Set(r.mentions.filter((m) => m.repo && !m.indexed && (m.viaLink || withGuesses)).map((m) => m.repo))].slice(0, 25); await writeFile(seeds, JSON.stringify(list, null, 1)); console.log(`wrote ${list.length} seed repos to ${seeds}`); }
}
