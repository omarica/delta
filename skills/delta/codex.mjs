// Codex assessment: what your ENABLED Codex skills cost in context and which ones you really use.
// Works from files on disk only (no CLI, no keys, no network). Static costs are exact and instant; usage is a bounded SAMPLE of
// your newest sessions (Codex session logs are huge: 5 GB here), counting only real tool-call reads of a skill, never listings.
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const CODEX = process.env.CODEX_HOME || path.join(home, '.codex');
const tokensOf = (s) => Math.ceil(s.length / 4);
const SAFE = /^[A-Za-z0-9._-]{1,100}$/;

// Codex lists every skill as "- name: description (cut to ~72 chars) (file: rN/path/SKILL.md)" in every session. The rest of the frontmatter is not loaded.
async function skillTokens(file) {
  try {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await readFile(file, 'utf8'))?.[1] ?? '';
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1] ?? '';
    let desc = /^description:\s*(.*)$/m.exec(fm)?.[1] ?? '';
    if (/^[>|][+-]?$/.test(desc.trim())) { // folded/literal block: take the indented lines that follow
      const after = fm.slice(fm.search(/^description:/m)).split(/\r?\n/).slice(1);
      desc = after.filter((l, i) => /^\s+\S/.test(l) && after.slice(0, i).every((p) => /^\s+\S/.test(p) || p === '')).join(' ');
    }
    return Math.ceil((name.length + Math.min(desc.length, 72) + 50) / 4); // calibrated on a real injected block: ~39 tokens/skill
  } catch { return null; }
}

// Plugin enablement as Codex itself records it: [plugins."name@marketplace"] enabled = true|false
async function enabledPlugins() {
  const cfg = await readFile(path.join(CODEX, 'config.toml'), 'utf8').catch(() => '');
  const on = new Set(), off = new Set();
  for (const m of cfg.matchAll(/\[plugins\."([^"]+)"\]\s*\r?\n\s*enabled\s*=\s*(true|false)/g)) (m[2] === 'true' ? on : off).add(m[1]);
  return { on, off, cfg };
}

async function listSkills(enabled) {
  const out = [];
  const add = async (dir, source, key = null) => {
    let entries = []; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || !SAFE.test(e.name)) continue;
      const tok = await skillTokens(path.join(dir, e.name, 'SKILL.md')); if (tok === null) continue;
      out.push({ name: e.name, tokens: tok, source, key });
    }
  };
  await add(path.join(CODEX, 'skills'), 'user');
  await add(path.join(CODEX, 'skills', '.system'), 'system');
  await add(path.join(home, '.agents', 'skills'), 'user:.agents');
  // plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>: only plugins that config.toml enables, newest version only.
  const cache = path.join(CODEX, 'plugins', 'cache');
  for (const market of await readdir(cache).catch(() => [])) for (const plugin of await readdir(path.join(cache, market)).catch(() => [])) {
    if (!enabled.on.has(`${plugin}@${market}`)) continue;
    const versions = (await readdir(path.join(cache, market, plugin)).catch(() => [])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const v = versions.at(-1); if (v) { const key = `${plugin}@${market}`; await add(path.join(cache, market, plugin, v, 'skills'), `plugin:${plugin}`, key); await add(path.join(cache, market, plugin, v, '.codex-plugin', 'migrated-command-skills'), `plugin:${plugin}`, key); }
  }
  return out;
}

// Newest sessions first, stop at the byte budget. A "real read" is a function_call line naming the skill's SKILL.md.
async function sampleUsage(names, budgetBytes) {
  const root = path.join(CODEX, 'sessions'); const files = [];
  try {
    for (const y of (await readdir(root)).sort().reverse()) for (const m of (await readdir(path.join(root, y))).sort().reverse())
      for (const d of (await readdir(path.join(root, y, m))).sort().reverse()) for (const f of (await readdir(path.join(root, y, m, d))).sort().reverse())
        if (f.endsWith('.jsonl')) files.push(path.join(root, y, m, d, f));
  } catch { return null; }
  // Finished sessions never change, so results are cached per file (path + size). Each run scans at most `budgetBytes` of NEW
  // sessions (newest first); sessions scanned on earlier runs are free, so coverage grows run over run until it is complete.
  const cacheFile = path.join(home, '.claude', 'delta-cache', 'codex-usage.json');
  let cache = {}; try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
  const used = new Map(); let covered = 0, scanned = 0, fresh = 0, dirty = false; const re = /skills[\\/]+([A-Za-z0-9_.-]+)[\\/]+SKILL\.md/g;
  for (const f of files) {
    const size = (await stat(f)).size; if (size > 400e6) continue; // too big to hold in one string
    const hit = cache[f]; let seen;
    if (hit && hit.size === size && Array.isArray(hit.names)) seen = new Set(hit.names.filter((n) => typeof n === 'string' && SAFE.test(n)));
    else {
      if (fresh >= budgetBytes) continue; // new-scan budget spent: keep walking only to reuse cached files
      const text = await readFile(f, 'utf8').catch(() => null); if (text === null) continue;
      seen = new Set(); fresh += size;
      for (let i = text.indexOf('SKILL.md'); i !== -1; i = text.indexOf('SKILL.md', i + 1)) {
        const s = text.lastIndexOf('\n', i) + 1; let e = text.indexOf('\n', i); if (e === -1) e = text.length;
        const line = text.slice(s, e); i = e; // jump to the next line
        // Real reads are tool calls (Codex records shell reads as custom_tool_call / function_call / local_shell_call).
        // Skill LISTINGS (developer messages, world_state, compactions) mention SKILL.md too but are not usage.
        if (!/"type":"(custom_tool_call|function_call|local_shell_call)"/.test(line)) continue;
        for (const m of line.matchAll(re)) seen.add(m[1]);
      }
      cache[f] = { size, names: [...seen] }; dirty = true;
    }
    covered += size; scanned++;
    for (const n of seen) if (names.has(n)) used.set(n, (used.get(n) || 0) + 1);
  }
  if (dirty) { try { await mkdir(path.dirname(cacheFile), { recursive: true }); await writeFile(cacheFile, JSON.stringify(cache)); } catch {} }
  return { used, scanned, megabytes: Math.round(covered / 1e6), totalSessions: files.length };
}

export async function assessCodex({ budgetMB = 150 } = {}) {
  if (!existsSync(CODEX)) return null;
  const enabled = await enabledPlugins();
  const skills = await listSkills(enabled);
  const agents = []; try { const s = await stat(path.join(CODEX, 'AGENTS.md')); agents.push({ label: 'global AGENTS.md', tokens: Math.round(s.size / 4), heavy: s.size >= 6000 }); } catch {}
  const usage = await sampleUsage(new Set(skills.map((s) => s.name)), budgetMB * 1e6);
  const rows = skills.map((s) => ({ ...s, reads: usage?.used.get(s.name) || 0 })).sort((a, b) => b.tokens - a.tokens);
  // Per-source totals tell you which enabled plugin is the expensive one.
  const bySource = new Map(); for (const r of rows) { const b = bySource.get(r.source) || { source: r.source, key: r.key, tokens: 0, skills: 0, reads: 0 }; b.tokens += r.tokens; b.skills++; b.reads += r.reads; bySource.set(r.source, b); }
  const sources = [...bySource.values()].sort((a, b) => b.tokens - a.tokens);
  const unusedSources = usage ? sources.filter((s) => s.reads === 0 && s.tokens >= 150) : [];
  return { skillCount: skills.length, totalTokens: rows.reduce((a, r) => a + r.tokens, 0), enabledPlugins: [...enabled.on], disabledPlugins: [...enabled.off], agents,
    usage: usage && { scanned: usage.scanned, megabytes: usage.megabytes, totalSessions: usage.totalSessions }, sources, rows, unusedSources,
    unusedTokens: unusedSources.reduce((a, s) => a + s.tokens, 0) };
}
