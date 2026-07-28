---
description: Create a PR and drive its CI checks to all-green (auto-fixing code along the way), then stop. Never merges. This is the Tests column skill. Use /merge-pull-request to merge a green PR.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(gh:*), Agent
argument-hint: [commit message]
---

# Pull Request

Commit, rebase, create a pull request, and drive its CI checks to all-green. This is the **Tests
column** skill: it offloads CI checks to GitHub Actions instead of running them on the local
machine, then auto-fixes any failures until the PR is green.

It **never merges**. When the PR is green, the user manually moves the task Tests -> Ship It,
where `/merge-pull-request` merges it and pulls the result back into the local `main` checkout.

**Usage:** `/pull-request [commit message]`

**User-provided commit message (if any):** $ARGUMENTS

## Mobile differences from the desktop repo's flow

- **CI is live, and `main` is protected.** `.github/workflows/ci.yml` runs each check as its own
  parallel job: `Lint (ESLint)`, `Type check (tsc)`, `Unit Tests (Vitest)`,
  `Component Tests (Jest)`, `Native config (CNG)`. `.github/workflows/e2e.yml` adds
  `E2E Tests (Maestro)`. Plus `cla`. Never treat `CLA Assistant` alone as all-green: confirm the
  registered check names with `gh pr checks <branch>` and wait for every one of them. A real check
  can take a moment to register after a push, so if only `CLA Assistant` appears, re-poll rather
  than concluding no other check is coming.
- **E2E is the long pole.** It builds a real signed APK and boots an Android emulator, so budget
  far longer for it than the other tiers and do not mistake its pending state for a hang. The
  component tier also surfaces per-shard jobs (`Component Tests (1/2)`, `(2/2)`); those are an
  implementation detail, and the single gate check per tier is what protection requires.
- **`E2E Tests (paired)` is advisory and must stay that way.** It runs the 11 paired flows and
  reports on every PR, but is not a required check. If it goes red, diagnose it through
  `e2e-flow-doctor`; never drive it green by weakening the job, raising a timeout, or relaxing
  `tests/unit/ciSafeMaestroFlows.test.ts`. A red advisory check does not block the merge.
- **The branch must be up to date with `main` before merging** (protection uses strict status
  checks), so a PR that has fallen behind needs a rebase even when every check is green.
- Android release builds and the iOS compile check are dispatch or tag triggered, so they never
  register on a PR. Do not wait for them.
- **Local gate.** Run `npm run typecheck` and `npm run lint` before pushing.
- **Coverage pass** runs against the live test harness.

## Pre-flight Checks

All git commands run from the **current working directory** - never `cd <path> && git ...`
(triggers an unbypassable security prompt). Use `git -C <path>` to target another directory.

1. **Detect mode:**
   - If CWD contains `.kangentic/worktrees/` - **worktree mode** (the flow below).
   - Otherwise - **main repo mode** (fall back to `/merge-back` behavior).
2. Get the current branch: `git rev-parse --abbrev-ref HEAD`. If `HEAD` (detached), warn and
   stop.
3. **Worktree mode only:** derive the project root by walking up from the worktree path (strip
   `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch:
   - **Worktree mode:** `git config kangentic.baseBranch` (fallback: `main`).
   - **Main repo mode:** the current branch.
5. Run `git status --porcelain` to check for uncommitted changes.
6. Verify GitHub CLI auth: `gh auth status`. If it fails, report and stop.

**Main repo mode:** fall back to `/merge-back` behavior and stop. The PR workflow below applies
to worktree mode only.

## Step 0 - Local gate

The point of this skill is to offload checks to CI. Keep the local gate fast:

1. If `node_modules` is missing (a fresh worktree does not share it with the main repo), run
   `npm install` first.
2. Run `npm run typecheck`; stop on failure.
3. Run `npm run lint`; stop on error (warnings do not block).

## Step 1 - Commit changes

If there are uncommitted changes (non-empty `git status --porcelain`):

1. Show `git status` and `git diff --stat`.
2. Determine the commit message (see `/commit`'s Step 2 logic - conventional commit format,
   type inferred from the diff if not supplied).
3. **Targeted doc-anchor check.** Identify changed source files (exclude `docs/`, `.claude/`).
   Read the canonical anchor list from `.claude/skills/sync-docs/SKILL.md`. If any changed file
   matches an anchor, spawn a `doc-auditor` agent with the matching files and fix any reported
   gaps with `Edit` before staging.
4. Stage: `git add -A`.
5. Write the message via the **Write tool** to `.kangentic/COMMIT_MSG.tmp`, then
   `git commit -F .kangentic/COMMIT_MSG.tmp`.

If the working tree is clean, skip to Step 1.5.

## Step 1.5 - Compute the clean public branch name (never rename the local branch)

The local branch, the worktree folder, and the task's stored branch name together encode this
Kangentic board's session identity, the same way they do in the desktop repo. Never rename the
local branch.

1. `<type>` = the conventional prefix of the Step 1 commit message.
2. `<desc>` = a kebab slug of the work: resolve the task with `kangentic_get_current_task`
   (pass the worktree cwd + the local branch) and slugify its title (lowercase, hyphen-joined,
   drop filler words, cap to ~4-5 meaningful words, `[a-z0-9-]` only, no
   leading/trailing/consecutive hyphens). If `$ARGUMENTS` supplied a name, prefer it.
3. `<branch>` = `<type>/<desc>`.
4. **Resuming:** if the task already has a PR (`task.pr_number` set), reuse that existing remote
   name as `<branch>`.

## Step 2 - Fetch latest source branch

`git fetch origin <sourceBranch>`.

## Step 3 - Rebase onto source branch

`git rebase origin/<sourceBranch>`. On conflicts: show the conflicting files
(`git diff --name-only --diff-filter=U`), resolve with `Edit`, `git add <file>`,
`git rebase --continue`, or `git rebase --abort` on user request.

## Step 3.5 - Coverage pass (gated)

If `package.json` exists and the diff (`git diff origin/<sourceBranch>...HEAD`) touches source
files, spawn one `test-builder` agent in write mode scoped to the diff: "Audit coverage of this
diff and implement any genuinely missing tests, following the tier rules and anti-flake
patterns. A clean no-op is fine if coverage is already adequate." If `package.json` does not
exist yet, skip.

## Step 4 - Push

`git push origin HEAD:<branch> --force-with-lease`. Never bare `--force`.

## Step 5 - Create the PR

1. PR title = the first line of the most recent commit.
2. PR body: write to `.kangentic/PR_BODY.tmp` with the Write tool, mirroring
   `.github/pull_request_template.md` (`## What` / `## Why` / `## How` / `## Breaking changes` /
   `## Tests`, footer `Generated with [Claude Code](https://claude.com/claude-code)`).
3. `gh pr create --base <sourceBranch> --head <branch> --title "<title>" --body-file .kangentic/PR_BODY.tmp`.

If PR creation fails because one already exists, `gh pr view <branch>` and proceed to Step 5b.

## Step 5b - Link the PR to the task

1. Extract the PR URL and number from the `gh pr create` (or `gh pr view`) output.
2. Find the task with `kangentic_get_current_task` (pass the worktree cwd + the local branch).
3. Call `kangentic_link_pr` with the task ID and PR number/URL. This is required, not
   best-effort: `<branch>` (the PR head) differs from the worktree's local branch by design, so
   the board's branch-based auto-detection will not find this PR otherwise.

If the `kangentic` MCP is unavailable, do not abort: keep going with the PR work, and retry the
link once it reconnects. If it never returns this run, report the PR number prominently.

## Step 6 - Monitor checks until green

`gh pr checks <branch> --required --watch --fail-fast --interval 30`, Bash `timeout` at its max
(600000ms). Treat a non-zero exit while checks are pending as status, not a tool failure; re-run
the same `--watch` command if the timeout fires with checks still only pending. If `CLA Assistant`
is the only check registered, do not call that all-green: the `ci.yml` checks may not have
registered yet, so re-poll before concluding it is genuinely the only one.

**`--required` is load-bearing, do not drop it.** Without it the watch also waits on
`E2E Tests (paired)`, which is advisory and cannot block a merge, and `--fail-fast` then aborts the
whole poll on a red check that blocks nothing. Measured on PR #28: the required gate went green at
04:06:15 and paired at 04:12:40, so an unfiltered watch spends **6m25 of dead wait on every PR**.

**13 check runs report** on a PR to `main` (7 from `ci.yml`, 5 from `e2e.yml`, 1 from
`cla.yml`). Seven of them are required and are the only ones this watch sees:
`Lint (ESLint)`, `Type check (tsc)`, `Unit Tests (Vitest)`, `Component Tests (Jest)`,
`Native config (CNG)`, `E2E Tests (Maestro)`, and `cla`. The rest are shard jobs and
intermediate jobs that the thin gate checks already aggregate.

### The watch can return green having seen only SOME of the required checks

`--watch` finishes when every **currently registered** check is done. It has no idea a required
check is still coming, and `E2E Tests (Maestro)` registers LATE: its job `needs` the APK build and
the smoke suite, so it does not appear for roughly ten minutes. Observed on PR #29: the watch
exited 0 with six required checks green, `Build (APK)` still running, and `E2E Tests (Maestro)`
not yet registered at all. Reporting all-green there would have been wrong.

So a returned watch is **not** the completion signal. Confirm the set before believing it:

1. Read the authoritative list, rather than trusting the one written above to be current:
   `gh api repos/Kangentic/mobile/branches/main/protection/required_status_checks --jq '.contexts'`
2. Read what has actually reported: `gh pr checks <branch> --required --json name,state`
3. **Every context from step 1 must be present in step 2 and in a passing state.** If any is
   missing, it has not registered yet: re-run the watch. If any is pending, same.

Only when the two sets match is the PR green. This is the same trap as the `CLA Assistant`-only
case above, one level up: absence reads exactly like success, and only an explicit comparison
tells them apart.

**Then read the advisory check once, without blocking on it.** After the required watch returns
green, run `gh pr checks <branch> --json name,state,link` and pull out `E2E Tests (paired)`. Report
its state in Step 8: green, red, or still running. If it is red, diagnose it through
`e2e-flow-doctor` per the rule above; never drive it green by weakening the job. If it is still
running, say so plainly rather than waiting for it.

**A CONFLICTING PR reports only `cla`, and it looks identical to "checks have not registered
yet".** GitHub cannot compute a merge ref for a PR with conflicts, and `pull_request` workflows
run from that merge ref, so `ci.yml` and `e2e.yml` never start at all. `cla.yml` still reports,
because it triggers on `pull_request_target`, which resolves against the base branch instead.

So the re-poll advice above has a floor: if only `cla` has reported after a couple of polls,
check `gh pr view <pr> --json mergeable,mergeStateStatus` before waiting any longer.
`CONFLICTING` / `DIRTY` means no amount of polling will help. Rebase onto `origin/main` and
force-push with `--force-with-lease`. This is easy to hit when another PR merges while yours is
in flight, which is exactly when you are least expecting the check list to be empty.

**A stacked PR reports green having run nothing.** `ci.yml` and `e2e.yml` both filter
`pull_request` to `branches: [main]`, so a PR whose base is another feature branch gets only
`cla`. If the base is not `main`, the PR checks are not the gate: dispatch it instead with
`gh workflow run ci.yml --ref <branch>` (and `e2e.yml`), watch those runs, and link them from the
PR so a reviewer can see the gate was exercised. Do not report all-green off a check list that
only contains `cla`.

## Step 6b - Build both platforms before handing off

**Neither build workflow is PR-triggered**, so every check above can be green while nothing has
ever been compiled for either platform. A PR that changes native config, a config plugin,
`app.config.ts`, `eas.json`, `package.json`, or anything under `plugins/` can pass the whole gate
and then fail the first real build. That is exactly how a broken config-plugin import shipped once.

**Dispatch only when the diff can actually break a build.** These are expensive and slow, and the
hazard they guard is native-config breakage, so run them when the diff touches any of:
`app.config.ts`, `plugins/**`, `package.json`, `package-lock.json`, `eas.json`, `targets/**`, or
`.github/workflows/build-*.yml`. A JS-only or docs-only diff skips both and says so in the report.
When in doubt, run them: a runner is free and a broken build found after merge is not.

**Dispatch AFTER Step 6's required checks are green, never alongside them.** These runs compete
with `e2e.yml` for the same free-tier runner pool, and the E2E emulator jobs are the ones that
suffer: on run 30305146576 the `E2E Tests (paired)` job was eligible at 21:11 and did not start
until 21:29, an 18 minute queue, with both build workflows dispatched on the same branch at 21:02.
Other runs showed no gap, so this is contention rather than a guaranteed stall, but sequencing
costs nothing and removes it.

```
gh workflow run build-android.yml --ref <branch> -f profile=preview
gh workflow run build-ios.yml --ref <branch> -f target=simulator
```

- Get the run ids from `gh run list --workflow <file> --limit 1 --json databaseId,status`, then
  watch with `gh run view <id> --json status,conclusion,jobs`.
- **Budget roughly 11 minutes for Android `preview` and 30 for the iOS simulator**, running in
  parallel, so about half an hour in total. Measured, not estimated: run 30305149504 took 10m41
  and run 30305151823's `Simulator (unsigned compile check)` job took 30m31. An earlier version of
  this skill said "11 minutes" for iOS, which is off by 3x and invites treating a healthy run as a
  hang.
- **iOS `target=simulator`, never `device`.** A device build consumes signing material and is a
  release path, not a check. Leave `submit` alone entirely.
- The iOS simulator job also **launches** the app and uploads a screenshot, so this doubles as a
  runtime smoke test rather than only a compile check.
- Feed failures into the Step 7 auto-fix loop the same as any other check.

## Step 7 - Auto-fix loop (max 3 rounds, fully automatic)

For each failing or flaky check: pull the failure detail (`gh run view <run-id> --log-failed`),
classify (real regression vs broken test vs flaky test), fix with `Edit` or delegate to
`test-builder`, commit (conventional message via `.kangentic/COMMIT_MSG.tmp`), push
(`git push origin HEAD:<branch> --force-with-lease`), then return to Step 6. After 3
unsuccessful rounds, stop: report the classification and root cause per failing check, plus the
PR URL, and do not `--admin` bypass.

## Step 8 - Report (success)

Report the PR URL, branch name, commit count, and "All required checks green." Include:

- The two build runs from Step 6b with their conclusions, or say plainly that they were skipped
  and why. "All checks green" without a build run behind it overstates what was verified, because
  the PR gate does not build either platform.
- **`E2E Tests (paired)`'s state**, read non-blocking in Step 6. Say green, red, or still running.
  Never fold it into "all green": it is advisory, so a green required gate proves smoke coverage
  only. A reader who wants the paired suite's verdict has to be told it separately.

Next step: the user moves the task Tests -> Ship It, where `/merge-pull-request` merges it. Do
NOT merge.

## Rules

**CRITICAL: No chained commands.** Every Bash call is exactly ONE command. Never `&&`, `||`,
`|`, `;`. Use `git -C <path>` in another directory. Conventional commit messages. No em-dashes
or `--` as punctuation.

**Never fork a side-check while this skill is active.** A `subagent_type: "fork"` inherits the
full conversation context and can pick up and independently execute the rest of this skill. To
check on a background agent, wait for its `<task-notification>` instead.
