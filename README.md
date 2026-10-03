# Delta

A free, low-noise daily delta for developers using Claude Code, Codex and friends, plus a local skill that compares it with **your own setup** and tells you what to change.

AI coding tools ship almost daily (Claude Code releases a version a day; Codex every few hours). Changelogs are too long and newsletters are generic. This does two things:

1. **Public feed (daily, no LLM, no API keys).** A GitHub Action pulls Claude Code changelog lines, Codex/plugin releases and relevant Hacker News posts, ranks them with a fixed rule, keeps at most 5, and publishes a page, `feed.xml` (RSS/Atom) and `feed.json`. Every item says what to do: **TRY**, **SWAP**, **SKIP** or **CONFIG**.
2. **`/delta` skill (local).** Reads your `~/.claude` and `~/.codex` setup and your slash-command *names* (never prompt text), then shows only what applies to you: features you have never used, habits worth changing, overlapping plugins. Nothing leaves your machine.

## Use it

```bash
git clone <this repo> && cd delta
node scripts/build.mjs                # build the feed locally (set GITHUB_TOKEN for rate limits)
node skills/delta/gaps.mjs         # your personal delta in the terminal
```

Install the skill in Claude Code: copy `skills/delta/` to `~/.claude/skills/delta/`, set `DELTA_FEED_URL` to your published `feed.json`, then run `/delta`.

## Publish your own

1. Fork, then enable GitHub Pages from the `/docs` folder (Settings → Pages).
2. The workflow in `.github/workflows/daily.yml` rebuilds daily and commits `docs/`.
3. Subscribe to `https://<you>.github.io/delta/feed.xml` in any RSS reader.

## Tune it

| File | What it controls |
|---|---|
| `sources.json` | Repos to watch, HN queries, window, max items |
| `tips.json` | The tips library: feature → example command → how to detect you already use it |
| `curated.json` | Hand-written warnings and "skip this" notes, with expiry dates |
| `skills/delta/overlaps.json` | Plugin groups that duplicate each other |

The quality lever is `tips.json` and `curated.json`: the more good entries, the better the "what to do" lines. Pull requests welcome.

## Principles

- Max 5 items a day; "nothing today" is a valid result.
- Every item has an action, or it does not ship.
- Free forever: no paid APIs, no accounts, no tracking.
- Personalization is local-first.
