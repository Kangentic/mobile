---
description: Review and update documentation to match current source code
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Agent
---

# Sync Docs

Review and update `docs/` to match the current source code. This skill contains the
source-to-doc mapping, anchor point definitions, doc conventions, and the executable workflow
for keeping documentation in sync. It is adapted from the desktop `kangentic` repo's sync-docs
flow.

## Source-to-Doc Mapping

Each doc file and the source files that are its authority:

| Doc | Primary Source Files |
|-----|---------------------|
| `architecture.md` | `src/channel/**`, `src/state/**`, `src/screens/**`, `app.config.*`, the pinned `@kangentic/protocol` version |
| `security.md` | `src/pairing/**`, `src/channel/**`, `src/notifications/**` |
| `developer-guide.md` | `package.json` (scripts), `eas.json`, `.maestro/`, `tests/` |
| `docs/README.md` | All other docs (index) |

## Doc Conventions

- Flat structure in `docs/`, no subdirectories.
- Each doc has a clear H1 title and opening paragraph stating purpose.
- Cross-reference other docs with relative links (`[Title](filename.md)`).
- Technical docs include "See Also" sections at the bottom.
- No emojis.
- Tables for structured data.
- Code blocks for CLI commands and file structures.
- ` - ` separators, never em-dashes or `--`.

## When to Create a New Doc

- A new major subsystem is added (new top-level directory under `src/`).
- An existing doc exceeds ~500 lines and covers two distinct topics.

## When to Delete a Doc

- The subsystem it documents has been removed entirely.
- Its content has been fully merged into another doc.
- Always update `docs/README.md` and the root `README.md` when adding/removing.

## Anchor Points

Anchors are enumerable source-code structures that must be exhaustively listed in docs. A
mechanical audit (the `doc-auditor` agent) counts items in source, counts items in docs, and
reports the diff. The source files below now exist, so this is a live check; a handful of
individual anchors whose source is genuinely not written yet stay forward-looking until it lands.

| Anchor | What to extract | Source file(s) | Target doc | WHY |
|--------|------------------|-----------------|------------|-----|
| Capability verb list | All **ten** capability verbs (`read-stream`, `read-board`, `read-diff`, `send-user-message`, `move-task`, `answer-permission-prompt`, `interactive-terminal`, `board-tool-read`, `board-tool-write`, `register-push`). Count them from the source rather than this cell: it listed only the first six for a while, which silently narrowed what the auditor checked | `@kangentic/protocol`'s `CAPABILITY_VERBS` (consumed via `src/channel/capabilityClient.ts`, never redeclared locally - see `protocol-types-from-package.md`) | architecture.md (canonical); security.md (cross-reference only) | The protocol's entire authorization surface; drift here is a security-relevant gap, not just a docs gap. |
| Key-storage inventory | Every secret stored via `expo-secure-store` (identity key, per-pairing key, push-decrypt key, ExponentPushToken) | `src/pairing/**`, `src/notifications/**` | security.md | The key-storage rule (`secure-storage.md`) is only auditable if the inventory is complete. |
| Notification categories | The set of push notification categories and their placeholder copy | `src/notifications/categoryCopy.ts`, `src/notifications/channels.ts` | architecture.md | Push privacy claims in security.md depend on an accurate category list. |
| Test-tier commands | The exact `npm run`/`npx` command for each test tier | `package.json` scripts | developer-guide.md | Stale commands break the getting-started flow for new contributors. |
| EAS profile names | All **four** profile names: `development`, `preview`, `e2e`, `production`. Read them from `eas.json` rather than this cell, which omitted `e2e` for a while | `eas.json` | developer-guide.md | Contributors reference these by name when running `eas build`, and CI resolves them through `scripts/easProfile.mjs`. |

## Workflow

### Step 1 - Scope Detection

1. Check for unpushed commits: `git log origin/HEAD..HEAD --name-only --pretty=format:""`.
2. If none, diff against the latest release tag: `git describe --tags --abbrev=0`, then
   `git diff --name-only <tag>..HEAD`.
3. Filter to source files (exclude `docs/`, `.claude/`, `tests/`).
4. Map changed source files to affected docs using the Source-to-Doc Mapping above.
5. If no source files changed, report "No source changes detected - skipping doc review" and
   stop.

With `src/` now populated, this step routinely finds matching source-file changes; the mechanical
anchor audit (Step 2) and the prose-audit pass (Step 3) both carry real weight.

### Step 2 - Anchor Point Verification

This is the **canonical anchor source list**. `/sync-docs`, `/pull-request`,
`/merge-pull-request`, and `/merge-back` all consult this list rather than duplicating it.

If any anchor source files appear in the changed-file list, spawn a `doc-auditor` agent with
that list. The agent returns a structured gap report. If a listed anchor's source file does not
exist yet, the agent reports "source not yet present" rather than a false gap.

### Step 3 - Prose Audit

For each affected doc: read it, read the source files it references, and check for prose
staleness (changed behavior, stale defaults, renamed parameters, new/removed CLI flags).

### Step 4 - Update Pass

Fix anchor gaps and prose staleness. Update cross-references and `docs/README.md` if docs were
added or removed. Constraints: only edit files in `docs/` and the README's Documentation
section; never modify source, tests, or config; respect the single-command Bash rule.

### Step 5 - Feature Summary

Once releases exist: find the latest tag, list `feat:`/`feat!:` commits since it, check whether
each appears in the docs, and document any gap in the appropriate doc per the mapping above.

### Step 6 - Structural Review

Verify internal links resolve, `docs/README.md` lists every doc, the root README's
Documentation section is current, and flag any doc over 500 lines.

### Step 7 - Report

Summarize: anchor audit results, prose updates, docs created/deleted, feature documentation
added, items needing human review, or "No changes needed."
