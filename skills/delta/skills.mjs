// Deep skill search: finds the skills worth installing FOR YOUR STACK, using real usage data, and installs them safely.
//   node skills.mjs                      search (uses a 24h cache of the registry harvest)
//   node skills.mjs --refresh --top 40   re-harvest, show more
//   node skills.mjs --install owner/repo/skill            dry run: stage, scan, show the plan
//   node skills.mjs --install owner/repo/skill --confirm  actually install (after YOU read the report)
//   flags: --json  --as <new-name> (single install)  --roots claude,agents
// Pipeline: profile-driven queries -> skills.sh harvest (install counts) -> GitHub reputation + install-farm detection
//           -> relevance scoring -> hydrate SKILL.md -> safety scan. No API keys are used (optional GitHub login only raises rate limits).
import { readFile, writeFile, mkdir, readdir, rm, cp, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { isInstructionLike, defang, SAFE, SAFE_REPO } from './safe.mjs';
import { CLUSTERS, DEP_STOP, VENDOR, PRODUCT_VENDORS, OFF_SOURCE, OFF_SKILL, MIRROR } from './skills.config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const CACHE = path.join(home, '.claude', 'delta-cache');
const ROOTS = { claude: path.join(home, '.claude', 'skills'), agents: path.join(home, '.agents', 'skills') };
const BUILTIN = new Set(['security-review', 'review', 'init', 'compact', 'clear', 'help', 'config', 'model', 'mcp', 'plugin', 'agents', 'doctor', 'memory', 'permissions', 'usage', 'cost', 'status', 'login', 'logout', 'resume', 'rewind', 'fork', 'loop', 'schedule', 'simplify', 'run', 'delta', 'ultrareview', 'code-review', 'improve', 'goal']);

// ---------- pure, testable helpers ----------
export const validSkillId = (id) => /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,100}\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,100}\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,100}$/.test(String(id));
export const safeRelPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 240 && !p.startsWith('/') && !/[\\:\x00-\x1f]/.test(p) && !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.');

// Install-farm / inflation detection. A vendor's own CLI may install its skills (huge installs vs stars is normal); an anonymous account is not.
export function integrity({ installs, source, meta, pack }) {
  const vendor = VENDOR.test(`${source}/`); const stars = meta?.stars ?? 0; const reasons = []; let farm = 0;
  const ratio = stars ? installs / stars : Infinity;
  if (!vendor && ratio > 2000 && stars < 1000) { farm = 45; reasons.push(`install farm? ${installs.toLocaleString()} installs vs ${stars} stars`); }
  else if (!vendor && ratio > 400 && stars < 3000) { farm = 15; reasons.push(`installs far above stars (${Math.round(ratio)}x)`); }
  const uniform = pack?.uniform ?? 0;
  if (uniform >= 0.5) reasons.push('whole-pack installs (not individually chosen)');
  return { vendor, farm, uniform, reasons };
}
// Does this skill target a library the user actually depends on?
// A match must cover ALL significant words of the package name (generic words like "test", "core", "components" are ignored), so
// "@upstash/redis" matches upstash-redis-js, but "@vercel/analytics" does not match every Vercel skill and "@remotion/google-fonts" does not match Google's skills.
const GENERIC_TOK = new Set(['test', 'core', 'types', 'util', 'utils', 'client', 'server', 'sdk', 'components', 'node', 'dom', 'common', 'shared', 'plugin', 'plugins', 'cli', 'js']);
const ALIAS = { next: ['nextjs'], nextjs: ['next'] };
const words = (s) => String(s).toLowerCase().replace(/^@/, '').split(/[\/_.\-\s]+/).filter(Boolean);
export function sigTokens(dep) {
  let t = words(dep).filter((w) => w.length >= 3 && !GENERIC_TOK.has(w));
  if (t.length > 1) t = t.filter((w) => w !== 'react'); // "react" alone is meaningful; inside "@x/react-y" it only says which flavour
  return [...new Set(t)].filter((w) => w.length >= 4 || t.length > 1);
}
export function depMatches(identity, deps) {
  const id = new Set(words(identity)); const out = [];
  for (const d of deps) {
    const t = sigTokens(d); if (!t.length) continue;
    if (t.every((w) => id.has(w) || (ALIAS[w] || []).some((x) => id.has(x)))) out.push(d);
  }
  return out;
}
// A product vendor's skill is only relevant if the user depends on that product.
export function vendorMismatch(source, deps) {
  const owner = String(source).split('/')[0].toLowerCase(); if (!PRODUCT_VENDORS.test(owner + '/')) return false;
  return !deps.some((d) => sigTokens(d).includes(owner) || words(d).includes(owner));
}
export function credibility({ meta, vendor }) {
  const stars = meta?.stars ?? 0; let c = vendor ? 14 : Math.min(14, Math.log10(stars + 1) * 4);
  if (meta?.ageDays >= 90) c += 3; else if (meta?.ageDays != null && meta.ageDays < 45) c -= 6;
  if (meta?.license && meta.license !== 'none') c += 2;
  return c;
}

// Static scan of a skill file. `isCode` = a script rather than markdown guidance (stricter).
const RISK = [
  [/(curl|wget|iwr|Invoke-WebRequest)[^\n|]{0,100}\|\s*(sh|bash|zsh|iex|powershell)/i, 'pipes a download into a shell', 'BLOCK'],
  [/\brm\s+-rf\s+(\/|~|\$HOME|%USERPROFILE%)/i, 'rm -rf on root or home', 'BLOCK'],
  [/(cat|type|Get-Content|readFile\w*)[^\n]{0,40}(\.ssh|id_rsa|\.aws[\\/]credentials|\.netrc|\.npmrc)/i, 'reads credential files', 'BLOCK'],
  [/(base64\s+(-d|--decode)|\batob\(|\beval\s*\(|new Function\()/i, 'obfuscation / dynamic code', 'REVIEW'],
  [/\b(npx|npm i(nstall)?|pnpm add|pip install|curl|wget)\b/i, 'mentions installers or downloads', 'NOTE'],
  [/settings(\.local)?\.json|PreToolUse|PostToolUse|SessionStart/i, 'touches settings or hooks', 'REVIEW'],
  [/(WebFetch|fetch)\b[^\n]{0,80}https?:\/\/[^\s)'"]+\.(md|txt)\b|raw\.githubusercontent\.com\/[^\s)'"]+\.(md|txt)\b/i, 'fetches instructions from the web at runtime', 'REVIEW'],
];
export function scanText(text, { isCode = false, name = '' } = {}) {
  const flags = []; let sev = 'CLEAN';
  const rank = { CLEAN: 0, NOTE: 1, REVIEW: 2, BLOCK: 3 };
  for (const [re, label, level] of RISK) {
    if (!re.test(text)) continue;
    // In markdown, security guidance legitimately discusses eval/credentials; only code files escalate those.
    const eff = !isCode && level === 'BLOCK' && /^(reads credential files)$/.test(label) ? 'REVIEW' : level;
    flags.push(`${label}${name ? ` (${name})` : ''}`); if (rank[eff] > rank[sev]) sev = eff;
  }
  const inj = text.split('\n').filter((l) => l.length > 3 && isInstructionLike(l)).length;
  return { flags, sev, injectionLines: inj };
}

// ---------- GitHub / registry access ----------
const token = () => { if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN; try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 8000 }).trim(); } catch { return ''; } };
const GH = () => { const t = token(); return { 'User-Agent': 'delta', Accept: 'application/vnd.github+json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jget(url, headers = {}, timeout = 30000) { const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
async function readJson(f, fallback) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; } }

async function fetchTree(repo) {
  if (!SAFE_REPO.test(repo)) throw new Error('bad repo');
  const m = await jget(`https://api.github.com/repos/${repo}`, GH());
  const c = await jget(`https://api.github.com/repos/${repo}/commits/${m.default_branch}`, GH());
  const t = await jget(`https://api.github.com/repos/${repo}/git/trees/${c.sha}?recursive=1`, GH());
  return { repo, sha: c.sha, tree: (t.tree || []).filter((e) => e.type === 'blob' && e.mode !== '120000') };
}
async function locateSkill(info, skillId) {
  const skills = info.tree.filter((e) => /(^|\/)SKILL\.md$/.test(e.path));
  const byDir = skills.filter((e) => e.path.split('/').slice(-2, -1)[0] === skillId).sort((a, b) => a.path.length - b.path.length)[0];
  if (byDir) return byDir.path;
  for (const e of skills.slice(0, 60)) { // folder name differs from the skill name: match on frontmatter
    try { const raw = await (await fetch(`https://raw.githubusercontent.com/${info.repo}/${info.sha}/${e.path}`)).text(); if (new RegExp(`^name:\\s*["']?${skillId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm').test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] || '')) return e.path; } catch {}
  }
  return null;
}
const frontmatter = (raw) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] || '';
function descriptionOf(fm) { let d = /^description:\s*(.*)$/m.exec(fm)?.[1] || ''; if (/^[>|][+-]?$/.test(d.trim())) { const L = fm.split(/\r?\n/); d = L.slice(L.findIndex((l) => /^description:/.test(l)) + 1).filter((l) => /^\s+\S/.test(l)).join(' '); } return d.replace(/^["']|["']$/g, '').trim(); }

// ---------- stage 1: profile -> queries ----------
async function buildProfile(useProfile) {
  const base = Object.entries(CLUSTERS).flatMap(([c, [w, qs]]) => qs.map((q) => ({ c, w, q })));
  if (!useProfile) return { queries: base, stack: [], deps: [] };
  let stack = [], roots = [];
  try { const { assess } = await import('./assess.mjs'); const a = await assess({ HERE, plugins: [], enabledMap: {}, skills: [], slash: {} }); stack = a.stack; roots = a.projectRoots || []; } catch {}
  const count = new Map();
  for (const r of roots) {
    const names = new Set();
    try { const p = JSON.parse(await readFile(path.join(r.root, 'package.json'), 'utf8')); Object.keys({ ...p.dependencies, ...p.devDependencies }).forEach((n) => names.add(n)); } catch {}
    try { ((await readFile(path.join(r.root, 'requirements.txt'), 'utf8')) + (await readFile(path.join(r.root, 'pyproject.toml'), 'utf8').catch(() => ''))).split(/[\s=<>~!;,\[\]"']+/).filter((t) => /^[a-z][a-z0-9_-]{2,}$/i.test(t)).forEach((n) => names.add(n.toLowerCase())); } catch {}
    names.forEach((n) => count.set(n, (count.get(n) || 0) + 1));
  }
  const deps = [...count].filter(([n]) => !DEP_STOP.has(n) && !/^@types\//.test(n) && n.length >= 3).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 60).map(([n]) => n);
  const dq = [...new Set(deps.map((n) => n.replace(/^@/, '').replace(/[\/_-]+/g, ' ')))].map((q) => ({ c: 'deps', w: 1.0, q }));
  return { queries: [...base, ...dq], stack, deps };
}

// ---------- stage 2: harvest ----------
async function harvest(queries, { refresh }) {
  const file = path.join(CACHE, 'skills-harvest.json'); await mkdir(CACHE, { recursive: true });
  let db = await readJson(file, null);
  if (!db || refresh || Date.now() - new Date(db.generated).getTime() > 864e5) db = { generated: new Date().toISOString(), done: [], skills: {} };
  const todo = queries.filter((x) => !db.done.includes(x.q)); let failed = 0;
  for (const x of todo) {
    let ok = false;
    for (let a = 0; a < 3 && !ok; a++) {
      try {
        const j = await jget(`https://skills.sh/api/search?q=${encodeURIComponent(x.q)}&limit=200`, { 'User-Agent': 'delta' });
        if (!Array.isArray(j.skills)) throw new Error('bad shape');
        j.skills.forEach((s, rank) => {
          if (!validSkillId(s.id) || !Number.isFinite(s.installs)) return;
          const e = db.skills[s.id] || { id: s.id, source: s.source, skillId: s.skillId, installs: s.installs, hits: [] };
          e.installs = Math.max(e.installs, s.installs); e.hits.push({ c: x.c, w: x.w, rank }); db.skills[s.id] = e;
        });
        db.done.push(x.q); ok = true;
      } catch { await sleep(2500 * (a + 1)); }
    }
    if (!ok) failed++;
    await sleep(800);
  }
  await writeFile(file, JSON.stringify(db));
  return { skills: Object.values(db.skills), queriesRun: todo.length, failed, cached: queries.length - todo.length };
}

// ---------- stage 3: reputation + ranking ----------
async function repoMeta(sources, limit) {
  const file = path.join(CACHE, 'skills-repos.json'); const db = await readJson(file, {}); const h = GH(); let checked = 0, unchecked = 0;
  for (const s of sources) {
    const hit = db[s]; if (hit && Date.now() - hit.t < 6048e5) continue;
    if (checked >= limit) { unchecked++; continue; }
    try { const j = await jget(`https://api.github.com/repos/${s}`, h); db[s] = { t: Date.now(), stars: j.stargazers_count, forks: j.forks_count, ageDays: Math.round((Date.now() - new Date(j.created_at)) / 864e5), license: j.license?.spdx_id || 'none', archived: j.archived, isFork: j.fork }; checked++; }
    catch { db[s] = { t: Date.now(), missing: true }; checked++; }
  }
  await writeFile(file, JSON.stringify(db)); return { db, unchecked };
}
function rank(list, meta, have, deps = []) {
  const packs = new Map(); for (const s of list) { const p = packs.get(s.source) || []; p.push(s.installs); packs.set(s.source, p); }
  const pack = (src) => { const a = [...(packs.get(src) || [])].sort((x, y) => x - y); const med = a[Math.floor(a.length / 2)] || 1; return { n: a.length, med, uniform: a.length >= 4 ? a.filter((x) => Math.abs(x - med) / med < 0.15).length / a.length : 0 }; };
  const bySkill = new Map(); for (const s of list) { const k = s.skillId.toLowerCase(); const cur = bySkill.get(k); if (!cur || cur.installs < s.installs) bySkill.set(k, { ...s, mirrors: (cur?.mirrors || 0) + 1 }); else cur.mirrors++; }
  const rows = [], dropped = [];
  for (const s of bySkill.values()) {
    if (have.has(s.skillId.toLowerCase()) || MIRROR.test(s.source) || OFF_SOURCE.test(s.source) || OFF_SKILL.test(s.skillId.replace(/-/g, ' '))) continue;
    const m = meta[s.source]; if (m?.archived || m?.isFork) continue;
    const pk = pack(s.source); const ig = integrity({ installs: s.installs, source: s.source, meta: m, pack: pk });
    if (!ig.vendor && m?.missing) continue;
    const clusters = [...new Set(s.hits.map((h) => h.c))];
    const rel = Math.max(...s.hits.map((h) => h.w * (1 - h.rank / 220))) + 0.12 * (clusters.length - 1);
    const chosen = pk.uniform < 0.5 && pk.n >= 5 && s.installs > 1.5 * pk.med ? 5 : 0;
    const dm = vendorMismatch(s.source, deps) ? [] : depMatches(`${s.source}/${s.skillId}`, deps);
    const score = Math.log10(s.installs + 1) * (pk.uniform >= 0.5 ? 5 : 8) + rel * 22 + credibility({ meta: m, vendor: ig.vendor }) + chosen - ig.farm + (dm.length ? (ig.vendor ? 22 : 12) : 0);
    const row = { ...s, score, depMatches: dm, clusters, vendor: ig.vendor, stars: m?.stars ?? null, ageDays: m?.ageDays ?? null, license: m?.license ?? null, reasons: ig.reasons, farm: ig.farm > 0, repoChecked: !!m };
    (ig.farm >= 45 ? dropped : rows).push(row);
  }
  rows.sort((a, b) => b.score - a.score); return { rows, dropped: dropped.sort((a, b) => b.installs - a.installs) };
}
async function haveNames() {
  const have = new Set(); const add = async (d) => { try { for (const e of await readdir(d, { withFileTypes: true })) if (e.isDirectory()) have.add(e.name.toLowerCase()); } catch {} };
  await add(ROOTS.claude); await add(ROOTS.agents); await add(path.join(home, '.codex', 'skills'));
  // Skills installed under another name (or by hand) still count: read their provenance files.
  for (const root of [ROOTS.claude, ROOTS.agents]) { try { for (const e of await readdir(root, { withFileTypes: true })) { if (!e.isDirectory()) continue;
    const p = await readJson(path.join(root, e.name, '.delta-source.json'), null); if (!p) continue;
    if (p.path) have.add(String(p.path).split('/').pop().toLowerCase());
    for (const m of p.modifications || []) { const r = /renamed\s+([\w.-]+)\s*->/.exec(m); if (r) have.add(r[1].toLowerCase()); }
    if (p.id) have.add(String(p.id).split('/').pop().toLowerCase()); } } catch {} }
  const reg = (await readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {})).plugins || {};
  for (const v of Object.values(reg)) { const ip = v?.[0]?.installPath; if (ip) await add(path.join(ip, 'skills')); }
  return have;
}

// ---------- stage 4: hydrate + scan ----------
async function hydrate(rows, n) {
  const trees = new Map(); const out = []; let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < Math.min(n, rows.length)) {
      const r = rows[i++];
      try {
        if (!trees.has(r.source)) trees.set(r.source, fetchTree(r.source).catch(() => null)); const info = await trees.get(r.source); if (!info) { out.push({ ...r, error: 'repo unavailable' }); continue; }
        const p = await locateSkill(info, r.skillId); if (!p) { out.push({ ...r, error: 'SKILL.md not found' }); continue; }
        const raw = await (await fetch(`https://raw.githubusercontent.com/${r.source}/${info.sha}/${p}`)).text(); const fm = frontmatter(raw);
        const dir = p.replace(/SKILL\.md$/, ''); const extras = info.tree.filter((e) => e.path.startsWith(dir) && e.path !== p);
        const code = extras.filter((e) => /\.(sh|bash|ps1|py|js|mjs|cjs|ts|rb|pl)$/i.test(e.path));
        const sc = scanText(raw, { name: 'SKILL.md' });
        out.push({ ...r, path: p, sha: info.sha, description: defang(descriptionOf(fm), 300), tokens: Math.round(raw.length / 4), files: extras.length + 1, codeFiles: code.map((e) => e.path.slice(dir.length)), invokeOnly: /disable-model-invocation:\s*true/.test(fm), flags: sc.flags, sev: sc.sev, injectionLines: sc.injectionLines });
      } catch (e) { out.push({ ...r, error: String(e.message).slice(0, 80) }); }
    }
  }));
  return out.sort((a, b) => b.score - a.score);
}

// ---------- safe installer ----------
export async function installSkill(id, { confirm = false, roots = ['claude', 'agents'], as = null } = {}) {
  if (!validSkillId(id)) throw new Error(`invalid skill id: ${id}`);
  const [owner, repoName, skillId] = id.split('/'); const repo = `${owner}/${repoName}`;
  const name = as || skillId; if (!SAFE.test(name)) throw new Error('invalid target name');
  if (BUILTIN.has(name.toLowerCase())) throw new Error(`"${name}" collides with a built-in command; choose another with --as <name>`);
  const info = await fetchTree(repo); const p = await locateSkill(info, skillId); if (!p) throw new Error('SKILL.md not found in repo');
  const dir = p.replace(/SKILL\.md$/, '').replace(/\/$/, ''); const prefix = dir ? dir + '/' : '';
  const files = info.tree.filter((e) => e.path.startsWith(prefix));
  if (files.length > 400) throw new Error(`too many files (${files.length})`); const total = files.reduce((a, f) => a + (f.size || 0), 0); if (total > 8e6) throw new Error(`too large (${Math.round(total / 1e6)}MB)`);
  const stage = path.join(CACHE, 'stage', `${name}-${Date.now()}`); await mkdir(stage, { recursive: true });
  const report = { id, repo, commit: info.sha, files: files.length, kb: Math.round(total / 1024), codeFiles: [], flags: [], sev: 'CLEAN', injectionLines: 0 };
  const rank = { CLEAN: 0, NOTE: 1, REVIEW: 2, BLOCK: 3 };
  try {
    for (const f of files) {
      const rel = f.path.slice(prefix.length); if (!safeRelPath(rel)) throw new Error(`unsafe path in repo: ${rel}`);
      const buf = Buffer.from(await (await fetch(`https://raw.githubusercontent.com/${repo}/${info.sha}/${f.path}`)).arrayBuffer());
      const dest = path.join(stage, rel); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, buf);
      const isCode = /\.(sh|bash|ps1|py|js|mjs|cjs|ts|rb|pl)$/i.test(rel); if (isCode) report.codeFiles.push(rel);
      if (/\.(md|txt|json|ya?ml|sh|bash|ps1|py|js|mjs|cjs|ts)$/i.test(rel)) { const sc = scanText(buf.toString('utf8'), { isCode, name: rel }); report.flags.push(...sc.flags); report.injectionLines += sc.injectionLines; if (rank[sc.sev] > rank[report.sev]) report.sev = sc.sev; }
    }
    const fm = frontmatter(await readFile(path.join(stage, 'SKILL.md'), 'utf8'));
    const fmName = (/^name:\s*(.+)$/m.exec(fm)?.[1] || '').trim().replace(/^["']|["']$/g, '');
    report.renamed = fmName !== name;
    report.verdict = report.sev === 'BLOCK' ? 'BLOCK' : report.sev === 'REVIEW' || report.codeFiles.length ? 'REVIEW' : 'CLEAN';
    const have = await haveNames(); report.collision = have.has(name.toLowerCase());
    if (report.verdict === 'BLOCK') return { ...report, installed: false, reason: 'high-severity finding: refusing to install' };
    if (report.collision) return { ...report, installed: false, reason: `you already have a skill named "${name}"` };
    if (!confirm) return { ...report, installed: false, reason: 'dry run: read the report (and the skill), then re-run with --confirm' };
    if (report.renamed) { const t = await readFile(path.join(stage, 'SKILL.md'), 'utf8'); await writeFile(path.join(stage, 'SKILL.md'), t.replace(/^(---\r?\n[\s\S]*?)^name:\s*.+$/m, `$1name: ${name}`)); }
    await writeFile(path.join(stage, '.delta-source.json'), JSON.stringify({ source: 'skills.sh', id, repo, commit: info.sha, path: dir, installedAs: name, verdict: report.verdict, flags: [...new Set(report.flags)], fetchedAt: new Date().toISOString(), installedBy: 'delta skills --install' }, null, 1));
    for (const r of roots) { const target = path.join(ROOTS[r], name); if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`); }
    for (const r of roots) { await mkdir(ROOTS[r], { recursive: true }); await cp(stage, path.join(ROOTS[r], name), { recursive: true, errorOnExist: true, force: false }); }
    return { ...report, installed: true, roots: roots.map((r) => path.join(ROOTS[r], name)) };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

// ---------- CLI ----------
async function main() {
  const a = process.argv.slice(2); const flag = (k) => a.includes(k); const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (flag('--install')) {
    const ids = a.slice(a.indexOf('--install') + 1).filter((x) => !x.startsWith('--') && x.includes('/')); const roots = (val('--roots') || 'claude,agents').split(',').filter((r) => ROOTS[r]);
    if (!ids.length) { console.error('usage: --install owner/repo/skill [more ids] [--confirm] [--as name] [--roots claude,agents]'); process.exit(2); }
    for (const id of ids) {
      try { const r = await installSkill(id, { confirm: flag('--confirm'), roots, as: ids.length === 1 ? val('--as') : null });
        console.log(`\n${r.installed ? 'INSTALLED' : 'NOT INSTALLED'}  ${id}  @${r.commit.slice(0, 7)}\n  verdict: ${r.verdict}  | ${r.files} files, ${r.kb} KB | code files: ${r.codeFiles.join(', ') || 'none'}${r.renamed ? ' | frontmatter name will be rewritten' : ''}\n  flags: ${[...new Set(r.flags)].join('; ') || 'none'} | instruction-like lines: ${r.injectionLines}\n  ${r.installed ? 'into: ' + r.roots.join(', ') : r.reason}`);
      } catch (e) { console.log(`\nNOT INSTALLED  ${id}: ${e.message}`); }
    }
    return;
  }
  const top = Number(val('--top')) || 30; const profile = await buildProfile(!flag('--no-profile'));
  console.error(`profile: stack [${profile.stack.join(', ') || 'unknown'}], ${profile.deps.length} dependency queries, ${profile.queries.length} queries total`);
  const h = await harvest(profile.queries, { refresh: flag('--refresh') });
  const have = await haveNames(); const sources = [...new Set(h.skills.map((s) => s.source))];
  // Only look up reputation for sources that could matter: those of the best raw candidates.
  const pre = [...h.skills].sort((x, y) => y.installs - x.installs).slice(0, 1500).map((s) => s.source);
  const { db: meta, unchecked } = await repoMeta([...new Set(pre)].slice(0, 400), token() ? 400 : 40);
  const { rows, dropped } = rank(h.skills, meta, have, profile.deps);
  const hyd = await hydrate([...rows.filter((r) => r.depMatches.length).slice(0, 60), ...rows.filter((r) => !r.depMatches.length).slice(0, Math.max(top * 2, 70))].sort((a, b) => b.score - a.score), 130);
  const good = hyd.filter((x) => !x.error); const result = { generated: new Date().toISOString(), harvested: h.skills.length, sources: sources.length, queries: { run: h.queriesRun, cached: h.cached, failed: h.failed }, candidates: rows.length, droppedFarms: dropped.slice(0, 8).map((d) => ({ id: d.id, installs: d.installs, stars: d.stars })), unchecked, results: good.slice(0, top), forDependencies: good.filter((x) => x.depMatches.length).slice(0, top) };
  if (flag('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`\nSkill search: ${h.skills.length.toLocaleString()} skills from ${sources.length.toLocaleString()} sources (${h.queriesRun} queries run, ${h.cached} cached, ${h.failed} failed) -> ${rows.length} candidates after integrity + domain filters${unchecked ? `\n  note: ${unchecked} sources could not be reputation-checked (log in with "gh auth login" for a higher GitHub rate limit)` : ''}`);
  if (dropped.length) console.log(`Dropped as likely install farms: ${dropped.slice(0, 5).map((d) => `${d.id} (${d.installs.toLocaleString()} installs, ${d.stars} stars)`).join('; ')}`);
  const line = (r, i) => `${String(i + 1).padStart(2)}. ${r.score.toFixed(0).padStart(4)} ${String(r.installs).padStart(9)} ${String(r.stars ?? '?').padStart(7)} ${String(r.tokens + 't').padStart(6)}  ${(r.sev === 'BLOCK' ? 'BLOCK' : r.sev === 'REVIEW' || r.codeFiles.length ? 'REVIEW' : 'clean').padEnd(7)}  ${r.vendor ? '*' : ' '}${r.id}${r.invokeOnly ? '  [invoke-only]' : ''}\n      ${r.description.slice(0, 150)}${r.depMatches.length ? `\n      your dependency: ${r.depMatches.join(', ')}` : ''}${r.flags.length ? `\n      flags: ${[...new Set(r.flags)].join('; ')}` : ''}${r.codeFiles.length ? `\n      code files: ${r.codeFiles.slice(0, 4).join(', ')}` : ''}${r.reasons.length ? `\n      note: ${r.reasons.join('; ')}` : ''}`;
  const forDeps = good.filter((x) => x.depMatches.length).slice(0, Math.ceil(top / 2)); const general = good.filter((x) => !x.depMatches.length).slice(0, top);
  console.log(`\n=== FOR LIBRARIES YOU USE (matched against your project dependencies) ===\n#   score  installs   stars  size  verdict  skill`); forDeps.forEach((r, i) => console.log(line(r, i)));
  console.log(`\n=== GENERAL WORKFLOW AND QUALITY ===\n#   score  installs   stars  size  verdict  skill`); general.forEach((r, i) => console.log(line(r, i)));
  console.log(`\n(* = publisher documents/ships its own product; installs are registry telemetry, so treat as a signal, not proof.)\nNext: read a candidate's SKILL.md, then:  node skills.mjs --install <id>   (dry run)   and add --confirm to install.`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((e) => { console.error('skills search failed:', e.message); process.exit(1); });
