---
description: Review git changes for quality and conventions via parallel reviewer subagents synthesized in the main agent (auto-fixes findings and fills coverage holes by default)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Agent
argument-hint: [base-ref] [review-only]
---

# Code Review

Review the changes that make up this branch's work (commits on the branch plus staged,
unstaged, and new untracked files) for quality, correctness, and project conventions, then apply
every safely-fixable finding.

## Modes

- **Default** (`/code-review`) - review, apply every safely-fixable finding, re-run typecheck,
  report `Changes Applied` + `Skipped (with reason)`.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only, no edits
  applied.

**User-provided arguments (if any):** $ARGUMENTS

## Mobile differences from the desktop repo's flow

- The HMR vitest check is desktop-only and does not apply here. Pre-flight typecheck runs: the
  harness (`package.json`, `tsconfig.json`) is live.
- The gated domain auditors are `crypto-pairing-auditor` (security-sensitive pairing/channel/
  notification code) and `expo-rn-reviewer` (Expo/RN platform and UI conventions), replacing
  desktop's `ipc-auditor`/`hmr-parity`/`platform-guard`/`session-debugger`/`migration-safety`.

## Instructions (driver)

This skill is a thin driver that runs in the main loop. All commands run from the current
working directory; use `git -C <path>` to target another directory.

1. **Pre-flight typecheck.** Run `npm run typecheck`. Type errors are highest-priority findings.
2. **Resolve the base branch.** First hit wins: an explicit ref in `$ARGUMENTS`; the repo
   default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`); fallback
   `refs/heads/main`. If none resolve, review the working tree only.
3. **Gather the diff (union).** Committed-vs-base (`git diff <base>...HEAD`), uncommitted
   (`git diff HEAD`), and untracked (`git ls-files --others --exclude-standard`, each file read
   in full and appended as a synthetic added-file block). If all three are empty, report
   "No changes to review." and stop.
4. **Fan out reviewer subagents (the `Agent` tool, all in ONE message).** Universal dimension
   finders always run (Correctness / Performance / Maintainability / Best Practices, each its
   own `general-purpose` subagent seeded with the matching Review Criteria below), plus a
   cross-file integration finder when more than one file changed, plus a red-green test-coverage
   finder when the diff changes behavioral source under `src/`. Gated domain auditors run only
   when their changed-file glob matches:

   | Finder | `subagent_type` | Gate |
   |---|---|---|
   | Crypto/pairing security | `crypto-pairing-auditor` | `src/pairing/**`, `src/channel/**`, `src/notifications/**`, `plugins/**`, `targets/**` |
   | Expo/RN platform | `expo-rn-reviewer` | `app.json`, `app.config.*`, `eas.json`, `plugins/**`, `package.json`, `src/screens/**`, `src/components/**` |

5. **Synthesize + verify (main agent).** For each finding, read the cited `file:line` and
   confirm the issue is real; refute anything the code does not substantiate. Dedup findings
   raised by multiple dimensions, keeping the highest severity. Sort by severity.
6. **Apply Phase + re-typecheck** (skip in `review-only` mode). Apply every safely-fixable
   finding with `Edit`/`Write`; re-run `npm run typecheck`. Delegate coverage holes
   on diff-introduced behavior to `test-builder` (unit/component tests written and run scoped to
   green; Maestro flows flagged, not written inline).
7. Emit the Output Format below.

## Review Criteria

### Correctness
Logic errors, off-by-one mistakes, null/undefined risks, missing error handling, race
conditions, incorrect async/await usage.

### Performance
Unnecessary allocations or re-renders, missing memoization, inefficient data structures.

### Maintainability
Unclear naming, overly complex expressions, duplication that should be extracted, premature
abstractions.

### Best Practices
- TypeScript strict mode compliance, no `any` in new code (see `typescript-style.md`).
- No shorthand variable names (see `typescript-style.md`).
- Wire/crypto/capability types from `@kangentic/protocol`, never redeclared (see
  `protocol-types-from-package.md`).
- Pairing/channel/notification code has no account/entitlement imports (see
  `accountless-core.md`).
- Push payloads are ciphertext plus placeholder only (see `e2e-notification-privacy.md`).
- Keys in `expo-secure-store`, never AsyncStorage (see `secure-storage.md`).
- No hand-edited `ios/`/`android/` (see `expo-cng.md`).
- FlashList for growable lists, font floor, testIDs (see `ui-conventions.md`).
- No em-dashes or `--` as punctuation (see `text-formatting.md`).
- No personal info or machine paths (see `no-personal-info.md`).
- Security: injection risks, unsanitized input; error handling at system boundaries.

## Model selection

- **Finders:** Sonnet (`model: "sonnet"`), matching the gated auditor agents' own frontmatter.
- **Synthesis + verification + Apply Phase:** the session model at its configured effort.

## Apply Phase

Fixes land in the working tree only, never committed; the user runs `/commit` then
`/pull-request`.

### What gets auto-fixed
`any`/`as any` casts, shorthand variable names, em-dashes/`--` punctuation, missing testIDs,
single-command bash chain violations in skills/docs, `cd <path> && git ...` -> `git -C <path>`,
one-file type fixes.

### What gets skipped (with reason)
Architectural refactors spanning multiple modules, missing coverage on pre-existing untouched
code (`"Outside diff scope; run /test write to add"`), coverage holes this diff introduced are
NOT skipped (auto-written via `test-builder`), ambiguous renames at many call sites,
stakeholder-input findings (security policy, UX copy), any fix that introduces a new type error.

## Output Format

### Findings Table

| # | Severity | Category | Location | Finding | Recommendation |
|---|----------|----------|----------|---------|----------------|

Sorted Critical, High, Medium, Low.

### Default-mode footer

```
### Changes Applied (N)
| # | File:Line | What changed |
|---|-----------|--------------|

Re-typecheck: PASS

### Tests Added (K)
| # | Test file | Tier | Behavior pinned (red-green) |
|---|-----------|------|------------------------------|

### Skipped (M)
| # | File:Line | Why | Next step |
|---|-----------|-----|-----------|

### Summary
- Files reviewed: N
- Findings: A critical, B high, C medium, D low
- Auto-fixed: N
- Tests added: K
- Skipped: M
- Verdict: **Clean** (or **Needs revision**)
```

### Review-only-mode footer

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** **Ship it** / **Minor issues** / **Needs revision**

## Allowed Tools

`Bash` (git/npm/npx only) for pre-flight and diff gathering, `Agent` to fan out finder
subagents, `Read`/`Edit`/`Write`/`Glob`/`Grep` for verification and the Apply Phase. No chained
commands. Use `git -C <path>` for other directories. Does not commit. Fixes land in the working
tree only; the user runs `/commit` to commit locally, then lands via the board PR flow
(`/pull-request` -> `/merge-pull-request`) or `/merge-back` for a direct quick-push.
