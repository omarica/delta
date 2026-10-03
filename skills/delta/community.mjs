// Matches community plugins/skills (docs/community.json, built daily by scripts/discover.mjs) to THIS user.
// Local only: compares published candidate metadata with your detected stack and installed tools.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const GENERIC = new Set(['react', 'typescript', 'python', 'llm-app', 'data', 'docker', 'tailwind', 'mobile', 'go', 'rust', 'rag']);

async function load(src) {
  if (/^https?:/.test(src)) return (await fetch(src, { signal: AbortSignal.timeout(20000) })).json();
  return JSON.parse(await readFile(src, 'utf8'));
}

// The feed may come from a remote URL, so treat every field as untrusted. Names must be plain identifiers,
// commands are REBUILT here from validated fields (the feed's own `installs` strings are ignored), text is stripped of control chars.
const SAFE = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const clean = (s, n = 220) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function validInstalls(it) {
  if (it.marketplace) return [`claude plugin marketplace add ${it.repo}`, `claude plugin install ${it.plugin}@${it.marketplace}`];
  if (it.kind === 'plugin') return [`git clone https://github.com/${it.repo}   # then run: claude --plugin-dir <path>`];
  return [`Copy the skill folder(s) you want from https://github.com/${it.repo} into ~/.claude/skills/`];
}
const isValid = (it) => it && SAFE_REPO.test(it.repo || '') && SAFE.test(it.plugin || '') && (!it.marketplace || SAFE.test(it.marketplace))
  && Array.isArray(it.tags) && Array.isArray(it.capabilities) && Number.isFinite(it.trust) && Number.isFinite(it.stars);

export async function matchCommunity({ HERE, src, stackTags, installedNames, max = 4, includeLow = false }) {
  const cfg = JSON.parse(await readFile(path.join(HERE, 'stack.json'), 'utf8'));
  const data = await load(src);
  const have = installedNames.map((n) => n.toLowerCase());
  const lacks = Object.entries(cfg.capabilities)
    .filter(([, c]) => !have.some((n) => new RegExp(c.have, 'i').test(n))).map(([k]) => k);
  const userTags = Object.keys(stackTags);
  const scored = [];
  for (const it of data.items) {
    if (!isValid(it) || it.trust < 55) continue;
    if (have.some((n) => n === it.plugin.toLowerCase() || n === it.repo.split('/')[1].toLowerCase())) continue; // already have it
    // A tag only counts if you do not already have tooling for that technology (no 5th Supabase plugin, no 2nd Playwright tool).
    const hits = it.tags.filter((t) => userTags.includes(t) && !have.some((n) => n.includes(t.replace(/[^a-z0-9]/g, ''))));
    const gaps = it.capabilities.filter((c) => lacks.includes(c));
    const specific = hits.filter((t) => !GENERIC.has(t));
    if (!gaps.length && !specific.length) continue; // generic tags alone (react, python, typescript...) are not a reason to install anything
    const fit = Math.min(42, specific.length * 14 + (hits.length - specific.length) * 6) + (gaps.length ? 18 : 0);
    // Token budget: every skill/agent a plugin ships is loaded into EVERY session. Heavy plugins must earn it (up to -35 points).
    const est = Number.isFinite(it.estTokens) ? it.estTokens : null;
    const score = fit * 0.6 + it.trust * 0.4 + Math.log10(it.stars + 1) * 2 + (it.isNew ? 4 : 0) + Math.min(6, (it.starsDelta || 0) / 200)
      - (est !== null ? Math.min(35, est / 150) : 10); // unknown size is not free: assume a moderate cost
    const why = [];
    if (gaps.length) why.push(`fills a gap: you have no ${gaps.slice(0, 2).join(' / ')} tool`);
    if (hits.length) why.push(`fits your stack: ${hits.slice(0, 3).join(', ')} (${[...new Set(hits.flatMap((t) => stackTags[t] || []))].slice(0, 3).join(', ')})`);
    // Keyword matching is noisy, so only a standalone, well-established plugin with a real reason earns "high" confidence.
    const experimental = /\b(beta|alpha|experimental|diagnostic|probe|wip|cowork)\b/i.test(`${it.plugin} ${it.description}`);
    const confidence = !experimental && !it.aggregator && it.trust >= 70 && it.stars >= 1000 && (gaps.length || specific.length) ? 'high' : 'low';
    scored.push({ ...it, score, confidence, why: why.join('; ') });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set(); const picks = []; let hidden = 0;
  for (const s of scored) {
    if (seen.has(s.repo)) continue; seen.add(s.repo);
    if (s.confidence !== 'high' && !includeLow) { hidden++; continue; }
    picks.push(s); if (picks.length >= max) break;
  }
  return { generated: data.generated, candidates: data.count, lacks, hiddenLowConfidence: hidden, picks: picks.map((p) => ({ confidence: p.confidence,
    plugin: p.plugin, repo: p.repo, url: `https://github.com/${p.repo}`, kind: p.kind, description: clean(p.description), stars: p.stars, trust: p.trust,
    license: clean(p.license, 30), pushedDaysAgo: p.pushedDaysAgo, ageDays: p.ageDays, risk: { hooks: !!p.risk?.hooks, mcp: !!p.risk?.mcp, scripts: !!p.risk?.scripts },
    estTokens: Number.isFinite(p.estTokens) ? p.estTokens : null, components: p.components || null,
    why: p.why, installs: validInstalls(p), isNew: !!p.isNew, starsDelta: Number.isFinite(p.starsDelta) ? p.starsDelta : null })) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Landscape: what is popular and rising in general, per category, and how each item fits THIS user.
const CATS = { memory: 'Memory and continuity', context: 'Context and token savings', planning: 'Planning and workflow', review: 'Code review', security: 'Security',
  testing: 'Testing', design: 'UI and design', docs: 'Docs and library knowledge', git: 'Git and PRs', debugging: 'Debugging', agents: 'Multi-agent orchestration' };

export async function landscape({ HERE, src, stackTags, installedNames, displayNames = null, buzz = null, perCategory = 2, risingCount = 6 }) {
  const cfg = JSON.parse(await readFile(path.join(HERE, 'stack.json'), 'utf8'));
  const data = await load(src);
  const have = installedNames.map((n) => n.toLowerCase());
  const userTags = Object.keys(stackTags);
  const buzzFor = (it) => buzz?.mentions.find((m) => m.repo === it.repo || (m.name && m.name.toLowerCase() === it.plugin.toLowerCase())) || null;
  const shown = (displayNames || installedNames).map((n) => n.toLowerCase());
  const owned = (cap) => [...new Set(shown.filter((n) => new RegExp(cfg.capabilities[cap].have, 'i').test(n)))].slice(0, 4);
  const valid = data.items.filter((it) => isValid(it) && it.trust >= 55 && !/\b(beta|alpha|experimental|diagnostic|probe|wip|cowork)\b/i.test(`${it.plugin} ${it.description}`));

  const fit = (it, cap) => {
    const alreadyHave = have.some((n) => n === it.plugin.toLowerCase() || n === it.repo.split('/')[1].toLowerCase());
    const mine = cap ? owned(cap) : [];
    const hits = it.tags.filter((t) => userTags.includes(t) && !have.some((n) => n.includes(t.replace(/[^a-z0-9]/g, '')))).filter((t) => !GENERIC.has(t));
    const est = Number.isFinite(it.estTokens) ? it.estTokens : null;
    const cheap = est === null ? false : est <= 1500;
    if (alreadyHave) return { verdict: 'HAVE', why: 'you already have it' };
    if (cap && mine.length) return { verdict: 'SKIP', why: `overlaps with what you have (${mine.join(', ')})` };
    if (cap && !mine.length) return { verdict: it.trust >= 70 && !it.aggregator && cheap ? 'CONSIDER' : 'WATCH', why: `fills a gap: you have no ${cap} tool${est === null ? ', cost unknown' : cheap ? '' : ', but it is heavy'}` };
    if (hits.length) return { verdict: it.trust >= 70 && !it.aggregator && cheap ? 'CONSIDER' : 'WATCH', why: `fits your stack: ${hits.slice(0, 3).join(', ')}` };
    return { verdict: 'FYI', why: 'general-purpose, not tied to your stack' };
  };
  const pack = (it, cap) => ({ plugin: it.plugin, repo: it.repo, inMarketplace: !!it.aggregator, stars: it.aggregator ? null : it.stars, trust: it.trust, license: clean(it.license, 30), ageDays: it.ageDays, pushedDaysAgo: it.pushedDaysAgo,
    description: clean(it.description, 140), estTokens: Number.isFinite(it.estTokens) ? it.estTokens : null, aggregator: !!it.aggregator, risk: it.aggregator ? { hooks: false, mcp: false, scripts: false } : { hooks: !!it.risk?.hooks, mcp: !!it.risk?.mcp, scripts: !!it.risk?.scripts },
    installs: validInstalls(it), buzz: (() => { const b = buzzFor(it); return b ? { count: b.count, reach: b.reach, sources: Object.keys(b.sources || {}) } : null; })(), ...fit(it, cap) });

  const categories = [];
  for (const [cap, label] of Object.entries(CATS)) {
    const pool = valid.filter((it) => it.capabilities.includes(cap)).map((it) => {
      const b = buzzFor(it); const est = Number.isFinite(it.estTokens) ? it.estTokens : 600;
      return { it, score: it.trust * 0.5 + (it.aggregator ? 0 : Math.log10(it.stars + 1) * 8) - est / 200 - (it.aggregator ? 18 : 0) + (b ? Math.min(10, Math.log10(b.reach + 1) * 2) : 0) };
    }).sort((a, b) => b.score - a.score);
    const seen = new Set(); const top = [];
    for (const { it } of pool) { if (seen.has(it.repo)) continue; seen.add(it.repo); top.push(pack(it, cap)); if (top.length >= perCategory) break; }
    categories.push({ id: cap, label, youHave: owned(cap), top });
  }
  const rising = valid.filter((it) => it.ageDays <= cfg.community.risingWithinDays && it.stars >= cfg.community.risingMinStars && it.trust >= 45 && !it.aggregator)
    .map((it) => ({ it, v: it.stars / Math.max(10, it.ageDays) })).sort((a, b) => b.v - a.v);
  const seenR = new Set(); const risingOut = [];
  for (const { it, v } of rising) { if (seenR.has(it.repo)) continue; seenR.add(it.repo); const cap = it.capabilities.find((c) => CATS[c]); risingOut.push({ ...pack(it, cap || null), starsPerDay: Math.round(v) }); if (risingOut.length >= risingCount) break; }
  return { generated: data.generated, repos: new Set(data.items.map((i) => i.repo)).size, plugins: data.count, categories, rising: risingOut };
}
