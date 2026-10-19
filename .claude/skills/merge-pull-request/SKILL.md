---
description: Merge an already-green PR (rebase merge, delete branch) and fast-forward the local main checkout. This is the Merge column skill. It assumes the Testing column (/pull-request) already drove the PR to green. Not for creating a PR (use /pull-request) or a direct quick-push (use /merge-back).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(gh:*), Agent, mcp__kangentic__kangentic_get_current_task, mcp__kangentic__kangentic_link_pr
---

# Merge Pull Request

Merge a green pull request and pull the result back into the local `main` checkout. This is the
**Merge column** skill. It assumes the **Testing column** (`/pull-request`) already created the
PR and drove its CI checks to all-green.

It verifies the required CI checks are green, then merges with `--admin` to waive the review
requirement: `main` requires one approving review, but a maintainer's own PRs get no second
reviewer, so that bypass is the normal Merge-column path. It NEVER bypasses the CI checks - those are
confirmed green first; `--admin` only waives the missing review. For a deliberate direct
quick-push that skips the whole PR gate, use `/merge-back` instead.

A run that merged and finished ends on the line `PR: merged`, and the Merge column's "Finish"
turn-end row (`kangentic.json`) reads that line and moves the task to Done. See "Outcome line"
below.

**Usage:** `/merge-pull-request`

## Mobile differences from the desktop repo's flow

- **CI is live, and `main` is protected.** `.github/workflows/ci.yml` runs each check as its own
  parallel job: `Lint (ESLint)`, `Type check (tsc)`, `Unit Tests (Vitest)`,
  `Component Tests (Jest)`, `Native config (prebuild)`, and `Release counters (stores)`
  (pull requests only). `.github/workflows/e2e.yml` adds
  `E2E Tests (Maestro)`, which is the long pole because it builds an APK and boots an
  emulator. Plus `cla`. Step 2's green-check
  requirement means every registered check in the rollup, never `CLA Assistant` alone. Confirm
  the names with `gh pr checks <pr>` before merging; this matters because the merge here uses
  `--admin`, which waives the missing review but must never waive CI.
- **Protection uses strict status checks,** so a PR that has fallen behind `main` cannot merge
  even when green. Rebase it rather than reaching for a harder bypass.
- **No HMR dogfooding concern.** Desktop's version of this skill fast-forwards the local
  checkout "so `npm start` picks it up via HMR." This app is not dogfooded from its own dev
  server, so the fast-forward in Step 4 exists to keep the local checkout current, not for HMR.

## Pre-flight Checks

All git commands run from the **current working directory** - never `cd <path> && git ...`. Use
`git -C <path>` to target another directory.

1. **Detect mode:** worktree mode requires CWD to contain `.kangentic/worktrees/`. If this is
   the main repo (no worktree), stop and tell the user this skill runs from a task worktree (the
   Merge column); a direct push from the main checkout is `/merge-back`.
2. Get the current branch: `git rev-parse --abbrev-ref HEAD`. If `HEAD` (detached), warn and
   stop.
3. Derive the project root: two directories above `.kangentic/worktrees/<slug>/`.
4. Determine the source branch: `git config kangentic.baseBranch` (fallback: `main`).
5. Verify GitHub CLI auth: `gh auth status`. If it fails, report and stop.

## Step 0 - Resolve the PR (by stored number first, head branch as fallback)

The PR's head branch may NOT equal the worktree's local branch (`/pull-request` pushes the
unchanged local branch to a clean public remote name and opens the PR from that). Resolve by the
stored `pr_number` first, falling back to the head branch only when there is no stored number.

1. `<branch>` is the current LOCAL branch from pre-flight, used later only for local git
   operations, never for `gh pr` lookups.
2. Resolve the PR number `<pr>`: call `kangentic_get_current_task` (it reads the worktree's
   task) and take its `pr_number`. Record the task's ID as `<taskId>` for the board refresh in
   Step 3. If no `pr_number`, fall back to
   `gh pr list --head <branch> --state open --json number`.
3. `gh pr view <pr> --json number,url,state,mergeable,mergeStateStatus,statusCheckRollup,headRefName,headRefOid`.
   Record `<prHead>` = `headRefName` (the PR's remote head branch, the push and merge target).
4. If no PR resolves either way, stop and report that the Testing column should have created one
   (`/pull-request` first). Do not create a PR here.
5. **If `<pr>` already reads `MERGED`, check it is THIS worktree's work** before carrying on. It
   is when `HEAD` equals its `headRefOid` (merged, realign not yet run) or
   `git merge-base --is-ancestor HEAD origin/<sourceBranch>` exits 0 (already realigned). If
   neither holds, the stored number is an earlier PR on this task and the commits here are not on
   `<sourceBranch>`: stop and report that the task's `prNumber` names a finished PR, with no
   outcome line. Carrying on would print `PR: merged`, and Done would remove a worktree whose work
   never landed.

Every later `gh pr` command targets `<pr>` or `<prHead>`; the local `<branch>` is for local git
only.

## Step 1 - Doc review at merge time

Re-audit the anchor files across the whole branch diff. `/pull-request` audits at commit time,
on a clean tree too, but a commit can land after that audit (a Step 7 CI fix, a rebase that pulled
in an anchor change), so this is the last check before the merge, not a repeat of a skipped one:

1. Determine the anchor source files in the branch diff (`git diff` against
   `origin/<sourceBranch>`), narrowed to the canonical anchor list in
   `.claude/skills/sync-docs/SKILL.md`. If none, skip to Step 2.
2. Spawn a `doc-auditor` agent with the matching anchor files; fix any reported gaps inline with
   `Edit`.
3. If docs changed, commit them (`docs:` message via `.kangentic/COMMIT_MSG.tmp`) and push to
   the PR's remote head: `git push origin HEAD:<prHead> --force-with-lease`.

## Step 2 - Re-verify (rebase if source moved, confirm green and mergeable)

1. `git fetch origin <sourceBranch>`.
2. If `<sourceBranch>` moved since the PR went green, rebase onto it:
   `git rebase origin/<sourceBranch>` (resolve conflicts as `/pull-request` does, or abort and
   report). If the rebase changed history, push: `git push origin HEAD:<prHead> --force-with-lease`.
3. Re-read the PR state: `gh pr view <pr> --json mergeable,mergeStateStatus,statusCheckRollup`.
   **Require every required status check in `statusCheckRollup` to be green.** `mergeStateStatus`
   will usually read `BLOCKED` because the maintainer's own PR has no approving review; that
   block is expected and waived by `--admin` in Step 3. If a required CHECK is failing or still
   pending, stop or wait; never `--admin` past a red or pending check.
3b. **Check the SET, not just the states.** A check that has not registered yet is absent from the
   rollup, and absent reads exactly like green when you are only scanning states. `E2E Tests
   (Maestro)` registers late by design: its job `needs` the APK build and the smoke suite, so it
   does not appear for roughly ten minutes after a push. Compare explicitly, as ONE `jq`
   expression over two JSON documents:

   ```
   req=$(gh api repos/Kangentic/mobile/branches/main/protection/required_status_checks --jq '.contexts')
   rep=$(gh pr checks <pr> --repo Kangentic/mobile --required --json name,state)
   jq -n --argjson req "$req" --argjson rep "$rep" \
     '{required: ($req|length), green: ([$rep[]|select(.state=="SUCCESS")]|length), missing: ($req - [$rep[]|select(.state=="SUCCESS")|.name])}'
   ```

   `missing: []` is the only green. A non-empty `missing` means "not reported yet", so wait; it
   does **not** mean the check does not apply. `--admin` waives the review requirement only, so it
   will happily merge past a required check that never ran.

   **Never implement this with `comm`, `diff`, or sort-and-compare over text lines.** `gh api --jq`
   emits `\n` and `gh pr checks --json | jq` emits `\r\n` on Windows, so the two sides never
   compare equal. Observed: `comm -23` called seven of eight required checks missing on a fully
   green PR. `comm` on input not sorted in its own collation is unspecified, so treat the answer as
   garbage rather than as wrong-but-predictable: every measured case over-reported, and nothing
   establishes it cannot under-report, which here would be a false all-green merged by `--admin`.
   `tests/unit/requiredChecksComparison.test.ts` pins the jq form and reproduces the failure.
4. If the rebase re-triggered checks and they are pending, wait with
   `gh pr checks <pr> --required --watch --fail-fast --interval 30` (Bash `timeout` up to its max,
   600000ms), then re-run the 3b comparison, because the watch returns as soon as the checks
   registered SO FAR are done. If they go red, stop and report.

## Step 3 - Merge the PR

Only after Step 2 confirmed every required check is green:

`gh pr merge <pr> --admin --rebase --delete-branch`

- `--admin`: waives the required approving review only. It does NOT relax the CI gate.
- `--rebase`: lands individual commits with no merge commit.
- `--delete-branch`: deletes the remote PR head branch (`<prHead>`); the local `<branch>` has a
  different name and stays for the realign below.

**Merge-method fallback:** if `--rebase` fails with "can't be rebased" (the PR history contains
a merge commit), fall back to squash: `gh pr merge <pr> --admin --squash --delete-branch`. Do
NOT use `--merge` (a merge commit breaks the linear-`main` convention). Record `<mergeMethod>`
(rebase or squash) for the realign below.

If the merge fails for any other reason than the expected missing-review block, do not force
past it; report the unmet requirement and stop.

**A non-zero exit is not proof the merge failed.** `gh pr merge` merges and deletes the remote
head first, then checks out the source branch locally, and that last step fails with
`'main' is already used by worktree` whenever the local branch IS the PR head (a release branch;
`/pull-request` pushes normal task branches to a different name). So on any error, read
`gh pr view <pr> --json state` before deciding: `MERGED` means carry on to the realign as if the
merge had reported success.

### Refresh the board's PR status

If Step 0 resolved a `<taskId>`, call `kangentic_link_pr` with that task ID right after the
merge succeeds, so the board card flips to "merged" immediately instead of waiting for the
background refresh timer.

### Realign the worktree branch (so move-to-Done reads clean)

1. Confirm the worktree is clean: `git status --porcelain` (should be empty right after the
   merge). If not empty, skip the realign and report; never discard uncommitted work.
2. `git fetch origin <sourceBranch>`.
3. Realign by `<mergeMethod>`:
   - **rebase merge:** `git rebase origin/<sourceBranch>` (drops the now-merged commits by
     patch-id).
   - **squash merge:** `git reset --hard origin/<sourceBranch>` (safe only because Step 1
     confirmed the worktree is clean).
4. On a rebase conflict, abort cleanly (`git rebase --abort`) and report. Never leave a
   half-finished rebase.

## Step 4 - Pull back into the local main checkout

1. Fast-forward it: `git -C <projectRoot> pull --ff-only`. If it succeeds, done.
2. If it fails, diagnose rather than soft-warn:
   a. `git -C <projectRoot> status -sb` for ahead/behind counts.
   b. Behind only (ahead 0) but ff still failed: uncommitted changes in the working tree. Report
      and stop; do not stash or discard.
   c. Ahead (unpushed local commits): list them
      (`git -C <projectRoot> log --oneline origin/<sourceBranch>..<sourceBranch>`) and name them.
3. Offer to reconcile the ahead case (do not do it silently): rebase
   (`git -C <projectRoot> rebase origin/<sourceBranch>`), or push if the user wants those commits
   upstream. On conflict, abort cleanly and report manual steps.

## Step 5 - Report

Summarize: PR URL and the branch merged; the source branch and commit count landed; branch
cleanup status (remote PR head deleted, local worktree branch realigned); local `main` checkout
status. Then, only when "Outcome line" below allows it, the last line of the message, alone:
`PR: merged`. On the board that moves the task to Done, which triggers worktree cleanup. Outside
the Merge column nothing reads the line, so remind the user to move the task to Done.

## Outcome line

The Merge column's "Finish" row (`kangentic.json`) is a Text match: each time a turn ends here,
it reads the last line of your final message that still has a word in it, ignoring case,
punctuation and markdown, and moves the task to Done only when that WHOLE line reads
`PR: merged`. Done archives the card and removes its worktree, so the line is a contract, and
this section and that row change together (`tests/unit/boardTurnEndContracts.test.ts` fails when
they drift):

- `PR: merged` comes only from Step 5, and only when all three hold:
  - `gh pr view <pr> --json state` reads `MERGED`. Read it; never infer it from `gh pr merge`'s
    exit code (see Step 3).
  - The realign finished with a clean worktree. A realign skipped for uncommitted work, or
    aborted on a conflict, leaves work or commits in the worktree that Done would remove.
  - Step 4 fast-forwarded the main checkout. When Step 4 stops to report, or offers to reconcile
    the ahead case, print no line. The row checks again at every turn end until it runs, so the
    turn that finishes the reconciliation ends on `PR: merged` instead.
- Every other stop prints no outcome line, and the card waits in Merge for a person: the main repo
  and detached-HEAD pre-flight stops, a failed `gh auth status`, no PR resolved in Step 0, a
  stored PR that merged without this worktree's commits (Step 0, item 5), a Step 2 rebase that
  aborted, a required check that is red, pending or missing, a merge refused for anything but the
  missing review, and the realign and Step 4 stops above.

The `PR:` prefix marks a pull request outcome, shared with Testing's `PR: ready to merge`. Code
Review ends on `Verdict: Ready`.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never `&&`,
`||`, `|`, `;`. Use `git -C <path>` in another directory. Conventional commit messages. No
em-dashes or `--` as punctuation.
