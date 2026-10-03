// Token ledger: what every enabled plugin costs at the start of EVERY session vs how often and WHERE you use it.
// The big wins are rarely "unused" plugins; they are heavy plugins used in one or two projects but loaded in all of them.
// Fix = disable at user scope + enable at project scope (verified: a project-level enable overrides a user-level disable).
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);
const home = os.homedir();

// `claude plugin details` is slow (~2s each); cache results for 12h, keyed by plugin name.
const CACHE = path.join(os.tmpdir(), 'delta-details-cache.json');
let cachePromise = null;
async function cached(name, fn) {
  cachePromise ||= readFile(CACHE, 'utf8').then(JSON.parse).catch(() => ({}));
  const cache = await cachePromise;
  const hit = cache[name]; if (hit && Date.now() - hit.t < 432e5) return hit.d;
  const d = await fn(); if (d) { cache[name] = { t: Date.now(), d }; try { await (await import('node:fs/promises')).writeFile(CACHE, JSON.stringify(cache)); } catch {} }
  return d;
}
const details = (name) => cached(name, () => detailsRaw(name));
async function detailsRaw(name) {
  try {
    const { stdout: t } = await run('claude', ['plugin', 'details', name], { timeout: 40000 });
    const num = (re) => { const m = re.exec(t); return m ? Number(m[1]) : 0; };
    const tok = /Always-on:\s+~?([\d,]+)\s*tok/i.exec(t);
    return { tokens: tok ? Number(tok[1].replace(/,/g, '')) : null, skills: num(/Skills \((\d+)\)/), agents: num(/Agents \((\d+)\)/), hooks: num(/Hooks \((\d+)\)/), mcp: num(/MCP servers \((\d+)\)/) };
  } catch { return null; }
}

const SAFE_NAME = /^[A-Za-z0-9._@-]{1,120}$/;

export async function buildLedger({ enabledMap, perSession, idx, projectOf, hooky, tagProjects = new Map(), minTokens = 400 }) {
  const keys = Object.entries(enabledMap).filter(([k, on]) => on && SAFE_NAME.test(k)).map(([k]) => k);
  const info = new Map((await Promise.all(keys.map(async (k) => [k, await details(k.split('@')[0])]))));
  const plugOf = (name) => { const lc = name.toLowerCase(); return lc.includes(':') ? lc.split(':')[0] : (idx.get(lc) || lc); };

  // Sessions per project, and per plugin per project (sessions in which the plugin was actually used).
  const total = perSession.length;
  const sessByProject = new Map(); const useByPlugin = new Map(); // plugin -> Map(project -> sessions)
  const projPath = new Map();
  for (const s of perSession) {
    const proj = projectOf(s.cwd); if (!proj) continue;
    projPath.set(proj.name, proj.root);
    sessByProject.set(proj.name, (sessByProject.get(proj.name) || 0) + 1);
    for (const n of new Set([...s.used.keys()].map(plugOf))) {
      if (!useByPlugin.has(n)) useByPlugin.set(n, new Map());
      useByPlugin.get(n).set(proj.name, (useByPlugin.get(n).get(proj.name) || 0) + 1);
    }
  }
  // Slash commands (history.jsonl records the project of each command).
  try {
    for (const line of (await readFile(path.join(home, '.claude', 'history.jsonl'), 'utf8')).split('\n')) {
      if (!line) continue; let d; try { d = JSON.parse(line); } catch { continue; }
      const m = /^\/([\w:-]+)/.exec(d.display || ''); if (!m || !d.project) continue;
      const plugin = plugOf(m[1]); const proj = projectOf(String(d.project).replace(/\\/g, '/'));
      if (!proj || !idx.has(m[1].toLowerCase()) && !m[1].includes(':')) continue;
      if (!useByPlugin.has(plugin)) useByPlugin.set(plugin, new Map());
      const mp = useByPlugin.get(plugin); mp.set(proj.name, Math.max(mp.get(proj.name) || 0, 1));
      projPath.set(proj.name, proj.root);
    }
  } catch {}

  const rows = []; let totalTokens = 0, saving = 0;
  for (const [key, d] of info) {
    if (!d || d.tokens === null) continue;
    const name = key.split('@')[0]; totalTokens += d.tokens;
    const byProj = useByPlugin.get(name.toLowerCase()) || useByPlugin.get(name.replace(/-/g, '_').toLowerCase()) || new Map();
    let projects = [...byProj.keys()];
    const sessionsUsing = [...byProj.values()].reduce((a, b) => a + b, 0);
    // Plugins that act through hooks (usage not measurable): fall back to the projects whose dependencies match the plugin's technology.
    let inferred = false;
    if (!sessionsUsing && hooky.has(name) && tagProjects.has(name.toLowerCase())) { projects = [...tagProjects.get(name.toLowerCase())]; inferred = true; }
    const row = { plugin: name, key, ...d, uses: sessionsUsing, projects, action: 'keep', savings: 0, commands: [], note: '' };
    if (d.tokens >= minTokens) {
      if (!sessionsUsing && !hooky.has(name)) {
        row.action = 'disable'; row.savings = d.tokens;
        row.commands = [`claude plugin disable ${key} --scope user`]; row.note = 'no recorded use';
      } else if (projects.length && projects.length <= 3 && projects.every((p) => projPath.has(p) || sessByProject.has(p))) {
        const inUsed = projects.reduce((a, p) => a + (sessByProject.get(p) || 0), 0);
        const outside = total ? 1 - inUsed / total : 0;
        if (outside >= 0.4) { // only worth it if most sessions happen elsewhere
          row.action = 'scope'; row.savings = Math.round(d.tokens * outside);
          row.commands = [`claude plugin disable ${key} --scope user`, ...projects.map((p) => `cd "${projPath.get(p)}" && claude plugin enable ${key} --scope project`)];
          row.note = `${inferred ? 'your stack uses it only in' : 'used only in'} ${projects.join(', ')}; ${Math.round(outside * 100)}% of your sessions are elsewhere${inferred ? ' (hook-based, so usage is inferred from dependencies)' : ''}`;
        }
      }
    }
    saving += row.savings; rows.push(row);
  }
  rows.sort((a, b) => b.tokens - a.tokens);
  return { sessions: total, totalTokens, potentialSavings: saving, afterTokens: totalTokens - saving, rows };
}

// CLAUDE.md files are loaded into every session in that project: flag the heavy ones.
export async function claudeMdAudit(projectRoots, warnBytes = 6000) {
  const out = [];
  const files = [[path.join(home, '.claude', 'CLAUDE.md'), 'global'], ...projectRoots.map((r) => [path.join(r.root, 'CLAUDE.md'), r.name])];
  for (const [fp, label] of files) {
    try { const s = await stat(fp); out.push({ label, bytes: s.size, tokens: Math.round(s.size / 4), heavy: s.size >= warnBytes }); } catch {}
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}
