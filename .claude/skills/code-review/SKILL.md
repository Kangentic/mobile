---
name: code-review
description: Review git changes for quality and conventions via parallel reviewer subagents synthesized in the main agent (fixes everything it verifies in or out of the diff, records the decisions it made, fills red-green test-coverage holes, commits that pass locally, and ends Ready or Blocked from a script, sending what it could not finish back as numbered steps, never as new tasks)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Agent
argument-hint: "[base-ref] [review-only]"
---

# Code Review

Review the changes that make up this branch's work - commits on the branch **plus** staged, unstaged, and new untracked files in the working tree (the diff from the base branch through the working tree) - for quality, correctness, and project conventions, then fix every verified finding and end Ready or Blocked.

## Modes

- **Default** (`/code-review`) - review, then fix every verified finding (Lows included), apply the recommended option on every decision and record it, re-run the checks, commit this pass's own work locally (never pushed), and end with the verdict block `scripts/review-verdict.mjs` prints: **Ready** (for Testing) or **Blocked**. There is no third verdict and no "skipped" status. Blocked sends the card back to Executing, unless a step only a person can do adds a `Needs owner:` line below the verdict, which stops the card where it is.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only, no edits applied.

The skill reads `$ARGUMENTS`, which may carry up to two independent tokens in any order:
- `review-only` - skip the Apply Phase, the checks, and the commit step (it writes nothing at all) and emit the legacy Verdict footer instead of the default report.
- a **base ref** (any token that is not `review-only`, e.g. `origin/main`, `main`, or a commit SHA) - overrides the auto-detected base branch the diff is scoped against (see Step 3). A base ref is diff-*scoping* metadata, not author intent - it never tells the reviewer what the change was "supposed" to do (see "Reviewer independence").

**User-provided arguments (if any):** $ARGUMENTS

## Mobile differences from the desktop repo's flow

This skill is synced from the desktop repo's `/code-review`, last at desktop commit 613bbb6aa (2026-11-05), with `scripts/build-review-pack.mjs` at desktop commit 00954d96e. The flow is desktop's. These nine items are where it diverges. This section owns the list and its reasons; CLAUDE.md and the header of `scripts/build-review-pack.mjs` carry one-line copies of the same nine, so change all three together. Not counted as divergences: this repo's own path examples, its Review Criteria, and repo notes such as Step 1's stale-`node_modules` check, which adapt the text without changing the flow. The measurements this file cites (task numbers, the Phase 0 replay, `docs/audits/code-review-fanout-audit.md`) are the desktop repo's; that doc does not exist here.

1. **No HMR vitest.** Desktop's Step 2 runs an Electron-renderer invariant test with no counterpart here. Step 2 stays as a placeholder so every step number, and the pack header's "Step 8's set math", stays 1:1 with desktop. `scripts/review-verdict.mjs` checks `typecheck` and `scopedTests` only.
2. **A Maestro hole is written in the pass, and run only on a rig that is already up.** Desktop builds once and runs each new E2E spec scoped in the pass. Maestro is single-tenant (one emulator, one relay port, one paired identity), and CLAUDE.md keeps the suite out of local pre-PR runs, so `test-builder` writes the flow in the pass but runs that one flow only when a dev rig is already up for this worktree, and never brings one up. Otherwise the flow is committed unrun and CI runs it on the pull request. The hole is `fixed` either way, with a `decision` whose alternative is a local run when it went unrun. Never a follow-up task, never `blocked` because no emulator is up, never `.skip`. "Auto-adding missing tests" step 3 has the procedure.
3. **Gated auditors** are `crypto-pairing-auditor` and `expo-rn-reviewer`, in place of desktop's `ipc-auditor`, `hmr-parity`, `platform-guard`, `session-debugger` and `migration-safety`.
4. **The "try first" packaged-build example** is a release build, `npx expo run:android --variant release --no-bundler`, in place of desktop's `npm run package`.
5. **No commitlint.** There is no commitlint in `package.json` and no `.husky/` commit-msg hook, so desktop's `footer-max-line-length` change and its `review-ledger-commitlint.test.ts` do not apply: a ledger line of any length lands. Re-check if a commit-msg hook is ever added.
6. **New `.mjs` scripts import Node-only globals explicitly.** This repo's ESLint config supplies React Native globals, not Node's: `process` and `console` resolve, `Buffer` does not, so `scripts/build-review-pack.mjs` imports it from `node:buffer`.
7. **Step 7's importer run covers two test directories.** It greps `tests/unit/` (run hits with `npx vitest run`) and `tests/components/` (run hits with `npx jest`). The Jest tier is about as cheap as vitest here and holds the tests that import screens and components. The cap of five counts both together.
8. **`<reviewDir>` reason.** Desktop keeps its files out of `.kangentic/` because its dev script moves that folder to a trash folder; this repo's `scripts/dev.mjs` does not. The scratchpad is kept for parity: it is outside the repo, so nothing stages, and its fixed name survives a compaction.
9. **Script header comments.** `scripts/build-review-pack.mjs`, `scripts/review-verdict.mjs` and `scripts/lib/is-entrypoint.mjs` each name their own divergences in their header; desktop-only references are cited as desktop's.

### Reviewer independence

`/code-review` always runs in a **fresh, isolated session** with no prior conversation or generation history (the board's Code Review column spawns it with `sessionTarget: isolated` and `sessionSpawnStrategy: always_spawn_new`; see `kangentic.json`). The reviewing agent therefore did not write the code under review and has no memory of intending anything by it, so it is an independent reviewer **by construction**. Judge the diff strictly on its own merits - correctness, conventions, and the criteria below - and do **not** assume the author's intent was correct; that a change exists is not evidence it is right. The parallel finder subagents each receive only the change itself - the review pack's change-marked sections, never any generation reasoning - and re-derive expected behavior independently. The main agent then **verifies each finding against the actual code**: it reads the cited lines, confirms the issue is real, treats "the author clearly meant X" as inadmissible, and when uncertain **refutes** (drops) the finding rather than waving it through on assumed intent.

### Not the same as `/code-review ultra`

`ultra` is a Claude Code **built-in** that launches a multi-agent review in the **cloud** - user-initiated, billed, and not self-launchable by this skill. This project skill (`/code-review`) is an **in-session, local** reviewer: it fans out parallel read-only subagents via the `Agent` tool and synthesizes their findings in the main loop. Use `ultra` for a deep cloud audit on demand; this skill for the automatic, auto-fixing local pass.

## Instructions (driver)

The skill is a thin driver that runs in the main loop. All commands below run from the **current working directory** - never use `cd <path> && git ...` (triggers an unbypassable security prompt); use `git -C <path>` if you must target another directory. If the CWD is a worktree, git operates on it automatically.

**`<reviewDir>`, where this pass keeps its files.** `<reviewDir>` is the `code-review` folder inside the session scratchpad directory your environment block names (for example `<scratchpad>/code-review`). It is a fixed name so that a driver whose context was compacted can find its files again. Every file this pass writes goes there: the pack, the dirty list, the finder queue, the findings JSON, and the commit message. It is outside the repo, so none of them can ever stage (Mobile differences item 8). Only when your session names no scratchpad is `<reviewDir>` the worktree's gitignored `.kangentic/`, with `--out-dir` left off the pack command. In a Bash command, write `<reviewDir>` and every path under it with forward slashes (`C:/Users/dev/...`), including a path you copy from a script's summary. On Windows the Bash tool is Git Bash, which drops the backslashes of an unquoted `C:\Users\dev\x` and passes `C:Usersdevx`. Node resolves that as a drive-relative path inside the worktree, so the pack and the dirty list would land as untracked files that Step 8 then commits. `Read`, `Write` and `Edit` accept either form.

1. **Pre-flight typecheck.** Run `npm run typecheck` to check for type errors. Any type errors are **highest-priority findings** - they represent potential runtime crashes. Include them in the review output even if they are in files not touched by the current diff. If the errors name files nobody touched and read like a wall of "has no exported member" or "Cannot find module", the `pretypecheck` drift guard (`scripts/checkInstallDrift.mjs`) or a stale `node_modules` is the likely cause, not the code: run `npm install` and re-run before raising them.
2. **No pre-flight HMR vitest in this repo.** Desktop runs one here; this repo has no counterpart (Mobile differences item 1). The step is kept so the numbering below matches desktop.
3. **Resolve the base branch.** Agents in this workflow sometimes commit during the working session, sometimes leave changes in the working tree, sometimes both - so the review scope is the full delta from the base branch through the working tree. Resolve the base ref in this order, each its own Bash call, first hit wins:
   1. An explicit ref in `$ARGUMENTS` (the token that is not `review-only`), e.g. `origin/main` or a branch/SHA. Authoritative - use it verbatim.
   2. The repo default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (yields e.g. `origin/main`).
   3. Fallback locals: `git rev-parse --verify --quiet refs/heads/main`, then (if that fails) `git rev-parse --verify --quiet refs/heads/master`.
   If none resolve (no remote, no `main`/`master`), set base to empty and review the working tree only - note "base branch undetermined; reviewed working-tree changes only" in the Summary.
4. **Gather the diff (each command its own Bash call).** Capture all three layers for the driver's own use: the signature delta, the empty-diff check, the `--stat` summary, and `preexistingDirty` below. Finders never see this output; the pack script gathers the same layers itself.
   - **Committed-vs-base:** `git diff <base>...HEAD` and `git diff <base>...HEAD --stat` (three-dot = changes since the branch diverged from base). Skip when base is empty; an empty result otherwise just means no committed divergence, not an error.
   - **Uncommitted (staged + unstaged):** `git diff HEAD` and `git diff HEAD --stat` (`git diff HEAD` captures index + working tree in one command).
   - **Untracked new files:** `git ls-files --others --exclude-standard`. No diff shows these, but they are part of the change: `Read` each listed file so the signature delta below covers its exports. The pack script packs them itself, as sections in which every line is marked added.
   If the committed diff, the uncommitted diff, **and** the untracked list are all empty (the pack script prints `NO CHANGES:` on the same condition), run `node scripts/review-verdict.mjs --no-changes <base>` (omit `<base>` when it is empty), paste its output verbatim as the pass's whole final message, and stop. It ends `Verdict: Blocked`, one step above it: on the board an empty diff is a task whose Executing step committed nothing, and on desktop a bare "No changes to review." matched neither Code Review row, so a workflow moved the task on to Testing unreviewed. In review-only mode emit "No changes to review." and stop. Compute the compact **signature delta** from these diffs and the untracked files (the integration finder consumes it; see "## Finders"). `changedFiles` comes from the build script's `paths:` line once it has run (below) - never from `--stat` output, which truncates long paths.

   **Record `preexistingDirty`** = the union of `git diff HEAD --name-only` and the untracked list: everything already dirty before this pass touched anything. Step 8 subtracts it to decide what it may commit. This is deliberately **narrower than `changedFiles`**, which also includes the committed-vs-base paths - conflating the two makes Step 8's set difference empty, so nothing would ever commit.

   **Use `--name-only`, never the `--stat` paths, for this set.** `--stat` abbreviates a long path to fit its column budget (a deep `src/screens/...` or `tests/components/...` path renders as `.../<last segments>`). Step 8 compares against `git diff HEAD --name-only`, which never truncates, so a `--stat`-derived entry would fail to string-match its own full path, drop out of the subtraction, and get committed - the precise outcome this design exists to prevent. Keep the `--stat` capture for the human-readable summary only.

   **Persist it immediately, do not just remember it.** `scripts/build-review-pack.mjs` (next paragraph) writes the list to `<reviewDir>/REVIEW_PREEXISTING_DIRTY.tmp` from the same gather; confirm the file exists, and only write it yourself (one path per line, `Write` tool) if the script was unavailable. Step 8 is many steps, a fan-out of dozens of subagents, and a whole Apply Phase later, so this value has to survive a context compaction in between. If it does not survive, the set difference silently UNDER-counts and Step 8 commits the task agent's unfinished work - the exact outcome this design exists to prevent. The since-review pack below gets its OWN out-dir, so it can never overwrite this list.

   **Build the shared review pack (gather once, read N times).** Run `node scripts/build-review-pack.mjs <base> --out-dir <reviewDir> --shard-lines 1500` (one Bash call; omit `<base>` when the base is empty). Besides the `paths:` line below, the summary prints `shards: header 1-<k>; <a>-<b>, <c>-<d>, ...`: the pack split into ranges of about 1500 lines that start on a section heading and never split a section. Step 5 gives one correctness finder per range. The script writes two files into `<reviewDir>` and prints only a short summary that names both paths; verify both exist. `REVIEW_PACK.tmp.md` is the pack: a `Total lines: <N>` header, a one-line format legend, a table of contents with an exact start line for every changed file, then one section per changed file, largest churn first. Every body line is `<marker><line number><tab><text>` with `+` added, ` ` unchanged, and `-` removed (blank number, shown in place before the line that follows it), so each changed line appears exactly once and every citation is a working-tree line number. A file whose full body fits under the 200KB body cap is `## Full file:` or, windowed at 20 lines of context, `## Partial file:`; every other readable file is `## Changed hunks:`, the same windows at 3 lines of context. A file too large to read (over 1MB) that still has parsed hunks gets that same heading at 0 lines of context, and says so in the heading. A hunk section that alone exceeds the 100KB per-file cap becomes a one-line `## Changed hunks omitted:` stub and is listed under `## Not included (read on demand)`, as is any binary file and any oversized file the parse found no hunks for; a hunk-tier file is never listed there, because it already carries every changed line. Deleted, renamed-only, mode-only, and reverted files get a one-line section. There is no separate diff. `REVIEW_PREEXISTING_DIRTY.tmp` is the dirty list from the same gather. If the script's stdout begins `NO CHANGES:`, end the pass with the `--no-changes` output as above; key that off the stdout prefix, not the exit status, which is 0 both ways. A NON-zero exit or a stack trace is a third outcome, usually a base ref that does not resolve: fix the ref, never print the `--no-changes` message for a run that failed. If the script is missing (older checkout), write the dirty list by hand per the rules above and give the finders the changed-file list with no pack path; never hand-build a pack, which is the `Write`-tool cost the next rule forbids. This exists because the desktop repo's 2026-08-29 audit measured each finder independently re-gathering the diff (50-78k tokens each) and re-reading the same changed files (38% of all Read bytes duplicated): the pack pays that cost once. Two rules protect the savings: the pack is delivered as a FILE PATH, never embedded in finder prompts and never written through the `Write` tool (both re-bill the pack as driver output tokens - ~100k tokens at Opus rates for a 200KB pack - which is why the script does the writing); and `<reviewDir>` is outside the repo, so neither tmp file ever stages or needs cleanup.

   **Take `changedFiles` from the script's `paths:` line.** The summary block prints two distinct lines, and only the second carries paths:

   ```
     changed files: 6 (committed 0, uncommitted 4, untracked 2)
     paths: src/pairing/pairingMachine.ts, src/screens/BoardScreen.tsx, ...
   ```

   `changedFiles` = that comma-separated list, verbatim. It is the script's own `changedFiles` array - the deduped union of all three layers, in full untruncated form - so it needs no reconstruction and cannot disagree with what the pack was built from. Read the `paths:` line, never the `changed files:` count line above it (counts, not paths), and never the pack's `## Contents` TOC. The TOC lists every changed file too, but it is a navigation aid for finders, not a contract: reading it means opening the pack in the driver (billing the whole pack as driver input) and parsing paths back out of markdown labels, and every path dropped from `changedFiles` silently un-gates a domain auditor whose glob it matched (a missing `src/pairing/**` path skips `crypto-pairing-auditor`; a missing `src/screens/**` path skips `expo-rn-reviewer`) while the review still reports success.

   **Known limit of the format:** the paths are joined with `, `, so a changed file whose own path contains a comma-space would split into two phantom entries - one matching no auditor glob, the other under-gating. Git permits commas in paths, this repo has none, and the format is shared with the sibling repos, so do not redesign it here; if a path ever looks wrong in `changedFiles`, cross-check it against `git diff HEAD --name-only` before trusting the split.

   **Read the review ledger.** Earlier passes on this branch left a record of what they refuted and what they decided, in the bodies of their `*(review)` commits. When the base is non-empty, run `git log --grep="(review)" --format=%B <base>..HEAD` (one Bash call; keep the quotes, since unquoted parentheses are a shell syntax error) and keep every line that starts with `Refuted:` or `Decisions:`. Each line is keyed `<file> <symbol>: <mechanism>`, never by line number, because line numbers drift between passes. Empty output means this is the first pass. Step 6 uses these lines; a pass without them re-raises what earlier passes settled (desktop task 736 re-raised 43 items over 9 passes, and refuted 12 of them a second time).

   **Build the since-review pack (a later pass only).** When the ledger read found an earlier pass, find where that pass began, so its own fixes are reviewed too: no finder ever read them, and every Phase 0 delta case (section 15 of the desktop repo's audit doc) is a review fix a later pass had to fix again. Run `git log --format="%H %s" <base>..HEAD` (one Bash call; newest first). Walk down to the newest commit whose subject starts `<type>(review):`, then keep walking while each older subject also starts that way; a pass's commits are contiguous, because the card stays in Code Review while they land. Match the subject prefix, never `--grep`, so a task commit that only mentions "(review)" cannot move the base. The base is the parent of the oldest commit in that run: run `node scripts/build-review-pack.mjs <oldest sha>^ --out-dir <reviewDir>/since-review` (one Bash call). That pack holds the earlier pass's fixes, the task agent's work since, and anything new. Its `paths:` line is `sinceReviewFiles`. Step 5 gives it to every pack-reading finder except the correctness shards; the integration finder still gets only the signature delta. If it prints `NO CHANGES:`, nothing changed since that pass began: Step 5 runs the correctness shards alone and gates no auditor.
5. **Fan out reviewer subagents (the `Agent` tool, at most 20 running at once; see the cap below).** Every finder is a **read-only** subagent in its own fresh context window; only the driver (main loop) mutates the working tree, in the Apply Phase. Give each finder the changed-file list and the absolute path to `<reviewDir>/REVIEW_PACK.tmp.md`, with this instruction: load the pack FIRST and in FULL, in sequential `Read` calls of at most 1000 lines with explicit `offset`/`limit` (its first line states the total line count, so a pack of N lines takes ceil(N/1000) calls - do not re-read overlapping ranges; a 2000-line call can pass the `Read` tool's 25k-token cap and fail, which desktop's Phase 0 finders hit on dense packs); treat the pack's sections as the authoritative record of WHAT changed (the working tree stays the record of what the code is); do NOT run the git gather yourself; do NOT re-`Read` any file whose full body is in the pack; and STAY ON YOUR CRITERIA - the pack is the review surface, so do not spend calls re-verifying repo state outside your checklist (desktop's A/B validation measured a finder giving back the entire saving by wandering into out-of-scope verification). Reading beyond the pack is for your criteria only: callers, `.claude/rules/*.md`, tests, the `## Not included` files. Tell the finder what the section kinds guarantee, or it will re-read the file and give the saving back: every line carries a marker (`+` added, ` ` unchanged, `-` removed in place with a blank number) and its exact working-tree line number, so a citation from any section is correct, and a removed line is cited by the numbered line after it; `## Partial file:` carries EVERY changed hunk with 20 lines of context and `## Changed hunks:` the same with 3, with the unchanged runs between windows replaced by a marked, line-numbered gap (`..... 954 unchanged lines omitted (72-1025) .....`), so being windowed is not by itself a reason to re-`Read` a file - only a criterion that genuinely needs code inside a gap is. Every finder prompt also carries: a 3-6 line NEUTRAL summary of what the change does (mechanism only - phrase it as "context, not a licence to assume the author was right", per Reviewer independence) so the finder does not burn reads orienting itself; the instruction to end its final message with `Reads beyond the pack:` and one line per file it Read outside the pack (path and the criterion that needed it), or `none`; and the single-command Bash tool rule verbatim for any Bash-capable finder. Never hand a finder a raw diff inline and never hand it the Step 4 gather commands: desktop's audit measured both variants costing each finder tens of thousands of tokens that the pack now pays once. The one exception is the integration finder, which gets ONLY the signature delta (below), not the pack. See "## Finders" for the exact set, the gates, the per-finder criteria, and the required return shape. The universal dimension finders always run; the domain auditors run only when their changed-file glob matches.

   **The correctness lane is sharded.** Spawn one correctness finder per range on the Step 4 `shards:` line. Each one's read plan replaces "load the pack in FULL" with: load pack lines 1-`<k>` (the header and table of contents), then its own range, in `Read` calls of at most 1000 lines with explicit `offset`/`limit`, and no other part of the pack. Each correctness finder covers the files in its own range and may read beyond the pack for the code those files call or test. A range that holds only tests is checked against the production code it exercises, which lives in another range. Every other finder reads the pack in full, as above. Sharding is the shape desktop's Phase 0 measured: it costs about what one finder over the whole pack costs, and a long pack no longer sits in one context.

   **Run at most 20 agents at once, and never merge ranges.** The harness runs at most 20 subagents at a time. That caps how many run at once, not how many a pass starts, so keep the script's ranges exactly as printed. Merging them to fit one message left ranges unread: desktop task 732's fifth and seventh passes merged the 1500-line ranges into shards of about 6k lines, and shards skipped whole files. The sixth and eighth passes kept the script's ranges, started 54 and 56 finders in rolling batches, and every shard read its whole range (section 14.5 of the desktop repo's audit doc). Count the finders: one per shard, the other universal finders, and every gated auditor whose glob matched. When the count is 20 or fewer, launch everything in ONE message. When it passes 20:

   - **Write the queue first.** `Write` `<reviewDir>/REVIEW_QUEUE.tmp` with one line per finder, every non-shard finder first as `<name> pending`, then one line per `shards:` range in pack order as `shard <n> <start>-<end> pending`. It is the record of which finders are still to start and which have returned. Like the dirty list, it has to survive a context compaction, and a fan-out of 50 or more finders is the likeliest place to hit one. This `Write` replaces any queue an earlier pass in the session left, and a pass of 20 or fewer finders never reads one. After it, change the file only with `Edit`, one line per change, never by writing it again.
   - **First wave, in ONE message.** Launch the first 20 lines and mark each `started`. The whole-pack finders and the gated auditors sit first because they read the most, and started late they would be the last to return. Give each finder its line's name as the description (`shard <n>/<N>` for a shard) so its completion notification names its line.
   - **One back, one out.** Each time a finder returns, in that same response, mark its line `done`, launch the first `pending` line, and mark that line `started`. A finder that errored or came back empty has returned too. Keep 20 finders running while any line reads `pending`.
   - **After a compaction.** `Read` the file before launching anything. Never relaunch a `started` line, because its result is still coming. Step 6 verifies against each finder's `file:line` citations, and a summary rarely keeps them. So a `done` line goes back to `pending` when the compacted context no longer holds that finder's findings with their citations. Then launch `pending` lines until 20 read `started`, because no return may be left to trigger a launch. This can rerun most of the pass. The skill accepts that cost over writing every finder's findings to disk as they arrive, which would bill them all again as driver output on every pass, compaction or not.

   **A later pass gives the since-review pack to every finder but correctness.** When Step 4 built a since-review pack, the correctness shards still read the full pack, and their criteria gain the Best Practices security line (injection risks, unsanitized input). Every other pack-reading universal finder and every gated auditor gets `<reviewDir>/since-review/REVIEW_PACK.tmp.md` instead (the integration finder still gets only the signature delta, never a pack), and the gated auditors gate on `sinceReviewFiles`, not `changedFiles`. When that pack came back `NO CHANGES:`, only the correctness shards run. Code an earlier pass reviewed is still read for defects. Its maintainability, performance and conventions calls were already made and are in the ledger. Re-raising them on every pass is the loop this skill exists to stop.
6. **Synthesize + verify (main agent).** Begin once every finder has returned; with a finder queue, that is when every line of `REVIEW_QUEUE.tmp` reads `done`. Collect every finder's findings. For each, **verify it against the actual code** - read the cited `file:line` (for a removed line, the pack section that shows it, since the working tree no longer does), confirm the issue is real, and refute (drop) anything the code does not substantiate or that cannot be stated falsifiably (judge the code, not assumed intent). Correctness and Critical findings arrive carrying the falsifiable triple (`triggeringInput`, `codePath`, `testGap`): that is verification input for you, not a table column - trace the `triggeringInput` through the cited `codePath` and drop the finding if it does not reproduce. Check a cited rule's own `## Scope` section before accepting a conventions finding; a rule scoped to `src/`, `tests/`, and `plugins/` does not reach `scripts/`. Dedup findings the same issue surfaced from multiple dimensions (e.g. an `any` flagged by both correctness and best practices), keeping the highest severity and clearest recommendation; where two finders disagree about the same lines, read those lines yourself rather than counting votes. Then check each surviving finding against the Step 4 ledger: a finding with the same file, symbol and mechanism as a `Refuted:` or `Decisions:` line is refuted with the reason `ledger: <the earlier reason>`, unless it cites evidence the earlier reason did not cover (an input it never considered, code that changed since, a test that now fails). A finding that does cite such evidence is verified like any other and recorded with `reRaise: { of: <the ledger line>, newEvidence }`. Never overturn an earlier decision without that evidence: two passes flipping the same call is the loop this rule exists to stop. Fold in the pre-flight signal: Step 1 type errors as Critical rows. Sort by severity. If a finder returned nothing usable (it errored or came back empty), note the dropped dimension in the Summary. Tally every finder's `Reads beyond the pack:` lines and the script's `pack:` summary line (size, hunk sections, stubbed) for the Pass record's Pack line: that is the per-review record of whether the pack's context width and per-file cap are right.
7. **Apply Phase + checks** (skip both in `review-only` mode). Resolve every verified finding as "## Apply Phase" describes: fix it (Lows included, in the diff or out of it), apply the recommended option on a decision, or, only after trying, mark it blocked with the step the task agent must take. Each fix is its own atomic unit. Then re-run `npm run typecheck`, the scoped run of every test this pass added, and the scoped run of each existing test file that imports a source file a fix touched. Find those with `Grep` under `tests/unit/` (run with `npx vitest run <file>`) and `tests/components/` (run with `npx jest <file>`); imports use the `@/` alias, so search for `state/boardStore`, not `src/state/boardStore.ts`, and a script's tests import it as `../../scripts/<name>.mjs` (Mobile differences item 7). A Maestro flow's importer is `tests/unit/maestroFlows.test.ts`, which reads every flow. A fix can break a test it never mentions: in desktop's Phase 0 replay, a review fix that moved a guard above its `try` failed an existing test, and no finder caught it. Keep this scoped: when more than five files import a touched module (a shared module such as `src/state/boardStore.ts`, which 25 test files import), run only the ones named after it (`boardStore.test.ts`) and leave the rest to CI. The five-file cap counts both directories together. When an existing file fails, revert that fix's edit and run the file again. A file that still fails was broken before this pass, and it does not fail `scopedTests`. Restore the fix, then fix that file in this pass when you can. When you cannot, record it as a non-quick `blocked` finding whose `step` is to fix that file in this task. A file that passes without the fix means the fix is wrong, which the type-error rule below covers: try once more, then `blocked`. If a fix introduces a new type error, revert that specific edit and try once more with a different fix; if the second attempt also fails, the finding is `blocked` with a `step` that names the error and the file. Do not roll back unrelated fixes. The Apply Phase also **fills coverage holes** through `test-builder`, every tier included (see "Auto-adding missing tests"). Finally, write `<reviewDir>/findings.json` with the `Write` tool, in the shape the header of `scripts/review-verdict.mjs` documents: every finding with its final `status` (`fixed`, `refuted` or `blocked`) and the two check results (`typecheck`, `scopedTests`). There is no `skipped` status and no `followUps` or `followUpTask` key, and the script refuses all three.
8. **Commit the pass** (skip in `review-only` mode, which writes nothing). Commit this pass's own work so the worktree returns to clean and the next agent inherits an attributed commit instead of a mystery. The commit body carries the ledger, so a later pass knows what this one refuted and decided. See "## Committing the pass" for the set rule, the exact commands, the ledger-only commit, and the mixed-authorship case.
9. **Report.** In `review-only` mode, emit the Review-only-mode footer below and run no script. That mode writes no `findings.json`, and a file an earlier pass left in `<reviewDir>` would give a verdict for findings this review never raised. In default mode, run `node scripts/review-verdict.mjs <reviewDir>/findings.json` and emit the **Output Format** below, ending with that command's output pasted verbatim. Its closing block (`Verdict: Ready`, or the numbered steps followed by `Verdict: Blocked`, and a `Needs owner:` line when a step needs a person) is the LAST thing in your final message: no closing prose after it, and no offer of another pass. The block's last line is the message's final line, and the board's Code Review rows route on exactly that line in code (a Text match), so anything after it, even a blank-looking sign-off, sends no task anywhere. A person reading the board and an agent reading the transcript both act on those lines, so never relabel the verdict or soften it in your own words.

## Finders

The driver spawns all finders as **read-only** `Agent` subagents **in parallel**, in the orchestrator-worker fan-out (Step 5 caps how many run at once and says how the rest start). The universal dimension finders always run; the domain auditors are **gated by changed-file globs** and each is its own registered auditor agent, spawned via `subagent_type` - it owns its own checklist, so do not duplicate that checklist in the prompt. Findings come back as **text** (the `Agent` tool returns the subagent's final message, so there is no enforced schema): each finder MUST return a structured list, one block per finding with `severity`, `category`, `location` (`file:line`), `finding`, and `recommendation`, plus the falsifiable triple (`triggeringInput`, `codePath`, `testGap`) for every Correctness/Critical finding.

| Finder | `subagent_type` | Run | Gate (changed-file glob) |
|---|---|---|---|
| Correctness / Performance / Maintainability / Best Practices | `review-finder` (seed with the matching Review Criteria slice) | ALWAYS (one finder per dimension; correctness gets one per `shards:` range, see Step 5) | - |
| Cross-file integration (signatures only) | `review-finder` (special prompt below) | ALWAYS when `changedFiles > 1` | - |
| Test coverage (red-green) | `review-finder` (seed with the red-green coverage criteria below) | ALWAYS when the diff changes behavioral source under `src/`, `app/`, `scripts/`, or `plugins/` (self-skips docs-only / test-only / pure-styling diffs) | - |
| Crypto/pairing security | `crypto-pairing-auditor` | GATED | `src/pairing/**`, `src/channel/**`, `src/notifications/**`, `plugins/**`, `targets/**` |
| Expo/RN platform | `expo-rn-reviewer` | GATED | `app.json`, `app.config.*`, `eas.json`, `plugins/**`, `package.json`, `src/screens/**`, `src/components/**` |

**Explicit, falsifiable criteria (this is the point of splitting).** Each finder prompt must enumerate concrete, falsifiable criteria - never a vague lens like "review for performance." Embed the matching Review Criteria sub-bullets verbatim for the universal finders; the gated finders inherit their auditor's explicit checklist. Every finding must carry a specific `location` (`file:line`) and a concrete `recommendation`. **Correctness / Critical findings must supply the falsifiable triple:** `triggeringInput` (the specific input that triggers the failure), `codePath` (the failing path), and `testGap` (why existing tests miss it). A finding that cannot be stated falsifiably should not be raised.

**Cross-file integration pass - signatures only (stays cheap).** The single-file finders cannot see interactions. The driver computes a compact "diff interface delta" from its own Step 4 diffs alone - **no file bodies, no pack** - and passes only that to the integration finder:

- `changedExports` - added/changed/removed exported signatures
- `typeDeltas` - interface/type member changes (e.g. a field becoming required)
- `storeShapeMutations` - new/removed Zustand store fields
- `importChanges` - added/removed import edges between changed files

It answers questions the per-file finders structurally cannot: an export's signature changed but a caller in another changed file still passes the old shape; a protocol type gained a required field no caller sets. Input is O(signatures) - a few hundred tokens regardless of diff size - so this pass is roughly constant cost. **The driver computes the delta itself and the finder never receives the pack path or gather commands**: in a desktop review the driver delegated the gathering and the "signatures only" finder read 254k tokens of file bodies, 500x its design budget. Its prompt keeps the repo-wide removed-surface `Grep` duty (that needs `Grep`, not file bodies).

**Removed / renamed surface (correctness + integration finders).** When the diff **deletes or renames** an exported symbol, a string constant, a wire-format token, an enum member, or a config key, a repo-wide search is the only way to catch survivors: `tsc` cannot see string-keyed contracts, testID literals, Maestro selectors, references in non-typechecked `.js`/`.mjs`, or test files that reconstruct the old form as string literals. So for each removed/renamed identifier in the signature delta, the correctness and integration finders must `Grep` the **whole repo (including `tests/`, `docs/`, `.maestro/`, and `.js`/`.mjs`)** and flag any surviving reference outside the diff as a finding.

**Test coverage - the red-green pass.** A dedicated coverage finder runs in the same parallel fan-out whenever the diff changes behavioral source under `src/`, `app/`, `scripts/`, or `plugins/` (it self-skips docs-only, test-only, and pure-styling diffs). The gate is the code, not the directory: a `scripts/` or `plugins/` change with a `tests/unit/` file behind it is exactly as reviewable as one under `src/`. It is **read-only** like every other finder; the tests it identifies are written in the Apply Phase by the `test-builder` agent (see "## Apply Phase"). Its single falsifiable question, asked per behaviorally-significant change in the diff:

> Is there a test that would **fail if this change were reverted**?

If not, it reports a **coverage hole**: the `location`, the specific behavior left unverified, why the existing tests miss it (commonly: the line is executed but its effect is never asserted), and a **suggested tier** (unit / component / Maestro) as a hint only. Its read slice is the narrowest of any finder: the pack (which already carries the changed implementation AND changed tests) plus additional TEST files only - its question is answered by tests, so it never reads unchanged implementation bodies beyond the pack. It does NOT re-derive the tier rules or write anything: the authoritative tier classification and the authoring belong to `test-builder` in the Apply Phase, so there is one source of truth for tiering. Scope holes to behavior the diff **introduced or changed** - pre-existing untested code is a separate `/test write` task. Pure refactors with no behavior change, styling, and docs produce no holes.

If a finder errors or returns nothing usable, the review proceeds on the surviving dimensions; note any dropped dimension in the Summary.

## Review Criteria

### Correctness
- Logic errors, off-by-one mistakes, null/undefined risks
- Missing error handling or unhandled promise rejections
- Race conditions or incorrect async/await usage

### Performance
- Unnecessary allocations, re-renders, or repeated work
- Missing memoization where expensive computation occurs
- Inefficient data structures or algorithms

### Maintainability
- Readability: unclear naming, overly complex expressions
- Duplication that should be extracted
- Premature abstractions or over-engineering

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

### Domain-Specific Checks

Each domain is owned by a dedicated **gated auditor finder** (see "## Finders" for the gates). The auditor agent is the single source of truth for its checklist - the driver only spawns it. One line each so the driver knows the coverage:

- `crypto-pairing-auditor` - Noise KK and pairing ceremony, key storage, capability-allowlist client code, E2E push privacy
- `expo-rn-reviewer` - CNG discipline, New Architecture compatibility, FlashList and list performance, font floor and testIDs, the motion and haptics bar, and the repo-wide em-dash and personal-info review

## Model selection

- **Finders** (every parallel subagent, universal and gated): pinned in agent frontmatter, never passed per spawn. The universal finders spawn as `subagent_type: "review-finder"` (`.claude/agents/review-finder.md`: `model: sonnet`, `effort: medium`, `tools: Read, Glob, Grep`). Both parts matter: the restricted roster drops the tool/MCP manifest from every finder's fixed floor (this repo wires four MCP servers, so that manifest is large and a finder needs none of it - under the pack it needs no Bash or git either), and the pinned effort stops a wide fan-out from inheriting the driver session's effort setting. The gated auditors carry the same `model: sonnet` + `effort: medium` in their own frontmatter. Sonnet at medium is enough because the review's depth comes from the structure - many independent finders plus main-agent verification and dedup - not from each finder being a frontier reasoner.
- **The correctness lane** is the same Sonnet-medium `review-finder`, one per `shards:` range (Step 5). Desktop's Phase 0 replayed four shapes over four historical states: one finder, 1500-line shards, one Opus finder, and the shards at high effort. All four found about one late defect per run, so the cheapest shape won. Every finder dimension earns its place: the one late defect no correctness shape found was raised by the performance finder.
- **Synthesis + verification + Apply Phase** (the driver / main loop): the session model at its configured effort. Findings are verified against the code, deduped, and turned into edits here, so the strong model is spent on the one bounded synthesis context rather than across the fan-out. Because `/code-review` runs in a fresh isolated session, this synthesis agent is an independent reviewer (see "Reviewer independence").

## Apply Phase

Default mode applies fixes immediately after the findings table, then commits them (Step 8, see "## Committing the pass"). The commit is **local only, never pushed** - landing the branch is still `/pull-request`'s or `/merge-back`'s job.

**This edits and commits in the worktree it is reviewing, and the task agent's own unfinished work is usually already sitting there.** The board spawns this skill from the Code Review column as an `isolated` + `always_spawn_new` session, but `isolated` isolates the **conversation, not the filesystem**: the session's `cwd` is the task's own worktree, the same tree the task agent has been using.

The two do **not** run concurrently. Entering an isolated column suspends the task agent's main session and kills its PTY (one active PTY per task, in the desktop app's task-move handler), preserving its session id so it resumes when the card leaves. What the suspended agent leaves behind is its **uncommitted working tree** - and by the time you reach Step 8, those files are indistinguishable from your own edits. That is the whole reason Step 8 commits by set math instead of `git add -A`.

Committing the pass is also what keeps the tree legible downstream: a finished pass **normally** leaves a clean tree plus one attributed commit. Normally, not always - a fix that lands on an already-dirty path stays uncommitted by design (see "The mixed-authorship case"), so a dirty tree downstream means one of two things, not one: this pass is still in flight, or it finished and deliberately left those paths mixed. `/pull-request`'s Pre-flight Checks documents both readings.

### How each finding resolves

Every verified finding is fixed in this pass, Lows included. Severity sets the order you work in and how careful a fix must be; it never decides whether a finding gets fixed. There is no "skipped" status. On desktop a skip that waited for a person cost a full Executing round, and on 8+ tasks the answer was always "fix findings". Each finding ends in exactly one of these:

- **`fixed`.** The default. Typical fixes, for orientation rather than as a limit: `any` to a real type; shorthand names expanded; em-dashes and `--` separators replaced; a missing `testID`; chained Bash split into single commands; `cd <path> && git` to `git -C <path>`; a growable list moved to `FlashList`; an animated hook moved off a branch that does not animate; a type narrowed. A rename across many call sites is still a fix, because typecheck verifies it.
- **`fixed` with a `decision`.** When a finding has more than one valid answer (two designs, UX copy, a security or logging policy, deleting code the author just added, two findings that conflict), apply the option you recommend and record `decision: { chosen, alternative }`. The pass never stops to ask. The report's "Decisions made" list and the commit's `Decisions:` lines carry the alternative, so the call is visible and easy to reverse.
- **Out of the diff.** An item outside the diff resolves the same way as one inside it. When you understand the problem, fix it here (`fixed`), with a `decision` when it has more than one valid design. That includes a type error in a file the diff did not touch. A fix whose only unrun check is an unscoped test tier (the full runs CLAUDE.md leaves to CI) counts as fixed, because `/pull-request` runs that tier on CI behind this pass. That never excuses the scoped run of a test this pass wrote or a test file Step 7 names. A missing test for old code is a coverage hole that `test-builder` fills in this pass when this change depends on that code; otherwise it is outside this review, as the coverage finder's scope says. Whatever you cannot finish here becomes a `blocked` finding with a `step`. A pass never files a board task, and the script refuses `followUps` and `followUpTask`. Desktop task 840's second pass ended Blocked and still filed one, so the card went back to Executing while its out-of-diff items went to a To Do task nobody was working.
- **`refuted`.** The code does not bear it out, it cannot be stated falsifiably, it matches the ledger with no new evidence, or the fix would trip a hook the user opted out of. Give the reason; it becomes a `Refuted:` ledger line.
- **`blocked`.** For work this pass did not finish, and only after you tried what you can run yourself. Try first: a release build (`npx expo run:android --variant release --no-bundler`) for a packaged-build check, a capture from a CLI that is installed, a fixture you can generate, a desktop reply replayed through the protocol-faithful stub peer and wire fixtures in `src/devsupport/` (a `fixed` finding with a `decision` whose alternative is a live capture; never hand-edit a recorded capture), a Maestro flow committed for CI to run ("Auto-adding missing tests" step 3). What is left is `blocked`: a fix that broke typecheck twice, an out-of-diff item too large to finish in this pass, a test file that already fails on the base. Give a `reason` and a `step` that says exactly what the task agent must do in this task. Any non-quick blocked finding makes the verdict Blocked, the outcome that sends the card back to Executing. It is also the only route to the task agent. The board's "Back for revisions" row sends it the whole report, but tells it to do the numbered steps above the verdict, so an item that is not a step gets no work.
- **`blocked` with `needsOwner: true`.** The step is one only a person can do: hardware this machine cannot reach (the iOS Notification Service Extension runs only on a physical iPhone, and a simulator cannot prove it; a killed-app push on a real device), a store-console step, a live login with nothing recorded to work from, a decision only the owner can make. The task agent could not do it either, so the card must not go round the loop: on desktop tasks 984 and 985 the same step took three Executing turns that did nothing, about $4 a card. Its `reason` names what this machine lacks. The script prints `Needs owner: <step>` below `Verdict: Blocked`, which matches neither Code Review row, so the card stops in Code Review on this report and wears the board's stopped mark. One such step stops the card even with agent steps beside it: the person's answer may change them, and this session can finish them once they answer. See "After the report".

A finding is **`quick: true`** when its fix is mechanical, at one site, in a file the change touched, and needs no new test: a stale comment or doc line, a renamed local, a wrong path in a message. It resolves like any other finding, is counted on the Summary's "Quick fixes" line, with the fix itself as a row in Changes Applied, and never decides the verdict, even if it ends `blocked`. It never carries a `decision`, because a choice between valid answers is not mechanical. The script refuses the pair.

### Auto-adding missing tests (coverage holes)

When the coverage finder reports a red-green hole on behavior **this diff** introduced, the Apply Phase fills it. A hole is a finding like any other (category `Coverage`): `fixed` once its test is written and green, or written and committed for CI under step 3, and `blocked` only under the rules above. `/pull-request` and CI remain the hard gate behind this pass.

1. **Delegate to `test-builder`** (the `Agent` tool, `subagent_type: "test-builder"`, in `Write mode.`) - one call per hole, or one batched call for several holes in the same area. Pass the hole's `location`, the behavior to pin, and the red-green rationale. `test-builder` owns the authoritative tier choice and the flake discipline, so do not pre-bake the tier - hand it the behavior and let it classify. Pass it step 3 below verbatim: for a Maestro hole those rules replace its own Write mode's multi-run stability checks.
2. **Unit and component tiers.** `test-builder` authors the test and runs ONLY that new file scoped (`npx vitest run <file>` or `npx jest <file>`) to confirm green. Never run the full suite - CI runs it on the pull request.
3. **Maestro tier: written in the pass, run only on a rig that is already up** (Mobile differences item 2). `test-builder` writes the flow from the `testID`s in source, per `.claude/rules/e2e-maestro-runs.md`, in one of the two places CI runs: a new flow under `.maestro/paired/` for paired behaviour, which the `E2E Tests (Paired)` job runs on every pull request, or new steps in `.maestro/smoke.yaml` for a fresh, unpaired install, which the required `E2E Tests (Maestro)` gate runs. A flow anywhere else, `setup/` and `probes/` included, runs nowhere. Then it runs `npx vitest run tests/unit/maestroFlows.test.ts`, the static check of every flow: an unknown command is a parse error that aborts the whole suite before any flow runs.
   - **A local run needs everything already in place:** an emulator (never the physical phone, which is someone's daily device) with `dev:stub` up and a completed pairing, for a `.maestro/paired/` flow (smoke runs against a fresh, unpaired install, which the pass never makes, so a smoke step always goes to CI), and the app on it running this worktree's code (Metro serving this worktree, or an `e2e` APK built from it since its last `src/` change; `/e2e` Step 0 says why a stale binary gives a wrong answer, not a weak one). Then it runs that ONE flow, once: `maestro --device <serial> test <flow>`. It never boots an emulator, starts or switches a rig mode, rebuilds an APK, pairs, or runs a suite: E2E is single-tenant, and a second rig mode kills the first one's bundler.
   - **Otherwise it commits the flow unrun**, and CI runs it on the pull request. Record the hole `fixed` with `decision: { chosen: "<flow path>, committed unrun after the static check, for <the CI job that runs it>", alternative: "a local run on the dev rig through /e2e" }`, so the next pass does not raise it again. A flow that ran green locally is `fixed` with no decision.
   - Never `blocked` because no emulator is up, never a follow-up task, never `.skip`. `E2E Tests (Paired)` is advisory, so `/pull-request` reports its result rather than gating on it, and a red flow there goes to `e2e-flow-doctor`.
4. **Red-green standard.** The test must assert the post-fix behavior such that reverting the change fails it (`.claude/rules/regression-tests-fail-first.md`). Where the change is localized, `test-builder` may briefly toggle the fix to confirm the test goes red, then restore it. A Maestro flow committed unrun cannot be seen red here; say so in its `decision`.
5. If `test-builder` cannot produce a green test, try once more with the behavior stated more narrowly. A test that needs a desktop reply replays one through the stub peer and wire fixtures in `src/devsupport/`, as a `decision` whose alternative is a live capture. If the test needs something this session cannot get and nothing recorded stands in for it (a physical device, the NSE on an iPhone, a live login), the hole is `blocked` with `needsOwner: true`. Never leave a red or `.skip` test behind.

Tests are committed with the rest of the pass (Step 8); they are new untracked files, so they always fall on the committable side of the set rule below. New steps in the tracked `.maestro/smoke.yaml` commit the same way, unless that file was already dirty (see "The mixed-authorship case").

## Committing the pass

Step 8, default mode only. The goal is that a finished pass leaves the worktree **clean**, with its work in one commit whose message says who wrote it.

### What may be committed

This skill deliberately reviews uncommitted work (Step 3: agents "sometimes commit during the working session, sometimes leave changes in the working tree, sometimes both"), so the tree is often **already dirty with the task agent's own unfinished work** when the pass starts. A blind `git add -A` would commit that work under a `refactor(review):` message, which is worse than leaving the tree dirty. So:

> Commit **only** what became dirty during this pass. Never `git add -A`.

Do not try to track "the files the Apply Phase edited" - there is no such value, and `test-builder` is a subagent whose test-file writes are not driver `Edit`/`Write` calls at all, so it would miss them. Use set math over git state instead, which is provable and needs no subagent cooperation. Each command is its own Bash call:

1. `git diff HEAD --name-only` - tracked files dirty now.
2. `git ls-files --others --exclude-standard` - untracked files now.
3. `currentDirty` = the union of those two. **Committable = `currentDirty` minus `preexistingDirty`**, reading `preexistingDirty` back from `<reviewDir>/REVIEW_PREEXISTING_DIRTY.tmp` (written at Step 4) rather than from memory. If that file is missing or unreadable, do NOT guess and do NOT fall back to `git add -A`: skip the commit, and report that the pass could not establish what it may safely commit so the user can stage it themselves.

Anything dirty now that was not dirty at Step 4 is provably this pass's work, whoever wrote it. The edge cases need no special handling: `test-builder`'s new test files are untracked now and were not before, so they commit; a fix on a path the task agent had already left dirty is in both sets, so it is excluded; a fix auto-reverted by the re-typecheck step returns that file to clean, drops out of `currentDirty`, and is never committed.

If Committable is empty, there are no files to commit, but the ledger still has to land: see "The ledger-only commit" below. If the ledger is empty too (nothing refuted, nothing decided), skip the commit and go to the Output Format.

### How to commit

1. Stage each committable path explicitly: `git add <path>`, **one path per Bash tool call** (`.claude/rules/bash-single-command.md` forbids chaining).
2. Run `node scripts/review-verdict.mjs <reviewDir>/findings.json --ledger`. It prints the `Refuted:` and `Decisions:` lines for the body; if it exits 2, fix the findings file it names and run it again. Then write the message to `<reviewDir>/COMMIT_MSG.tmp` with the **Write** tool. Never write to `.git/`; in a worktree `.git` is a file, not a directory.
3. `git commit <path1> <path2> ... -F <reviewDir>/COMMIT_MSG.tmp` - **pass every committable path as a pathspec.** One command with several positional args, so it still satisfies `.claude/rules/bash-single-command.md`. Never use `$(...)` or backtick substitution (triggers a safety prompt).

   **A bare `git commit -F` here is a real bug, not a shortcut.** With no pathspec, `git commit` commits the ENTIRE INDEX. The task agent routinely pauses with work already staged (`git add somefile.ts`, no commit yet); Step 4 correctly puts that file in `preexistingDirty` and Step 8 correctly excludes it from Committable, and then a bare commit sweeps it in anyway because it was sitting in the index the whole time - defeating the set math completely. The pathspec form commits only the named paths and leaves a pre-staged file untouched and still staged. As a cheap assertion, `git diff --cached --name-only` should equal Committable immediately before you commit; if it does not, stop rather than commit.

The message is conventional, and the scope is literally `review`: `fix(review):`, `refactor(review):`, or `test(review):`, picked by primary change type. The body lists what was fixed, one line per finding, then a blank line, then the `--ledger` output verbatim. The ledger is how a later pass knows what this one settled (Step 4 reads it back), so it is never trimmed or wrapped. This repo has no commitlint, so no footer line cap applies (Mobile differences item 5). Name any board task in prose ("task 840"), never as `#N`: GitHub turns `#N` into a link to an unrelated issue. End the message with the session's Co-Authored-By trailer. `allowed-tools` already grants `Bash(git:*)`, so nothing new is needed there.

### The ledger-only commit

When every fix landed on an already-dirty path and no test was added, Committable is empty, yet the ledger still has to reach the branch, or the next pass re-raises everything this one refuted. On desktop, five passes across two tasks committed nothing for exactly this reason. Make an empty commit that carries only the ledger:

`git commit --allow-empty --only -F <reviewDir>/COMMIT_MSG.tmp`

with the subject `chore(review): record refuted findings and decisions` and the `--ledger` output as the body. `--only` with no paths commits nothing from the index, so a file the task agent left staged stays staged, which is the same guarantee the pathspec form gives. A bare `git commit --allow-empty -F` would sweep the whole index in. `/pull-request` keeps this commit through its rebase (git keeps commits that start empty) and finds no test files in it to re-run. The commit rides the PR. GitHub's rebase merge then drops it from `main`, and `/merge-pull-request`'s realign drops the local copy. Nothing is lost, because Step 4 reads the ledger only on this branch, before the merge.

### After the report

If the session continues after the report, for example the user types "fix this too", commit everything that follow-up writes as another `*(review)` commit. Use the same set math against the same Step 4 dirty list, and update `findings.json` and the ledger. A person answering a `Needs owner:` step is this case too: do what they said, finish the pass's other steps, update `findings.json`, then run `node scripts/review-verdict.mjs <reviewDir>/findings.json` again and end on its output. Its last line routes the card, so a reply that ends on anything else leaves the card where it stopped after the person acted. On desktop, fixes a review session wrote and left under another scope fed the next pass code nobody had reviewed, and both were later found to need fixes.

**Use `review` as the scope even though scope usually names a code area.** A review pass is routinely spread across every area it reviewed, so no single area scope is honest, and the useful grouping is which pass produced the commit. It also makes the commit greppable, which the reading side relies on: `/pull-request`'s Pre-flight tells the next agent to expect exactly a `*(review)` commit and to leave it alone rather than squash or reword it. The flip side: no commit that is NOT a review pass may use the `review` scope, or Step 4's since-review walk would read it as one.

**Never push. Never amend an existing commit.** Amending would rewrite the task agent's commit and claim this pass as part of it, which is the misattribution this whole design exists to prevent.

### The mixed-authorship case

When a fix lands on a path that was already dirty, that fix stays uncommitted, mixed into the task agent's work in the same file. The hunks cannot be separated safely, so do not try. Instead the footer must **list those paths by name** - "some fixes left uncommitted" is not enough, because the next agent inherits a dirty tree and needs to know exactly which files hold two authors' work before it stages anything.

**The same split can strand a test.** A coverage-hole test is a new untracked file, so it always falls on the committable side; if the behavior it pins lives in a file that stays uncommitted, the commit lands a test with no corresponding fix in its own history. The working tree is fine (the fix is physically present, just uncommitted), but that commit read in isolation - a bisect, or a later stash of only the dirty paths - is not. When it happens, commit it and say so explicitly in the footer: "test committed without its target fix (see the mixed-authorship list)."

## Output Format

### Findings Table

Present every verified finding in a single table, sorted by severity (Critical first, then High, Medium, Low), with the status it ended in:

| # | Severity | Category | Location | Finding | Fix | Status |
|---|----------|----------|----------|---------|-----|--------|
| 1 | High | Correctness | `src/channel/foo.ts:42` | Brief description of the issue | What changed and why | fixed |
| 2 | Medium | Performance | `src/screens/Bar.tsx:88` | Brief description | The option chosen | fixed (decision) |
| 3 | Low | Maintainability | `src/state/baz.ts:10` | Brief description | - | refuted |

#### Severity levels

| Severity | Meaning |
|----------|---------|
| **Critical** | Type errors, runtime crashes, data loss, security vulnerabilities |
| **High** | Logic bugs, missing error handling, `any` types, race conditions |
| **Medium** | Performance issues, convention violations, unclear code |
| **Low** | Style, minor duplication, small improvements |

Severity sets how much risk a finding carries and the order you fix things in. It does not decide whether a finding is fixed: every verified finding is.

### Default-mode report

After the findings table, run the Apply Phase and then emit the sections below. The verdict script's output comes last, verbatim:

```
### Changes Applied (N)

| # | File:Line | What changed |
|---|-----------|--------------|
| 1 | src/channel/foo.ts:42 | Replaced `any` cast with the protocol's `Frame` type |
| 2 | src/screens/Bar.tsx:15 | Renamed `sess` -> `session` (3 sites) |

### Tests Added (K)

| # | Test file | Tier | Behavior pinned (red-green) |
|---|-----------|------|------------------------------|
| 1 | tests/unit/foo.test.ts | unit | a dropped frame is retried once, then reported |

### Refuted (R)

- src/state/baz.ts selectTasks: empty-array every - vacuous truth is the intended result, pinned by baz.test.ts

### Blocked (B)   <- only when B > 0

| # | Location | What this pass tried | Step for the task agent |
|---|----------|----------------------|--------------------------|
| 4 | src/channel/subscriptionManager.ts:40 | Spans every subscribe caller, too large for this pass | Route the screen-driven re-subscribes through the bounded queue in this task |

### Committed

`refactor(review): <subject>` as `<sha>` - P files.

Then the tree status, which is COMPUTED, not boilerplate: print `No uncommitted files.` only when
nothing was left behind. If anything was, print `N file(s) left uncommitted (mixed authorship).`
instead - never print "No uncommitted files" directly above a non-empty list, which is the
contradiction this line exists to avoid.

Left uncommitted (already dirty before this pass, so they hold two authors' work):
- src/state/qux.ts

### Pass record
- Files reviewed: N
- Pack: <size>KB, <L> lines, <B> bodies (<W> windowed), <H> hunk sections, <S> stubbed (<paths, or none>); <F> finders (<C> correctness shards; since-review pack: <lines>, or none); reads beyond the pack: <R> (<path: finder, criterion>, or none)
- Maestro: <n> flows written, <m> run locally (or none)

<the output of `node scripts/review-verdict.mjs <reviewDir>/findings.json`, verbatim: its Summary,
its Decisions made list, and its closing block. Nothing follows the closing block.>
```

The closing block reads, for example (the steps first, then the verdict):

```
1. src/channel/subscriptionManager.ts:40: route the screen-driven re-subscribes through the bounded queue in this task
Verdict: Blocked
```

With a step only a person can do, its line comes last, and the card stops where it is:

```
1. targets/nse/NotificationPruning.swift:40: run the NSE probe on a physical iPhone and report what it shows
Verdict: Blocked
Needs owner: run the NSE probe on a physical iPhone and report what it shows
```

Edge cases the report must handle cleanly:
- No diff at all (committed-vs-base, uncommitted, and untracked all empty) -> short-circuit at the diff-gather step (Step 4) with the output of `node scripts/review-verdict.mjs --no-changes <base>`: "No changes to review.", then one step and `Verdict: Blocked`, which the Back for revisions row sends to Executing. Review-only mode prints "No changes to review." alone.
- Diff exists, zero quality findings -> skip the fix step, but STILL run the coverage pass; if it reports holes on diff-introduced behavior, write them (Tests Added) and report. With no findings at all, the findings JSON has an empty `findings` array and the script prints `Verdict: Ready`.
- A fix breaks typecheck -> revert it and try once more with a different fix. If the second attempt also fails, the finding is `blocked` and the report shows the error. The `typecheck` check records the final tree, so it is `fail` only when the tree as left does not typecheck.
- Committable set empty at Step 8 (every fix landed on an already-dirty path) -> make the ledger-only commit when the ledger is non-empty, and STILL list the mixed-authorship paths and say the worktree was left dirty, so the reader knows the clean-tree handoff did not happen
- Committable NON-empty while some fixes also landed on already-dirty paths (the common mixed case) -> emit `### Committed` for what did land, and do NOT report "No uncommitted files.": print `N file(s) left uncommitted (mixed authorship)` and list them, because the tree is by definition not clean

### Review-only-mode footer

When `review-only` is in `$ARGUMENTS`, skip the Apply Phase and the Step 8 commit, and emit the legacy footer:

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** one of:
  - **Ship it** - no findings, or only low-severity items
  - **Minor issues** - medium findings worth addressing, no blockers
  - **Needs revision** - critical or high-severity findings that should be resolved

## Allowed Tools

The driver uses `Bash` (git/npm/npx/node only) for pre-flight, diff gathering and the verdict script, the `Agent` tool to fan out the read-only finder subagents, and owns `Read`, `Edit`, `Write`, `Glob`, `Grep` for verification and the Apply Phase. `Write` is for fixes, tests, `findings.json`, the finder queue and the commit message, never for the review pack (see Step 4). A pass never creates a board task: what it cannot finish goes to the task agent as a `blocked` step, or to a person through `Needs owner:`. `review-only` mode performs no edits (the finders are read-only regardless). Always run commands from the project root - no chained commands (`&&`, `||`, `|`, `;`).

**No headless `claude`, no `Workflow`.** All orchestration is in-session via the `Agent` tool. Never invoke `claude -p`, `claude --print`, `git diff | claude ...`, or any other headless `claude` shell pipeline, and do not use the `Workflow` tool - the finders are spawned directly as parallel `Agent` subagents and synthesized in the main loop.

**CRITICAL: Use `git -C <path>` for all git commands in other directories.** Never use `cd <path> && git ...` - the `cd && git` pattern triggers an unbypassable Claude Code security prompt.

**Commit this pass, and nothing else.** Step 8 commits only what became dirty during this pass, so the worktree returns to clean with the work attributed. Never `git add -A`, never touch work that was already uncommitted when the pass started, never amend, and **never push** - landing the branch stays `/pull-request`'s job, or `/merge-back`'s for a direct quick-push. See "## Committing the pass".
