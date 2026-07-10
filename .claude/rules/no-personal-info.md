# Rule: no personal or machine-specific info in committed code

The repository is public. Hardcoded usernames, emails, or machine-specific absolute paths leak
personal data and break on other machines.

## The rule

Never hardcode personal or machine-specific values in committed code, tests, scripts, or docs:

- No personal usernames, emails, or home-directory paths (e.g. `C:\Users\alice`,
  `/Users/alice`). Use generic placeholders like `C:\Users\dev` in tests and examples.
- No machine-specific absolute paths. Derive paths at runtime (Expo's `FileSystem` document
  directory, env vars, `__dirname`) instead of hardcoding them.
- Keep all committed code environment-agnostic.

## Enforcement (self-maintaining)

- **Review (live now):** the `expo-rn-reviewer` agent flags hardcoded personal paths and email
  literals, and `/code-review` flags personal data generally.
- **Test (planned):** given the public-repo stakes, a scan for home-directory path patterns (a
  `C:\Users\<name>` other than `dev`, `/Users/<name>`, `/home/<name>`) and email literals is a
  strong candidate future test.

## Scope

All committed files. Does not apply to local-only, gitignored files (`CLAUDE.local.md`,
`.kangentic/`, `kangentic.local.json`, `.claude/settings.local.json`) or to a developer's own
machine config outside the repo. The maintainer GitHub handle allowlisted in
`.github/workflows/cla.yml` is a public project identity required by the CLA bot, not a
violation of this rule.
