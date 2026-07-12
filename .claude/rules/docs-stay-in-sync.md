---
paths:
  - "src/pairing/**"
  - "src/channel/**"
  - "src/notifications/**"
  - "src/state/**"
  - "app.config.*"
  - "eas.json"
  - "package.json"
---
# Rule: documentation tracks source (anchor parity)

`docs/` is anchored to source: the capability verb list, key-storage inventory, notification
categories, test-tier commands, and EAS profile names are enumerated in docs and must not drift
from the code that defines them. The `/sync-docs` skill owns the full source-to-doc mapping and
the anchor list; this rule is the in-context reminder that fires when you touch an anchor
source.

## The rule

When you change an anchor source file (a capability verb, a key-storage call site, a
notification category, a test command, or an EAS profile), the docs that enumerate it must be
updated to match.

- You do not have to hand-edit docs mid-task: `/pull-request`, `/merge-pull-request`, and
  `/merge-back` all run the targeted doc-anchor check automatically, and the `doc-auditor` agent
  reports missing or extra anchor items.
- Run `/sync-docs` (or note the affected docs) when a change adds or removes an enumerable item.
- The canonical mapping, anchor list, and workflow live in `.claude/skills/sync-docs/SKILL.md`.
  Do not duplicate that list here; update it there.

## Enforcement (self-maintaining)

- **Agent (live now):** the `doc-auditor` agent mechanically counts anchor items in source vs
  docs and reports the diff.
- **Workflow (live now):** `/sync-docs` performs the full update pass; its targeted anchor check
  also runs automatically inside `/pull-request`, `/merge-pull-request`, and `/merge-back`.

`src/`, `app.config.ts`, `eas.json`, and `package.json` now exist (App Phase 1), so the anchors
(capability verbs, EAS profile names, test-tier commands, key-storage call sites) are real,
enumerable source - not prose placeholders.

## Scope

Source-to-doc anchor parity. Prose that is not anchored to an enumerable source structure is
handled by `/sync-docs`'s prose-audit pass, not this rule.
