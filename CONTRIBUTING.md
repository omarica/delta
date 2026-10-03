# Contributing to Delta

Thanks for helping. The most valuable contributions are small, data-only changes.

## Quick setup

```bash
git clone https://github.com/omarica/delta && cd delta
node tests/security.mjs     # 21 checks, no network
node tests/skills.mjs       # 29 checks, a few use the network
```

Node 20+. There are **no dependencies and no build step**; please keep it that way.

## Easiest ways to help

| I want to... | Edit |
|---|---|
| Add a feature tip ("try `/goal`") | [`tips.json`](tips.json): `id`, `tool`, `title`, `try` (a copy-paste command), `why`, `keywords` (regex matched against changelog lines), `detect` (how to tell the user already uses it) |
| Warn about hype or a risky tool | [`curated.json`](curated.json): give it an `expires` date so notes don't go stale |
| Skip off-topic skills or trust a vendor | [`skills/delta/skills.config.mjs`](skills/delta/skills.config.mjs) |
| Improve stack detection or recommendations | [`skills/delta/stack.json`](skills/delta/stack.json) |
| Watch another repo for releases | [`sources.json`](sources.json) |

Every tip must carry an action. If it cannot say what to do, it does not ship.

## Code changes

Before opening a PR:

1. Run **both** test suites and keep them green.
2. **Anything that came from the internet is hostile.** Validate identifiers, never build a command from remote text, and pass displayed text through `defang()` in [`safe.mjs`](skills/delta/safe.mjs). If you add a new data source, add a test with a hostile input to `tests/security.mjs`.
3. Never add a model API key requirement. Delta must work with whatever login the user already has.
4. Be honest in output: label estimates as estimates, and never print a "0" that means "unknown".
5. If you touch ranking, say what real data you checked it against.

## Reporting a problem

Open an issue with the command you ran, the output (remove anything private), and your OS. For security issues see [SECURITY.md](SECURITY.md) instead of opening a public issue.
