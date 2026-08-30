---
description: Review git changes for quality and conventions via parallel reviewer subagents synthesized in the main agent (auto-fixes findings and fills coverage holes by default)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Agent
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
- This pass does NOT commit its own work: fixes land in the working tree and the user runs
  `/commit`. Desktop's "commit the pass" step has no counterpart here, so the
  `.kangentic/REVIEW_PREEXISTING_DIRTY.tmp` that `scripts/build-review-pack.mjs` writes is
  unread in this repo. The script's logic is kept identical to the desktop copy anyway (only
  its header comment and an explicit `node:buffer` import, which this repo's ESLint config
  requires, differ): one implementation across both repos beats two drifting forks, and the
  extra file is gitignored.

## Instructions (driver)

This skill is a thin driver that runs in the main loop. All commands run from the current
working directory; use `git -C <path>` to target another directory.

1. **Pre-flight typecheck.** Run `npm run typecheck`. Type errors are highest-priority findings.
2. **Resolve the base branch.** First hit wins: an explicit ref in `$ARGUMENTS`; the repo
   default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`); fallback
   `refs/heads/main`. If none resolve, review the working tree only.
3. **Gather the diff ONCE, into a shared review pack.** Run
   `node scripts/build-review-pack.mjs <base>` (one Bash call; omit `<base>` when none resolved).
   It gathers the three disjoint layers itself - committed-vs-base (`<base>...HEAD`), uncommitted
   (`git diff HEAD`), and untracked files as synthetic added-file blocks - and writes
   `.kangentic/REVIEW_PACK.tmp.md`: a `Total lines: <N>` header, a table of contents with exact
   start lines, the union diff, then full line-numbered bodies of the changed files largest-churn
   first, capped near 200KB with trimmed files listed under `## Not included (read on demand)`.
   It prints a summary only, never the pack. If its stdout begins `NO CHANGES:`, emit
   "No changes to review." and stop - do not re-run the git gather to confirm it. Key that
   decision off the stdout prefix rather than the exit status, which is 0 both when a pack is
   written and when the diff is empty. A NON-zero exit or a stack trace is a third outcome, not
   an empty diff - usually a base ref that does not resolve, since the script lets git's error
   throw. Never report "No changes to review." for a run that failed: fix the ref, or fall back
   to the by-hand gather below.

   Take `changedFiles` from the pack's table of contents PLUS its `## Not included (read on
   demand)` section, never from the summary line (which prints counts, not paths) and never from
   the TOC alone: a file the 200KB cap trimmed appears only in the `## Not included` list, and
   dropping it from `changedFiles` can silently un-gate a domain auditor whose glob it matched.
   Then compute the compact **signature delta** from the pack's diff alone (Step 4's integration
   finder consumes it).

   This exists because without it every finder re-runs the gather and re-reads the same changed
   files: the desktop repo's fan-out audit measured 50-78k tokens of re-derivation per finder and
   38% of all Read bytes duplicated across finders. Two rules protect the saving, and dropping
   either one gives it all back:
   - **The pack is delivered as a FILE PATH, never inline in a finder prompt.** Agent-tool prompt
     text is re-billed as driver output tokens once per finder.
   - **Never write the pack with the `Write` tool.** Tool input is billed as model output, so a
     200KB pack costs roughly 100k output tokens if the driver writes it. The script writes it.

   `.kangentic/` is gitignored, so the pack never stages itself and needs no cleanup. If the
   script is missing (older checkout), fall back to building the pack by hand per the layout above.
4. **Fan out reviewer subagents (the `Agent` tool, ALL in ONE message so they run concurrently).**
   Every finder is read-only in its own fresh context; only the driver mutates the tree, in the
   Apply Phase. Give each finder the changed-file list and the ABSOLUTE path to the pack, with
   this instruction: load the pack FIRST and in FULL, in sequential `Read` calls with explicit
   `offset`/`limit` (its first line states the total line count; `Read` returns at most 2000 lines
   per call, so a pack of N lines takes exactly ceil(N/2000) calls - never re-read overlapping
   ranges); treat the pack's diff as authoritative; do NOT run the git gather yourself; do NOT
   re-`Read` any file whose full body is in the pack; and STAY ON YOUR CRITERIA - read beyond the
   pack only for your own checklist (callers, `.claude/rules/*.md`, tests, the `## Not included`
   files). Each prompt also carries a 3-6 line NEUTRAL summary of what the change does (mechanism
   only - context, not a licence to assume the author was right) so the finder does not burn reads
   orienting itself.

   Universal dimension finders always run, each seeded with the matching Review Criteria below.
   Gated domain auditors run only when their changed-file glob matches, and each owns its own
   checklist - spawn it, never restate the checklist in the prompt.

   | Finder | `subagent_type` | Gate |
   |---|---|---|
   | Correctness / Performance / Maintainability / Best Practices | `review-finder` | ALWAYS, one finder per dimension |
   | Cross-file integration (signatures only) | `review-finder` | ALWAYS when more than one file changed |
   | Test coverage (red-green) | `review-finder` | ALWAYS when the diff changes behavioral source under `src/` |
   | Crypto/pairing security | `crypto-pairing-auditor` | `src/pairing/**`, `src/channel/**`, `src/notifications/**`, `plugins/**`, `targets/**` |
   | Expo/RN platform | `expo-rn-reviewer` | `app.json`, `app.config.*`, `eas.json`, `plugins/**`, `package.json`, `src/screens/**`, `src/components/**` |

   **The integration finder gets ONLY the signature delta - never the pack path, never gather
   commands.** The driver computes it from the diff alone (no file bodies): `changedExports`
   (added/changed/removed exported signatures), `typeDeltas` (interface/type member changes, e.g.
   a field becoming required), `storeShapeMutations` (new/removed Zustand store fields), and
   `importChanges` (added/removed import edges between changed files). That input is a few hundred
   tokens regardless of diff size, which is the point: a desktop run that handed this finder the
   gathering instead had it read 254k tokens of file bodies, 500x its design budget. It answers
   what per-file finders structurally cannot - an export's signature changed but a caller in
   another changed file still passes the old shape; a protocol type gained a required field no
   caller sets.

   **Removed / renamed surface (correctness + integration finders).** When the diff deletes or
   renames an exported symbol, a string constant, a wire-format token, an enum member, or a config
   key, those two finders must `Grep` the WHOLE repo (including `tests/`, `docs/`, `.maestro/`, and
   `.js`) and flag any surviving reference outside the diff. `tsc` cannot see string-keyed
   contracts, testID literals, or Maestro selectors, so this grep is the only check that catches
   them and it stays exhaustive.

   **The coverage finder's slice is the narrowest.** Its one falsifiable question, per
   behaviorally-significant change: is there a test that would FAIL if this change were reverted?
   If not it reports a coverage hole - the `location`, the behavior left unverified, why existing
   tests miss it, and a suggested tier as a hint only. It reads the pack (which already carries
   the changed implementation and changed tests) plus additional TEST files only, never unchanged
   implementation bodies. It writes nothing: `test-builder` owns tiering and authoring in the
   Apply Phase. Scope holes to behavior this diff introduced.

   If a finder errors or returns nothing usable, proceed on the surviving dimensions and note the
   dropped one in the Summary.
5. **Synthesize + verify (main agent).** For each finding, read the cited `file:line` and
   confirm the issue is real; refute anything the code does not substantiate. Correctness and
   Critical findings arrive carrying the falsifiable triple (`triggeringInput`, `codePath`,
   `testGap`): that is verification input for you, not a table column - trace the
   `triggeringInput` through the cited `codePath` and drop the finding if it does not
   reproduce. Check a cited rule's own `## Scope` section before accepting a conventions
   finding; a rule scoped to `src/`, `tests/`, and `plugins/` does not reach `scripts/`.
   Dedup findings raised by multiple dimensions, keeping the highest severity. Where two
   finders disagree about the same lines, read those lines yourself rather than counting
   votes. Sort by severity.
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

- **Finders:** pinned in agent frontmatter, never passed per spawn. The universal finders spawn
  as `subagent_type: "review-finder"` (`.claude/agents/review-finder.md`: `model: sonnet`,
  `effort: medium`, `tools: Read, Glob, Grep`). Both parts matter: the restricted roster drops
  the tool/MCP manifest from every finder's fixed floor (this repo wires four MCP servers, so
  that manifest is large and a finder needs none of it - under the pack it needs no Bash or git
  either), and the pinned effort stops a wide fan-out from inheriting the driver session's
  effort setting. The gated auditors carry the same `model: sonnet` + `effort: medium` in their
  own frontmatter. Sonnet at medium is enough because the review's depth comes from the
  structure - many independent finders plus main-agent verification and dedup - not from each
  finder being a frontier reasoner.
- **Synthesis + verification + Apply Phase:** the session model at its configured effort. The
  strong model is spent on the one bounded synthesis context rather than across the fan-out.

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

`Bash` (git/npm/npx/node only) for pre-flight and the pack build, `Agent` to fan out finder
subagents, `Read`/`Edit`/`Write`/`Glob`/`Grep` for verification and the Apply Phase. `Write` is
for fixes and tests only, never for the review pack (see Step 3). No chained commands. Use `git -C <path>` for other directories. Does not commit. Fixes land in the working
tree only; the user runs `/commit` to commit locally, then lands via the board PR flow
(`/pull-request` -> `/merge-pull-request`) or `/merge-back` for a direct quick-push.
