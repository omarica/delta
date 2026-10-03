<div align="center">

# Δ Delta

**Audit your AI coding setup. Cut wasted tokens, find the skills actually worth installing, and stay current.**

For Claude Code and Codex. Free, local-first, zero dependencies, no API keys.

[![Daily feed](https://github.com/omarica/delta/actions/workflows/daily.yml/badge.svg)](https://github.com/omarica/delta/actions/workflows/daily.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![API keys](https://img.shields.io/badge/API%20keys-none-brightgreen)

[**Live daily feed**](https://omarica.github.io/delta/) · [Quick start](#quick-start) · [What it does](#what-it-does) · [How it works](#how-it-works) · [Privacy & safety](#privacy-and-safety) · [FAQ](#faq)

</div>

---

## Why

Every plugin and skill you install adds its description to the context of **every** session, whether you use it or not. Meanwhile the ecosystem moves daily, "install these 5 plugins" videos get hundreds of thousands of views, and install counts are easy to fake. Nobody tells you what your own setup is quietly costing you, or which of the thousands of skills actually fit the libraries you use.

Delta reads the files already on your machine (settings, session history, project manifests), compares them with live public data, and tells you exactly what to change, with the command to do it.

On the author's own setup (all figures are estimates from recorded sessions):

| | Before | After |
|---|---|---|
| Claude Code plugin context loaded in a session outside the projects that use them | 13,689 tokens | **804 tokens** |
| Codex skill list loaded into every session | ~10,250 tokens | **~4,080 tokens** |
| Top "skill" by raw installs | 639,282 installs, **5 GitHub stars** | flagged as a likely install farm and dropped |

## What it does

Delta has two halves that work independently.

**1. A public feed** (a GitHub Action, daily, no LLM) that ranks what changed in Claude Code, Codex and the plugin ecosystem into a short list where every item carries an action. Live at **[omarica.github.io/delta](https://omarica.github.io/delta/)**, also as `feed.xml` (RSS/Atom) and `feed.json`.

**2. A local audit** (`/delta`, or run the scripts directly) that answers six questions about *your* setup:

| Question | How it answers | What you get |
|---|---|---|
| **Where do my tokens go?** | Prices every enabled plugin (`claude plugin details`), attributes real usage to the projects where it happens, finds heavy plugins loaded everywhere but used in one or two projects | Exact `disable` / `enable --scope` commands and the tokens saved |
| **What am I missing?** | Detects your stack from project manifests (dependency names only), matches the live official marketplace, checks prerequisites | `claude plugin install …` with the prerequisite first |
| **Which skills should I install?** | Deep search of the skills.sh registry using your dependencies, real install counts, GitHub reputation, install-farm detection, and a static scan of each real `SKILL.md` | Two ranked lists with a verdict per skill, plus a safe installer |
| **Is the community offering something better?** | Crawls GitHub for plugins and skills, scores trust, estimates token cost, flags hooks / MCP servers / install scripts | Leads to evaluate, never auto-installed |
| **What are people actually using?** | Reads your saved [`/last30days`](https://github.com/mvanhorn/last30days-skill) research (Reddit, X, YouTube, TikTok, HN) and extracts the tools people name | Popular and rising tools per category, with a verdict for your setup |
| **Am I using my tools well?** | Features you have never used, recent habits, overlapping plugins, heavy `CLAUDE.md` files, idle workflows | Exact commands or settings |

**Claude Code and Codex are both audited.** For Codex, Delta prices the skill list injected into every session, shows which enabled plugin is the cost, samples your newest sessions for real skill reads, and prints the `config.toml` line to disable a plugin.

## Quick start

**Requirements:** Node.js 20+. Optional: the `claude` / `codex` CLIs (without them Delta falls back to estimates and says so) and `gh` (only raises GitHub rate limits).

```bash
git clone https://github.com/omarica/delta && cd delta

node skills/delta/gaps.mjs      # audit your setup (a few seconds after the first run)
node skills/delta/skills.mjs    # deep skill search for your stack (first run ~8 min, cached for 24h)
```

Run it inside Claude Code as `/delta`:

```bash
# 1. Install the skill
cp -r skills/delta ~/.claude/skills/delta
# 2. Tell it where your clone is, so it can refresh the feed
echo '{"home": "/path/to/delta"}' > ~/.claude/skills/delta/delta.config.json
# 3. In a new Claude Code session
/delta
```

Delta **never changes anything on its own.** Every item is a suggestion with the exact command; you say yes to each one.

## See it work

> The blocks below show the shape of the output. Names and numbers are illustrative and will differ on your machine.

**Find skills worth installing for your stack:**

```text
$ node skills/delta/skills.mjs
profile: stack [nextjs, react, typescript, tailwind, supabase, stripe, ...], 60 dependency queries, 175 queries total

Skill search: 19,775 skills from 5,992 sources (175 queries run, 0 failed) -> 2331 candidates after integrity + domain filters
Dropped as likely install farms: 101-skills/superpowers/ai-video-generation (639,282 installs, 5 stars); ...

=== FOR LIBRARIES YOU USE (matched against your project dependencies) ===
 1.  109     31427   40177   915t  clean    *wshobson/agents/nextjs-app-router-patterns
      Master Next.js 14+ App Router with Server Components, streaming, parallel routes ...
      your dependency: next
 2.  107     18203   39665   219t  clean    *github/awesome-copilot/playwright-generate-test
      your dependency: @playwright/test

=== GENERAL WORKFLOW AND QUALITY ===
 1.  108    746747  275302   806t  clean    *mattpocock/skills/domain-modeling
```

Columns: score, installs, repo stars, size, scan verdict (`clean` / `REVIEW` / `BLOCK`), and `*` for a publisher that ships its own product.

**Install safely.** The first command is a dry run; nothing is written without `--confirm`:

```text
$ node skills/delta/skills.mjs --install mattpocock/skills/research
NOT INSTALLED  mattpocock/skills/research  @<pinned-commit>
  verdict: CLEAN  | 2 files, 1 KB | code files: none
  flags: none | instruction-like lines: 0
  dry run: read the report (and the skill), then re-run with --confirm

$ node skills/delta/skills.mjs --install getsentry/skills/security-review --confirm
NOT INSTALLED  getsentry/skills/security-review: "security-review" collides with a built-in command; choose another with --as <name>
```

**See where your tokens go** (illustrative, names changed):

```text
## Token ledger: 13,689 tokens of plugin context load at the start of EVERY session
Applying the changes below would cut that to ~4,673 (-9,016, 66%). Based on 120 recorded sessions.
- [SCOPE] big-seo-plugin: 4,873 tok/session, saves ~3,399 (used only in site-a, site-b; 70% of your sessions are elsewhere)
    claude plugin disable big-seo-plugin@market --scope user
    cd "~/code/site-a" && claude plugin enable big-seo-plugin@market --scope local
```

## Commands

| Command | Purpose |
|---|---|
| `node skills/delta/gaps.mjs` | The full audit. Flags: `--more`, `--community-all`, `--landscape-all`, `--json`, `--no-assess`, `--no-codex`, `--no-community`, `--no-landscape` |
| `node skills/delta/skills.mjs` | Deep skill search. Flags: `--refresh`, `--top N`, `--json`, `--no-profile` |
| `node skills/delta/skills.mjs --install <owner/repo/skill>` | Safe installer, **dry run**. Add `--confirm` to install, `--as <name>` to rename, `--roots claude,agents` to choose targets |
| `node skills/delta/buzz.mjs --ingest <file>` | Turn a saved `/last30days` run into named tools (optional) |
| `node scripts/build.mjs` | Build the public feed locally |
| `node scripts/discover.mjs` | Crawl community plugins and skills into `docs/community.json` |
| `node tests/security.mjs` · `node tests/skills.mjs` | Run the test suites (50 checks) |

## How it works

```text
 PUBLIC (GitHub Action, daily, free)                   LOCAL (your machine, read-only)
 ───────────────────────────────────                   ──────────────────────────────
 changelogs, releases, HN        ─┐                    ~/.claude + ~/.codex  (settings, plugins,
 GitHub topic search             ─┼─► scripts/        session history: tool names only)
 awesome lists + /last30days buzz ┘   build + discover  project manifests   (dependency names only)
                                       │                          │
                                       ▼                          ▼
                              docs/feed.json            skills/delta/gaps.mjs · skills.mjs
                              docs/community.json  ───►  compare, price, rank, scan
                              docs/feed.xml  (RSS)                │
                              GitHub Pages                        ▼
                                                    a short list of changes, each with an exact command,
                                                    applied only when you say yes
```

The skill search is its own pipeline:

```text
your dependencies ─► ~175 queries ─► skills.sh registry (installs)
      ─► GitHub reputation + install-farm check ─► relevance score
      ─► fetch the real SKILL.md ─► static scan ─► verdict  ─► (optional) pinned, no-overwrite install
```

## Privacy and safety

**Local-first.** Delta reads local files and downloads public catalogs. It uploads nothing.

| It reads | It never reads |
|---|---|
| Slash-command names, tool names and working directories from your session history | Prompt text, code, or conversation content |
| Dependency **names** from `package.json` / `requirements.txt` / `pyproject.toml` | Source code, `.env` files, credentials |
| Settings, plugin lists, skill folders, `CLAUDE.md` / `AGENTS.md` **sizes** | Secrets of any kind |

**No keys.** Delta needs no model API key and no account. The only credential in the project is the token GitHub Actions gives the daily job automatically. Locally, an optional `gh` login just raises a rate limit.

**Everything from the internet is treated as hostile.** Posts, READMEs, release notes and plugin descriptions can contain prompt injection, so:

- identifiers are validated (no `..`, no shell metacharacters) and install commands are **rebuilt locally**, never copied from a feed
- text that tries to address an AI assistant is removed and flagged
- links must be plain `https` to an allowlisted host
- names guessed from social posts are never promoted to installs or crawler seeds
- repos found only through awesome lists or posts start with lower trust
- the skill installer stages from a **pinned commit**, scans every file, refuses `BLOCK` findings, never overwrites, rejects path traversal and built-in names, and does nothing without `--confirm`

The prompt-injection filter is best-effort, because a pattern list cannot catch every phrasing, so it is one layer among several. Nothing is ever installed without your explicit yes. See [SECURITY.md](SECURITY.md).

## Accuracy and known limits

Honest numbers matter more than impressive ones.

- **Usage is measured from the session history that still exists** (the audit prints how many sessions and since when). A plugin you use rarely can look unused, and savings are estimates. Habits use a 60-day window so old workflows don't distort advice.
- **Token costs are estimates.** Claude plugin costs come from `claude plugin details` (exact); without the CLI they fall back to file-based estimates (about 10% off in testing). The Codex skill list estimate was within 2% of a real injected list.
- **Skill install counts are registry telemetry.** They are easy to inflate and undercount other install paths. Delta cross-checks against GitHub stars, vendor identity and pack uniformity, but it is a signal, not proof. Per-skill counts mostly measure the pack they belong to.
- **Coverage is the union of its queries**, not the whole registry, and skills are not A/B-tested against a no-skill baseline.
- **Community matches are leads.** Keyword matching is imperfect; only standalone, established plugins show by default (`--community-all` shows the rest).
- **Codex usage is a bounded sample** (session logs are huge). Coverage grows on every run.
- **Tested on Windows 11.** macOS and Linux should work but are not yet tested.
- The tips library is small and hand-written; most of each week's changelog gets no "Try" line yet.

## Configuration

Everything tunable is a plain file. Contributions welcome.

| File | Controls |
|---|---|
| [`sources.json`](sources.json) | Repos to watch, Hacker News queries, window, how many items |
| [`tips.json`](tips.json) | Tips library: feature → example command → how to detect that you already use it |
| [`curated.json`](curated.json) | Hand-written warnings and "skip this" notes, with expiry dates |
| [`skills/delta/stack.json`](skills/delta/stack.json) | Stack detection, curated recommendations (with prerequisites), community search topics |
| [`skills/delta/skills.config.mjs`](skills/delta/skills.config.mjs) | Skill-search queries, trusted vendors, off-domain filters |
| [`skills/delta/overlaps.json`](skills/delta/overlaps.json) | Plugin groups that duplicate each other |

## FAQ

<details><summary><b>Does it need an API key or a paid plan?</b></summary>

No. It reads files on disk, so it works however you run Claude Code or Codex (subscription, API, desktop, CLI).
</details>

<details><summary><b>Will it change my settings?</b></summary>

Never on its own. It prints the exact commands; you approve each one. The installer is a dry run unless you pass `--confirm`.
</details>

<details><summary><b>Why not just use <code>/doctor</code>, <code>/skill-doctor</code> or <code>/usage</code>?</b></summary>

Those inspect one tool at a point in time. Delta adds what they don't: which of your plugins are expensive *and* barely used *in which projects*, a Codex audit, a search across thousands of community skills matched to your dependencies, and a daily feed of what changed. It complements them.
</details>

<details><summary><b>Can I trust the install counts?</b></summary>

As a signal, not as proof. That is why Delta compares installs with GitHub stars, exempts vendors whose own CLIs install their skills, and drops anonymous accounts with tens of thousands of installs per star.
</details>

<details><summary><b>Does it work with only Codex, or only Claude Code?</b></summary>

Yes. Each side is audited independently; missing CLIs fall back to file-based estimates.
</details>

<details><summary><b>Why Node with no dependencies?</b></summary>

So it runs anywhere Node does, installs with <code>git clone</code>, and has no supply chain of its own to audit.
</details>

## Roadmap

- [ ] A/B-test shortlisted skills against a no-skill baseline with `claude plugin eval`
- [ ] Grow the tips library automatically from the changelog
- [ ] Codex project-level scoping and a Codex-side git guardrail
- [ ] macOS and Linux test coverage
- [ ] Optional weekly digest by email or RSS of *your* personal delta

## Contributing

Issues and pull requests are welcome. The highest-leverage contributions are small data changes: a tip in `tips.json`, a warning in `curated.json`, a vendor or off-domain term in `skills.config.mjs`. See [CONTRIBUTING.md](CONTRIBUTING.md). Please run both test suites first.

## License

[MIT](LICENSE)

## Acknowledgements

Built on public data from the [skills.sh](https://skills.sh) registry, the Claude Code changelog and the official plugin marketplace, GitHub's search API, and Hacker News (Algolia). The optional community-buzz layer reads research saved by [`/last30days`](https://github.com/mvanhorn/last30days-skill). Skills mentioned in examples belong to their authors.
