---
paths:
  - "src/**"
---
# Rule: wire and crypto types come from @kangentic/protocol

The wire format, Noise handshake messages, capability verbs, and transcript/board/activity
event types have exactly one source of truth: the `@kangentic/protocol` package, published from
the desktop `kangentic` repo. A forked or hand-copied type silently diverges from what the
desktop bridge actually sends, which is precisely the class of bug that breaks a security
protocol quietly (see Happy's one-key-many-jobs mistake in `docs/security.md`).

## The rule

- Import all wire, crypto, capability, and event types from `@kangentic/protocol`. Never
  redeclare, copy, or "temporarily inline" a type that already exists in the package.
- Extend or narrow a protocol type locally only by composition (`Pick`, `Omit`, intersection),
  never by hand-writing a parallel shape.
- If a type you need is missing from `@kangentic/protocol`, add it there first (a PR against the
  desktop repo) rather than defining a local stand-in that will drift.
- Recorded wire samples in test fixtures are data, not type declarations, and are exempt.

## Enforcement (self-maintaining)

- **Review (live now):** the `crypto-pairing-auditor` agent checks pairing/channel/notification
  code for local redeclarations of protocol shapes during `/code-review`.
- **Test (planned, App Phase 1):** a scan for local `interface`/`type` declarations whose name
  shadows a `@kangentic/protocol` export.

## Scope

All of `src/`. Does not apply to test fixtures that merely contain recorded protocol messages as
data.
