# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private reporting: **Security tab → Report a vulnerability** on this repository.

Include what you ran, what you expected, and what happened. You can expect an acknowledgement within a few days.

## What Delta is designed to defend against

Delta reads local files and downloads public data, then prints text that an AI assistant may read and commands a person may run. The threat model is therefore **hostile content from the internet**, not a hostile user.

| Threat | Mitigation |
|---|---|
| Prompt injection in posts, READMEs, release notes, plugin or skill descriptions | Text that addresses an assistant is removed and flagged; displayed text is normalised and length-limited; the skill's instructions forbid following directions found in feed text |
| Command injection through plugin, marketplace or skill names | Identifiers are validated (no `..`, no shell metacharacters); install commands are rebuilt locally from validated fields and are never copied from a feed |
| Cache poisoning of the plugin catalog | Caches live in a user-owned folder, and cached data is re-validated on read |
| Name squatting and lookalike repositories | A name alone is never promoted to an install or a crawler seed; guesses need an exact name, large star dominance and age, and stay display-only |
| Install farms and inflated popularity | Installs are cross-checked against GitHub stars, vendor identity and pack uniformity |
| Malicious or mutable skills | The installer stages from a pinned commit, scans every file, refuses high-severity findings, never overwrites, rejects path traversal and built-in names, and requires `--confirm` |
| Misleading links | Links must be plain `https` to an allowlisted host (no userinfo, port or punycode) |

## Known limits

- The prompt-injection filter is a pattern list and is **best-effort**. It is one layer; the others are that untrusted text is data, commands are rebuilt locally, and nothing is installed without an explicit yes.
- A skill or plugin you install runs with your permissions. Delta's scan is static and cannot prove a skill is safe. Read what you install.
- Registry install counts can be manipulated; treat them as a signal.

## Scope

In scope: this repository's scripts, the skill, the generated feed and the installer. Out of scope: vulnerabilities in third-party plugins or skills that Delta merely lists (report those to their authors).
