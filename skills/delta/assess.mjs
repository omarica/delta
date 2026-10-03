// Local setup assessment: detects your stack, measures what you actually use, and matches both against
// the live official plugin marketplace. Nothing is uploaded. Only the marketplace catalog is downloaded.
// Reads: ~/.claude/projects/*/*.jsonl (tool names + working directories only), project manifests (dependency NAMES).
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildLedger, claudeMdAudit } from './ledger.mjs';

const MARKET_URL = 'https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json';
const MARKET_NAME = 'claude-plugins-official';
const home = os.homedir();

const norm = (p) => p.replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:/`).replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
const exists = (p) => existsSync(p);
const tryRead = async (p) => { try { return await readFile(p, 'utf8'); } catch { return ''; } };

async function marketplace() {
  // Cache in a user-owned folder, not the shared temp dir (any local process could overwrite a file there).
  const cacheDir = path.join(home, '.claude', 'delta-cache'); try { await mkdir(cacheDir, { recursive: true }); } catch {}
  const cache = path.join(cacheDir, 'marketplace.json');
  try { const s = await stat(cache); if (Date.now() - s.mtimeMs < 864e5) return JSON.parse(await readFile(cache, 'utf8')); } catch {}
  try {
    const r = await fetch(MARKET_URL, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json(); await writeFile(cache, JSON.stringify(j)); return j;
  } catch { return null; }
}

// Walk every transcript once: collect project dirs and which skills / subagents / MCP servers were really used.
async function scanTranscripts() {
  const root = path.join(home, '.claude', 'projects');
  const used = new Map(); const cwds = new Map(); const perSession = []; let sessions = 0; let oldest = Infinity;
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let dirs = []; try { dirs = await readdir(root); } catch { return { used, cwds, perSession, sessions, since: null }; }
  for (const d of dirs) {
    let files = []; try { files = (await readdir(path.join(root, d))).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(root, d, f);
      let text; try { text = await readFile(fp, 'utf8'); const s = await stat(fp); oldest = Math.min(oldest, s.birthtimeMs || s.mtimeMs); } catch { continue; }
      sessions++;
      let gotCwd = false; let sCwd = null; const sUsed = new Map();
      for (const line of text.split('\n')) {
        if (!gotCwd) { const m = /"cwd":"([^"]+)"/.exec(line); if (m) { sCwd = norm(JSON.parse(`"${m[1]}"`)); bump(cwds, sCwd); gotCwd = true; } }
        if (!line.includes('"tool_use"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const c = j.message?.content; if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (b?.type !== 'tool_use') continue;
          if (b.name === 'Skill' && b.input?.skill) { bump(used, b.input.skill.split(':')[0]); bump(sUsed, b.input.skill.split(':')[0]); }
          else if (b.name === 'Agent' && b.input?.subagent_type) { bump(used, b.input.subagent_type.split(':')[0]); bump(sUsed, b.input.subagent_type.split(':')[0]); }
          else if (b.name?.startsWith('mcp__plugin_')) { const k = b.name.split('__')[1].replace(/^plugin_/, '').replace(/_[^_]+$/, ''); bump(used, k); bump(sUsed, k); }
        }
      }
      perSession.push({ cwd: sCwd, used: sUsed });
    }
  }
  return { used, cwds, perSession, sessions, since: Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 10) : null };
}

function findProjectRoot(dir) {
  let cur = dir;
  for (let i = 0; i < 6; i++) {
    if (['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'].some((m) => exists(path.join(cur, m)))) return cur;
    const up = path.dirname(cur); if (up === cur) break; cur = up;
  }
  return exists(dir) ? dir : null;
}

async function detectStack(stackCfg, cwds) {
  const roots = new Map();
  for (const [cwd, n] of cwds) {
    if (!cwd.toLowerCase().startsWith(norm(home).toLowerCase())) continue;
    const r = findProjectRoot(cwd); if (r && r !== norm(home)) roots.set(norm(r), (roots.get(norm(r)) || 0) + n);
  }
  const tagProjects = new Map(); // tag -> Set(project names)
  const add = (tag, name) => { if (!tagProjects.has(tag)) tagProjects.set(tag, new Set()); tagProjects.get(tag).add(name); };
  for (const root of roots.keys()) {
    const name = path.basename(root);
    const deps = [];
    try { const p = JSON.parse(await tryRead(path.join(root, 'package.json')) || '{}'); deps.push(...Object.keys({ ...p.dependencies, ...p.devDependencies })); } catch {}
    const py = (await tryRead(path.join(root, 'requirements.txt'))) + '\n' + (await tryRead(path.join(root, 'pyproject.toml')));
    deps.push(...(py.match(/[A-Za-z0-9_.@/-]{2,}/g) || []).map((s) => s.toLowerCase()));
    for (const [tag, pats] of Object.entries(stackCfg.tags)) if (pats.some((p) => deps.some((d) => new RegExp(p, 'i').test(d)))) add(tag, name);
    for (const [tag, files] of Object.entries(stackCfg.files)) if (files.some((f) => exists(path.join(root, f)))) add(tag, name);
    let entries = []; try { entries = (await readdir(root)).slice(0, 400); } catch {}
    for (const e of entries) { const t = stackCfg.extensions[path.extname(e).toLowerCase()]; if (t) add(t, name); }
  }
  return { projects: [...roots.keys()].map((r) => path.basename(r)), tagProjects };
}

function hasBin(bin) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Always-on context cost of a plugin, from the official CLI (`claude plugin details`). null if unavailable.
function alwaysOnTokens(name) {
  try {
    const t = execFileSync('claude', ['plugin', 'details', name], { encoding: 'utf8', timeout: 20000 });
    const m = /Always-on:\s+~?([\d,]+)\s*tok/i.exec(t); return m ? Number(m[1].replace(/,/g, '')) : null;
  } catch { return null; }
}

// Which plugin owns which skill / command / agent name, and which plugins act through hooks (usage not measurable).
async function pluginIndex() {
  const idx = new Map(); const hooky = new Set(); const paths = new Map();
  const reg = JSON.parse((await tryRead(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))) || '{}').plugins || {};
  for (const [key, installs] of Object.entries(reg)) {
    const plugin = key.split('@')[0]; const ip = installs?.[0]?.installPath; if (!ip) continue; paths.set(key, ip);
    for (const [sub, strip] of [['skills', ''], ['commands', '.md'], ['agents', '.md']]) {
      try { for (const e of await readdir(path.join(ip, sub))) idx.set(e.replace(strip, '').toLowerCase(), plugin); } catch {}
    }
    if (exists(path.join(ip, 'hooks')) || exists(path.join(ip, 'hooks.json')) || exists(path.join(ip, '.claude-plugin', 'hooks.json'))) hooky.add(plugin);
  }
  return { idx, hooky, paths };
}

export async function assess({ HERE, plugins, enabledMap, skills, slash = {} }) {
  const stackCfg = JSON.parse(await readFile(path.join(HERE, 'stack.json'), 'utf8'));
  const [market, scan] = await Promise.all([marketplace(), scanTranscripts()]);
  const stack = await detectStack(stackCfg, scan.cwds);
  const { idx, hooky, paths: installPaths } = await pluginIndex();
  const usedBy = new Map(); // plugin -> uses
  const credit = (name, n) => { const lc = name.toLowerCase(); const plugin = lc.includes(':') ? lc.split(':')[0] : (idx.get(lc) || lc); usedBy.set(plugin, (usedBy.get(plugin) || 0) + n); };
  for (const [k, n] of scan.used) credit(k, n);
  for (const [k, n] of Object.entries(slash)) credit(k, n);
  // The catalog (downloaded or cached) is untrusted input: keep only entries whose name is a plain identifier, since names end up in commands.
  const SAFE = /^[A-Za-z0-9._-]{1,100}$/;
  if (market) market.plugins = (Array.isArray(market.plugins) ? market.plugins : []).filter((p) => p && typeof p.name === 'string' && SAFE.test(p.name))
    .map((p) => ({ ...p, description: String(p.description ?? '').replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, ' ').slice(0, 300), category: typeof p.category === 'string' ? p.category.slice(0, 40) : '' }));
  const catalog = new Map((market?.plugins || []).map((p) => [p.name, p]));
  const have = new Set([...Object.keys(enabledMap)].map((k) => k.split('@')[0].toLowerCase()));
  const installCmd = (n) => `claude plugin install ${n}@${MARKET_NAME}`;
  const projList = (tag) => [...(stack.tagProjects.get(tag) || [])];
  const out = { sessions: scan.sessions, since: scan.since, projects: stack.projects.length, stack: [...stack.tagProjects.keys()], stackTags: Object.fromEntries([...stack.tagProjects].map(([t, s]) => [t, [...s]])), installedNames: [...have, ...skills, ...idx.keys()], install: [], prune: [], marketplace: !!market };

  // Token ledger: cost of every enabled plugin vs where it is really used; plus heavy CLAUDE.md files.
  const rootCache = new Map();
  const projectOf = (cwd) => {
    if (!cwd) return null; const n = norm(cwd);
    if (rootCache.has(n)) return rootCache.get(n);
    const r = n.toLowerCase().startsWith(norm(home).toLowerCase()) ? findProjectRoot(n) : null;
    const v = r && norm(r) !== norm(home) ? { name: path.basename(r), root: norm(r) } : null; rootCache.set(n, v); return v;
  };
  try { out.ledger = await buildLedger({ enabledMap, perSession: scan.perSession, idx, projectOf, hooky, tagProjects: stack.tagProjects, installPaths }); } catch (e) { out.ledgerError = e.message; }
  const roots = new Map(); for (const s of scan.perSession) { const p = projectOf(s.cwd); if (p) roots.set(p.root, p); }
  out.claudeMd = await claudeMdAudit([...roots.values()]);

  // 1. Curated, verified recommendations (only plugins that exist in the live marketplace and are not installed/declined).
  const seen = new Set();
  for (const r of stackCfg.recommend) {
    if (have.has(r.plugin) || seen.has(r.plugin)) continue;
    if (market && !catalog.has(r.plugin)) continue;
    if (r.unlessSkill?.some((s) => skills.some((x) => x.includes(s)))) continue;
    const hits = r.when.flatMap(projList); if (!hits.length) continue;
    seen.add(r.plugin);
    // Language-server plugins do nothing unless the server binary exists: check, and say how to get it.
    const missingBin = r.requires && !hasBin(r.requires.bin) ? r.requires : null;
    out.install.push({ plugin: r.plugin, command: missingBin ? `${missingBin.install}   # prerequisite: '${missingBin.bin}' not found on PATH\n    ${installCmd(r.plugin)}` : installCmd(r.plugin), why: r.reason, evidence: `${[...new Set(hits)].length} of your projects: ${[...new Set(hits)].slice(0, 4).join(', ')}`, weight: 30 + [...new Set(hits)].length });
  }
  // 2. Auto-match: marketplace plugins named after a technology you use (e.g. a "stripe-*" or "sentry-*" plugin).
  if (market) for (const tag of [...stack.tagProjects.keys()].filter((t) => stackCfg.autoTags.includes(t) && ![...have].some((h) => h.includes(t)))) { // skip technologies you already have a plugin for
    for (const p of market.plugins) {
      if (seen.has(p.name) || have.has(p.name) || !stackCfg.autoMatchCategories.includes(p.category)) continue;
      if (!new RegExp(`(^|-)${tag.replace(/[^a-z0-9]/g, '')}(-|$)`).test(p.name)) continue;
      seen.add(p.name);
      out.install.push({ plugin: p.name, command: installCmd(p.name), why: (p.description || '').split(/[.\n]/)[0].slice(0, 140), evidence: `matches ${tag} in ${projList(tag).slice(0, 3).join(', ')}`, weight: 12 });
    }
  }
  // 3. Installed (enabled) plugins with no recorded use.
  const passive = stackCfg.passivePlugins.map((p) => new RegExp(p));
  for (const [key, on] of Object.entries(enabledMap)) {
    if (!on) continue;
    const name = key.split('@')[0];
    const uses = usedBy.get(name.toLowerCase()) || usedBy.get(name.replace(/-/g, '_').toLowerCase()) || 0;
    if (uses > 0 || passive.some((r) => r.test(name))) continue;
    if (hooky.has(name)) { out.unmeasurable = [...(out.unmeasurable || []), name]; continue; }
    out.prune.push({ plugin: name, uses: 0, command: `claude plugin disable ${name}`, weight: 10 });
  }
  // Price each unused plugin; only the ones that actually cost context are worth pruning.
  for (const p of out.prune) { p.tokens = out.ledger?.rows.find((r) => r.plugin === p.plugin)?.tokens ?? alwaysOnTokens(p.plugin); }
  out.harmless = out.prune.filter((p) => p.tokens !== null && p.tokens < 150).map((p) => p.plugin);
  out.prune = out.prune.filter((p) => p.tokens === null || p.tokens >= 150).map((p) => ({ ...p,
    why: `Unused in ${scan.sessions} sessions since ${scan.since}` + (p.tokens !== null ? `, yet adds ~${p.tokens.toLocaleString()} tokens to every session.` : '; its descriptions load every session.') }))
    .sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
  out.install.sort((a, b) => b.weight - a.weight); 
  out.install = out.install.slice(0, 6);
  return out;
}
