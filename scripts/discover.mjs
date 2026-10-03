// Finds community Claude Code plugins / skills on GitHub, validates them, scores trust, tracks growth.
// Writes docs/community.json. Free: uses only the GitHub API (GITHUB_TOKEN recommended).
// Usage: node scripts/discover.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(await readFile(path.join(ROOT, 'skills/delta/stack.json'), 'utf8'));
const C = cfg.community;
const headers = { 'User-Agent': 'delta', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const days = (iso) => Math.max(0, (now - new Date(iso).getTime()) / 864e5);
// Names and descriptions come from third-party repos and end up in commands/terminal output: never trust them.
const SAFE = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const clean = (s, n = 220) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

async function gh(url) {
  const r = await fetch(url, { headers });
  if (r.status === 403 || r.status === 429) { await sleep(20000); const r2 = await fetch(url, { headers }); if (!r2.ok) throw new Error(`${r2.status} ${url}`); return r2.json(); }
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// 1. Discovery. GitHub search returns at most 1000 results and allows 30 requests/min, so page deeper and pace the calls.
const iso = (msAgo) => new Date(now - msAgo).toISOString().slice(0, 10);
const since = iso(C.pushedWithinDays * 864e5);
const found = new Map();
async function search(q, pages = 5) {
  for (let page = 1; page <= pages; page++) {
    try {
      const j = await gh(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=50&page=${page}`);
      for (const r of j.items) if (!found.has(r.full_name)) { r.__origin = 'topic'; found.set(r.full_name, r); }
      if (j.items.length < 50) break;
    } catch (e) { console.warn(`[search skip] ${q} p${page}: ${e.message}`); break; }
    await sleep(2200);
  }
}
// 1a. Popular: by topic.
for (const topic of C.topics) await search(`topic:${topic} pushed:>${since} stars:>=${C.minStars}`);
// 1b. Rising: recently created repos that already have real traction (no star history needed).
for (const topic of C.topics.slice(0, 5)) await search(`topic:${topic} created:>${iso(C.risingWithinDays * 864e5)} stars:>=${C.risingMinStars}`, 2);
console.log(`topic search: ${found.size} candidate repos`);
// 1c. The community's own curated "awesome" lists are where the long tail lives: harvest the repos they link to.
const listRepos = [];
try {
  const j = await gh(`https://api.github.com/search/repositories?q=${encodeURIComponent(`awesome claude in:name,description stars:>=300 pushed:>${iso(90 * 864e5)}`)}&sort=stars&per_page=20`);
  for (const r of j.items) if (/claude|skill|agent|mcp/i.test(`${r.name} ${r.description || ''}`) && SAFE_REPO.test(r.full_name)) listRepos.push(r);
} catch (e) { console.warn(`[lists skip] ${e.message}`); }
const seeds = new Set(); const buzzSeeds = new Set();
try { for (const r of JSON.parse(await readFile(path.join(ROOT, 'docs/seeds.json'), 'utf8'))) if (typeof r === 'string' && SAFE_REPO.test(r) && !found.has(r)) { seeds.add(r); buzzSeeds.add(r); } } catch {} // repos people are naming (from /last30days via buzz.mjs); still validated and trust-scored like any other
for (const l of listRepos.slice(0, 10)) {
  try {
    const md = await (await fetch(`https://raw.githubusercontent.com/${l.full_name}/${l.default_branch}/README.md`)).text();
    for (const m of md.matchAll(/https:\/\/github\.com\/([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})(?=[/)\s#"'\]]|$)/g)) {
      const repo = m[1].replace(/\.git$/, '');
      if (SAFE_REPO.test(repo) && !found.has(repo) && !listRepos.some((x) => x.full_name === repo)) seeds.add(repo);
    }
  } catch {}
}
console.log(`awesome lists: ${listRepos.length} lists -> ${seeds.size} linked repos to check`);
const seedList = [...seeds].slice(0, C.maxSeeds); let si = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (si < seedList.length) {
    const name = seedList[si++];
    try { const r = await gh(`https://api.github.com/repos/${name}`); if (r.stargazers_count >= C.minStars && days(r.pushed_at) <= C.pushedWithinDays * 2 && !found.has(r.full_name)) { r.__origin = buzzSeeds.has(name) ? 'buzz' : 'list'; found.set(r.full_name, r); } } catch {}
  }
}));
console.log(`found ${found.size} candidate repos in total`);

// 2. Validate each repo by its file tree; pull marketplace details; compute trust.
const OK_LICENSE = /^(MIT|Apache-2\.0|BSD|ISC|CC0|MPL|Unlicense|GPL|LGPL|AGPL)/i;
async function inspect(r) {
  if (r.archived || r.fork || r.disabled || !SAFE_REPO.test(r.full_name)) return [];
  let tree; try { tree = (await gh(`https://api.github.com/repos/${r.full_name}/git/trees/${r.default_branch}?recursive=1`)).tree.map((t) => t.path); } catch { return []; }
  const has = (re) => tree.some((p) => re.test(p));
  // A real plugin/skill repo: marketplace or plugin manifest at the root or under plugins/*, or a real set of skills.
  const hasMarket = tree.includes('.claude-plugin/marketplace.json');
  const hasPlugin = tree.includes('.claude-plugin/plugin.json') || has(/^plugins\/[^/]+\/\.claude-plugin\/plugin\.json$/);
  const skillCount = tree.filter((p) => /(^|\/)SKILL\.md$/.test(p)).length;
  const aboutAgents = /claude|agent|skill|plugin|mcp|codex|copilot|cursor|llm|prompt/i.test(`${r.name} ${r.description || ''} ${(r.topics || []).join(' ')}`);
  if (!aboutAgents) return [];
  const rootSkills = tree.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).length;
  const skillish = /skill/i.test(`${r.name} ${r.description || ''} ${(r.topics || []).join(' ')}`);
  if (!hasMarket && !hasPlugin && !(rootSkills >= 3 && skillish)) return [];
  const kind = hasMarket ? 'marketplace' : hasPlugin ? 'plugin' : 'skills';
  const risk = {
    // Err on the side of flagging: a plugin's hooks/MCP config can live at any depth (plugin/, plugins/x/, packages/x/ ...).
    hooks: has(/(^|\/)hooks\/hooks\.json$/) || has(/(^|\/)\.claude-plugin\/hooks\.json$/) || has(/^([^/]+\/){0,2}hooks\/[^/]+\.(sh|js|mjs|cjs|py|ts|json)$/) && !has(/^src\/hooks\//),
    mcp: has(/(^|\/)\.mcp\.json$/),
    scripts: has(/(^|\/)(install|setup|postinstall)\.(sh|ps1|js|mjs)$/),
  };
  // Trust: popularity (log), recency, license, repo age, fork ratio; penalty for a sudden star spike on a brand-new repo.
  const age = days(r.created_at), pushed = days(r.pushed_at), spdx = r.license?.spdx_id || '';
  let trust = Math.min(35, Math.log10(r.stargazers_count + 1) * 9);
  trust += pushed <= 7 ? 15 : pushed <= 21 ? 10 : 5;
  trust += OK_LICENSE.test(spdx) ? 12 : spdx ? 4 : 0;
  trust += age >= 180 ? 15 : age >= 60 ? 10 : age >= 30 ? 5 : 0;
  trust += r.forks_count / Math.max(1, r.stargazers_count) >= 0.04 ? 8 : 3;
  if (age < 21 && r.stargazers_count > 2000) trust -= 20;
  if (r.__origin && r.__origin !== 'topic' && (age < 60 || r.stargazers_count < 1000)) trust -= 15; // listed on an awesome list / named in a post is not independent proof
  trust = Math.max(0, Math.round(Math.min(100, trust)));
  const base = { repo: r.full_name, url: r.html_url, stars: r.stargazers_count, forks: r.forks_count, license: spdx || 'none',
    pushedDaysAgo: Math.round(pushed), ageDays: Math.round(age), kind, risk, origin: r.__origin || 'topic', trust };
  const classify = (text) => ({
    tags: Object.entries(cfg.communityTags).filter(([, re]) => new RegExp(re, 'i').test(text)).map(([t]) => t),
    capabilities: Object.entries(cfg.capabilities).filter(([, c]) => new RegExp(c.match, 'i').test(text)).map(([t]) => t),
  });
  // Estimated always-on cost: every skill/agent description is loaded each session (~110 tokens each, calibrated on installed plugins:
  // claude-seo 43 components = 4873 tok, vercel 37 skills = 4219 tok), commands are cheaper. Unknown for plugins pulled from other repos.
  const estimate = (source) => {
    if (typeof source !== 'string') return { components: null, estTokens: null };
    const prefix = source ? source.replace(/^\.\//, '').replace(/\/$/, '') : '';
    const under = (re) => tree.filter((p) => (prefix ? p.startsWith(prefix + '/') : true) && re.test(prefix ? p.slice(prefix.length + 1) : p)).length;
    const skills = under(/(^|\/)SKILL\.md$/), agents = under(/^agents\/[^/]+\.md$/), commands = under(/^commands\/[^/]+\.md$/);
    return { components: { skills, agents, commands }, estTokens: Math.round(110 * (skills + agents) + 50 * commands) };
  };
  // Marketplaces are expanded into individual plugins so matching is precise (a Python plugin, not "a repo that has everything").
  if (hasMarket) {
    try {
      const m = await (await fetch(`https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/.claude-plugin/marketplace.json`)).json();
      const ps = (m.plugins || []).filter((p) => typeof p?.name === 'string' && SAFE.test(p.name)).slice(0, 200); // drop entries with unsafe names
      const aggregator = ps.length > 8;
      if (ps.length && typeof m.name === 'string' && SAFE.test(m.name)) return ps.map((p) => ({
        ...base, trust: aggregator ? Math.max(0, base.trust - 15) : base.trust, aggregator, id: `${r.full_name}#${p.name}`, plugin: p.name, marketplace: m.name, category: clean(p.category, 40), pluginCount: ps.length,
        description: clean(p.description || r.description),
        // Single-plugin marketplaces: the whole repo is the plugin, so count it all even when `source` is not a plain path.
        ...(estimate(p.source).estTokens === null && ps.length === 1 ? estimate('') : estimate(p.source)),
        installs: [`claude plugin marketplace add ${r.full_name}`, `claude plugin install ${p.name}@${m.name}`],
        ...classify(`${p.name} ${p.description || ''} ${(p.keywords || []).join(' ')} ${p.category || ''}`.toLowerCase()),
      }));
    } catch {}
  }
  const text = `${r.name} ${r.description || ''} ${(r.topics || []).join(' ')}`.toLowerCase();
  if (!SAFE.test(r.name)) return [];
  return [{ ...base, id: r.full_name, plugin: r.name, marketplace: null, category: '', pluginCount: 1, skillCount, description: clean(r.description), ...estimate(''),
    installs: kind === 'plugin' ? [`git clone https://github.com/${r.full_name}   # then run: claude --plugin-dir <path>`]
      : [`Copy the skill folder(s) you want from https://github.com/${r.full_name} into ~/.claude/skills/`], ...classify(text) }];
}
const list = [...found.values()].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, C.maxItems);
const results = []; let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const r = list[i++]; const x = await inspect(r); results.push(...x); } }));

// 3. Growth: compare with the last ~8 days of star snapshots kept in docs/community-history.json.
const histPath = path.join(ROOT, 'docs/community-history.json');
let hist = {}; try { hist = JSON.parse(await readFile(histPath, 'utf8')); } catch {}
const today = new Date().toISOString().slice(0, 10);
const oldestKey = Object.keys(hist).sort().find((k) => (now - new Date(k).getTime()) / 864e5 <= 8 && k !== today);
for (const x of results) {
  const prev = oldestKey ? hist[oldestKey][x.repo] : undefined;
  x.starsDelta = prev === undefined ? null : x.stars - prev;
  x.isNew = oldestKey ? prev === undefined : false;
}
hist[today] = Object.fromEntries(results.map((x) => [x.repo, x.stars]));
for (const k of Object.keys(hist)) if ((now - new Date(k).getTime()) / 864e5 > 10) delete hist[k];
results.sort((a, b) => b.trust - a.trust || b.stars - a.stars);
const repos = new Set(results.map((x) => x.repo));
await writeFile(path.join(ROOT, 'docs/community.json'), JSON.stringify({ generated: new Date().toISOString(), count: results.length, items: results }));
await writeFile(histPath, JSON.stringify(hist));
console.log(`validated ${repos.size} repos -> ${results.length} installable plugins/skill-sets`);
for (const x of results.slice(0, 12)) console.log(`  trust ${x.trust} | ${x.stars}★ | ${x.kind} | ${x.id} | ${x.tags.join(',')} | ${x.capabilities.join(',')}${x.risk.hooks ? ' [hooks]' : ''}${x.risk.mcp ? ' [mcp]' : ''}`);
