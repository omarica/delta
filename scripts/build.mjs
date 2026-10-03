// Builds docs/feed.json, docs/feed.xml and docs/index.html. Zero dependencies, no LLM, no API keys.
// Usage: node scripts/build.mjs   (set GITHUB_TOKEN to raise the GitHub rate limit)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async (f) => JSON.parse(await readFile(path.join(ROOT, f), 'utf8'));
const cfg = await read('sources.json');
const tips = await read('tips.json');
const curated = await read('curated.json');

const now = Date.now();
const DAY = 86400000;
const ageDays = (iso) => Math.max(0, (now - new Date(iso).getTime()) / DAY);
const headers = { 'User-Agent': 'delta', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function getJson(url, h = headers) {
  const r = await fetch(url, { headers: h });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function safe(label, fn) {
  try { return await fn(); } catch (e) { console.warn(`[skip] ${label}: ${e.message}`); return []; }
}

const tipFor = (text) => tips.find((t) => new RegExp(t.keywords, 'i').test(text));
const items = [];

// 1. Claude Code changelog "Added" lines from recent versions, matched to tips.
async function claudeChangelog() {
  const { repo, file } = cfg.claudeCodeChangelog;
  const [rels, md] = await Promise.all([
    getJson(`https://api.github.com/repos/${repo}/releases?per_page=12`),
    fetch(`https://raw.githubusercontent.com/${repo}/main/${file}`).then((r) => r.text()),
  ]);
  const dates = Object.fromEntries(rels.map((r) => [r.tag_name.replace(/^v/, ''), r.published_at]));
  const out = [];
  for (const sec of md.split(/^## /m).slice(1, 13)) {
    const ver = sec.match(/^(\d+\.\d+\.\d+)/)?.[1];
    const date = dates[ver];
    if (!ver || !date || ageDays(date) > cfg.windowDays) continue;
    for (const line of sec.split('\n').filter((l) => /^- Added /.test(l))) {
      const text = line.replace(/^- /, '').replace(/\s*\(anthropics\/claude-code#\d+\)/g, '');
      const tip = tipFor(text);
      let score = 40;
      if (tip && !/\$\./.test(text)) score += 15;
      if (/^Added (a )?(new )?(built-in )?(`\/[a-z-]+`|`claude [a-z-]+`)/.test(text)) score += 15; // new command
      if (/Claude (Opus|Sonnet|Fable|Haiku) \d|now the default|new default/i.test(text)) score += 35; // model news
      if (/\bClaude Mods\b|\bbuilt-in mod\b|\bdynamic workflows?\b|\bagent view\b/i.test(text)) score += 25; // headline features
      if (/\bplugin|skill|hook|MCP|subagent|\/usage|spend/i.test(text)) score += 8;
      // Trivia: admin/enterprise plumbing, keybindings, telemetry, accessibility, internal APIs.
      if (/gateway|managed|telemetry|OpenTelemetry|OAuth|certificate|keybinding|screen reader|mouse|filter|environment variable|\$\.|private_key|allowedProviders|\.mcpb|--config/i.test(text)) score -= 25;
      score -= ageDays(date) * 2;
      out.push({
        id: `cc-${ver}-${out.length}`, kind: 'new', tool: 'Claude Code', date,
        title: text.replace(/^Added /, '').slice(0, 160),
        action: tip ? `Try: ${tip.try}` : (/^Added (?:an? |the )?(?:new )?(?:built-in )?`\/[a-z-]+`/.test(text) ? `Try: ${text.match(/`(\/[a-z-]+)`/)[1]}` : null),
        why: tip ? tip.why : `Added in v${ver}.`,
        url: `https://github.com/${repo}/releases/tag/v${ver}`,
        tipId: tip?.id ?? null, score,
      });
    }
  }
  return out;
}

// 2. Stable release headline for each watched repo (Codex, plugins...).
async function releases() {
  const out = [];
  for (const { repo, tool, stableOnly } of cfg.releases) {
    if (repo === cfg.claudeCodeChangelog.repo) continue; // covered line-by-line above
    const rels = await safe(repo, () => getJson(`https://api.github.com/repos/${repo}/releases?per_page=20`));
    const rel = rels.find((r) => !r.draft && (!stableOnly || !r.prerelease));
    if (!rel || ageDays(rel.published_at) > cfg.windowDays) continue;
    const bullets = (rel.body || '').split('\n').filter((l) => /^- /.test(l))
      .map((l) => l.replace(/^- /, '').replace(/\s*\(#\d+(, #\d+)*\)\s*$/, ''));
    const feats = (rel.body || '').split(/^## /m).find((s) => /^New Features/i.test(s));
    const top = (feats ? feats.split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).replace(/\s*\(#.*\)$/, '')) : bullets).slice(0, 3);
    out.push({
      id: `rel-${repo}-${rel.tag_name}`, kind: 'new', tool, date: rel.published_at,
      title: `${tool} ${rel.name || rel.tag_name}: ${top[0] || 'new release'}`.slice(0, 180),
      action: null,
      why: top.slice(1).join(' · ') || 'See release notes.',
      url: rel.html_url, score: 55 - ageDays(rel.published_at) * 2 + (top.length ? 5 : 0),
    });
  }
  return out;
}

// 3. Hacker News stories (free Algolia API), filtered by points.
async function hn() {
  const since = Math.floor((now - cfg.windowDays * DAY) / 1000);
  const seen = new Set(); const out = [];
  for (const q of cfg.hn.queries) {
    const j = await safe(`hn ${q}`, () => getJson(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${since},points>${cfg.hn.minPoints}&hitsPerPage=8`, {}));
    for (const h of j.hits || []) {
      if (seen.has(h.objectID) || !/claude|codex|anthropic|openai|agent|MCP|skills?|LLM|copilot|cursor/i.test(h.title)) continue; seen.add(h.objectID);
      out.push({
        id: `hn-${h.objectID}`, kind: 'news', tool: 'Community', date: h.created_at,
        title: h.title, action: null,
        why: `${h.points} points, ${h.num_comments} comments on Hacker News.`,
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        score: 10 + Math.min(h.points / 5, 50) + Math.min(h.num_comments / 15, 12)
          - (/^Show HN/.test(h.title) && h.points < 200 ? 20 : 0) - ageDays(h.created_at),
      });
    }
  }
  return out;
}

// 4. Hand-curated notes (warnings, "skip this"), with expiry dates.
const curatedItems = curated.filter((c) => new Date(c.expires) > now).map((c) => ({
  id: c.id, kind: c.kind, tool: c.tool, date: new Date(c.date).toISOString(),
  title: c.title, action: c.action, why: c.why, url: c.url, score: 62,
}));

items.push(...await safe('claude changelog', claudeChangelog), ...await releases(), ...await hn(), ...curatedItems);

// Rank, then pick with a per-kind cap so one source cannot flood the brief.
if (process.env.DEBUG_ALL) for (const i of [...items].sort((a,b)=>b.score-a.score)) console.log(Math.round(i.score), i.kind, i.tool, i.title.slice(0,100));
items.sort((a, b) => b.score - a.score);
const picked = []; const perKind = {}; const perTip = new Set();
for (const it of items) {
  if (picked.length >= cfg.maxItems) break;
  if ((perKind[`${it.kind}:${it.tool}`] || 0) >= cfg.maxPerKind) continue;
  if (it.tipId && perTip.has(it.tipId)) continue;
  perKind[`${it.kind}:${it.tool}`] = (perKind[`${it.kind}:${it.tool}`] || 0) + 1;
  if (it.tipId) perTip.add(it.tipId);
  picked.push(it);
}

const generated = new Date().toISOString();
const clean = ({ score, ...r }) => ({ ...r, score: Math.round(score) });
const pickedIds = new Set(picked.map((p) => p.id));
const more = items.filter((i) => !pickedIds.has(i.id) && i.score >= (cfg.moreMinScore ?? 25)).slice(0, cfg.maxMore ?? 12);
const feed = { generated, window_days: cfg.windowDays, items: picked.map(clean), more: more.map(clean) };
await mkdir(path.join(ROOT, 'docs'), { recursive: true });
await writeFile(path.join(ROOT, 'docs/feed.json'), JSON.stringify(feed, null, 2));
await writeFile(path.join(ROOT, 'docs/tips.json'), JSON.stringify(tips, null, 2));

const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const label = { new: 'NEW', news: 'NEWS', stop: 'SKIP', tip: 'TIP' };

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Delta</title><id>urn:delta</id><updated>${generated}</updated>
${feed.items.map((i) => `<entry><id>urn:delta:${esc(i.id)}</id><title>[${label[i.kind] || i.kind}] ${esc(i.title)}</title><link href="${esc(i.url)}"/><updated>${i.date}</updated><content type="html">${esc(`<p>${esc(i.action || '')}</p><p>${esc(i.why)}</p>`)}</content></entry>`).join('\n')}
</feed>`;
await writeFile(path.join(ROOT, 'docs/feed.xml'), xml);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delta</title><link rel="alternate" type="application/atom+xml" href="feed.xml">
<style>:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--card:#f5f5f4;--acc:#b4531f}@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eee;--mut:#9a9a96;--card:#222220;--acc:#e8935a}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0}.sub{color:var(--mut);margin:4px 0 24px}article{background:var(--card);border-radius:10px;padding:14px 16px;margin:0 0 12px}
.tag{font:600 11px/1 system-ui;color:var(--acc);letter-spacing:.06em}a{color:inherit}h2{font-size:1.02rem;margin:6px 0}
.act{margin:6px 0;font-family:ui-monospace,monospace;font-size:.88rem}summary{cursor:pointer;color:var(--mut);margin:16px 0 10px}.why{color:var(--mut);margin:4px 0 0;font-size:.92rem}</style></head><body>
<h1>Delta</h1><p class="sub">${feed.items.length} things worth your attention · ${generated.slice(0, 10)} · <a href="feed.xml">RSS</a> · <a href="feed.json">JSON</a></p>
${feed.items.map((i) => `<article><span class="tag">${label[i.kind] || i.kind} · ${esc(i.tool)}</span><h2><a href="${esc(i.url)}">${esc(i.title)}</a></h2>${i.action ? `<p class="act">${esc(i.action)}</p>` : ''}<p class="why">${esc(i.why)}</p></article>`).join('\n') || '<p>Nothing worth your attention today.</p>'}
${feed.more.length ? `<details><summary>More this week (${feed.more.length})</summary>${feed.more.map((i) => `<article><span class="tag">${label[i.kind] || i.kind} · ${esc(i.tool)}</span><h2><a href="${esc(i.url)}">${esc(i.title)}</a></h2><p class="why">${esc(i.why)}</p></article>`).join('')}</details>` : ''}
<p class="sub">Personalize it: run the <code>/delta</code> skill to compare this feed with your own setup.</p></body></html>`;
await writeFile(path.join(ROOT, 'docs/index.html'), html);
console.log(`built ${feed.items.length} items from ${items.length} candidates`);
for (const i of feed.items) console.log(`  [${i.kind}] ${i.score} ${i.title.slice(0, 90)}`);
