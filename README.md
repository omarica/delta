# Delta

A free daily feed of what changed in Claude Code, Codex and the plugin ecosystem, plus a local `/delta` skill that audits **your own setup** and tells you what to change.

AI coding tools ship almost daily, and every plugin you install is loaded into the context of every session. Changelogs are too long, newsletters are generic, and nothing tells you what your setup is quietly costing you.

## What it does

1. **Public feed (daily, no LLM, no API keys).** A GitHub Action pulls Claude Code changelog lines, Codex and plugin releases and relevant Hacker News posts, ranks them with a fixed rule, and publishes a page, `feed.xml` and `feed.json`: the top 5 plus a "More this week" list. It also crawls GitHub for community plugins and skills (`docs/community.json`).
2. **`/delta` skill (local).** Audits this machine and answers four questions:

| Question | How it answers | Command it prints |
|---|---|---|
| **Where do my tokens go?** | Prices every enabled plugin with `claude plugin details`, attributes real usage to the projects where it happens (from your session transcripts), and finds heavy plugins that load everywhere but are used in one or two projects | `claude plugin disable X --scope user` then `claude plugin enable X --scope project` per project |
| **What am I missing?** | Detects your stack from project manifests (dependency names only), matches the live official marketplace, checks prerequisites (e.g. a language server binary), and flags plugins you already cover | `claude plugin install ...` |
| **Is the community offering something better?** | Crawled GitHub plugins and skills, scored for trust, priced in tokens, gated by confidence, with risk flags for hooks / MCP servers / install scripts | marketplace add + install |
| **Am I using my tools well?** | Features you have never used, habits (e.g. `/clear` vs `/compact`), overlapping plugins, heavy CLAUDE.md files | exact commands or settings |

Everything is local and read-only until you say yes to a specific change. Nothing leaves your machine except fetching the public catalogs.

**No API keys, ever.** Delta reads files on disk, so it works with however you use Claude Code or Codex: subscription, API key, desktop app or CLI. The only credential anywhere is the GitHub token that GitHub Actions provides automatically to the daily job (locally, an optional `gh` login just raises a rate limit).

**Claude Code and Codex are both audited.** For Codex it prices the skill list injected into every session (calibrated against a real injected list: 10,254 estimated vs 10,096 measured), shows which enabled plugin is the cost, samples your newest sessions for real skill reads, and prints the `config.toml` line to disable a plugin.

## Use it

```bash
git clone https://github.com/omarica/delta && cd delta
node scripts/build.mjs      # build the feed (set GITHUB_TOKEN to raise the rate limit)
node scripts/discover.mjs   # crawl community plugins/skills
node skills/delta/gaps.mjs  # your audit in the terminal  (--more, --community-all, --json)
```

Install the skill in Claude Code: copy `skills/delta/` to `~/.claude/skills/delta/`, add a `delta.config.json` with `{"home": "<path to your clone>"}` (or set `DELTA_FEED_URL` to a published `feed.json`), then run `/delta`.

## Publish your own

1. Fork, then enable GitHub Pages from the `/docs` folder (Settings → Pages).
2. `.github/workflows/daily.yml` rebuilds daily and commits `docs/`.
3. Subscribe to `https://<you>.github.io/delta/feed.xml` in any RSS reader.

## Tune it

| File | What it controls |
|---|---|
| `sources.json` | Repos to watch, HN queries, window, how many items |
| `tips.json` | Tips library: feature → example command → how to detect that you already use it |
| `curated.json` | Hand-written warnings and "skip this" notes, with expiry dates |
| `skills/delta/overlaps.json` | Plugin groups that duplicate each other |
| `skills/delta/stack.json` | Stack detection, curated recommendations (with prerequisites), community topics, capability keywords |

## Known limits (read these)

- **Usage is measured from the session transcripts that still exist** (the ledger prints how many sessions and since when). A plugin you use rarely can look unused, and savings are estimates.
- **Hook-based plugins can't be measured by use**, so Delta infers their projects from your dependencies.
- **Community picks are leads, not endorsements.** Matching is keyword-based. Only standalone, well-established plugins with a real reason show by default; the rest are hidden behind `--community-all`. Trust scores are heuristics, not a security audit.
- **Token costs of community plugins are estimates** (about 110 tokens per skill or agent), and hooks or MCP servers can inject more.
- **The tips library is hand-written and small.** Only part of each week's changelog gets a "Try" line. Contributions to `tips.json` are the best way to improve it.
- **Codex usage is a sample.** Codex session logs are huge (5 GB here), so each run scans up to 150 MB of new sessions, newest first, and caches the result per file; coverage grows every run. Skills that live inside a project (`.agents/skills`) are not attributed to that project.
- Without the `claude` CLI, Claude plugin costs fall back to estimates from plugin files (about 10% off).
- Reddit and X are not sources; only GitHub and Hacker News are.

## Safety

Community plugins are not vetted by Anthropic and run with your permissions. Names and descriptions from third-party repos are treated as untrusted: identifiers are validated, install commands are rebuilt locally, and control characters are stripped. The `/delta` skill reads a pick's hooks and MCP config and asks you again before installing anything.

## Principles

- A short list beats a long one; "nothing today" is a valid result.
- Every item carries an action, or it does not ship.
- Free forever: no paid APIs, no accounts, no tracking.
- Personalization is local-first.

MIT licensed.
