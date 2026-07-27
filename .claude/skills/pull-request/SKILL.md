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
  parallel job: `Lint (ESLint)`, `Type check (tsc)`, `Unit tests (Vitest)`,
  `Component tests (Jest)`, `Native config (expo prebuild)`. `.github/workflows/e2e.yml` adds
  `E2E tests (Maestro)`. Plus `cla`. Never treat `CLA Assistant` alone as all-green: confirm the
  registered check names with `gh pr checks <branch>` and wait for every one of them. A real check
  can take a moment to register after a push, so if only `CLA Assistant` appears, re-poll rather
  than concluding no other check is coming.
- **E2E is the long pole.** It builds a real signed APK and boots an Android emulator, so budget
  far longer for it than the other tiers and do not mistake its pending state for a hang. The
  sharded tiers also surface per-shard jobs (`Unit Test (1/3)`, `Component Test (2/4)`); those are
  an implementation detail, and the single gate check per tier is what protection requires.
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

`gh pr checks <branch> --watch --fail-fast --interval 30`, Bash `timeout` at its max (600000ms).
Treat a non-zero exit while checks are pending as status, not a tool failure; re-run the same
`--watch` command if the timeout fires with checks still only pending. If `CLA Assistant` is the
only check registered, do not call that all-green: the `ci.yml` checks may not have registered
yet, so re-poll before concluding it is genuinely the only one. Expect seven checks in total (the
`ci.yml` jobs plus `E2E tests (Maestro)` and `cla`).

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

So before reporting green, dispatch both and drive them to success:

```
gh workflow run build-android.yml --ref <branch> -f profile=preview
gh workflow run build-ios.yml --ref <branch> -f target=simulator
```

- Get the run ids from `gh run list --workflow <file> --limit 1 --json databaseId,status`, then
  watch with `gh run view <id> --json status,conclusion,jobs`.
- Roughly 13 minutes for Android `preview` and 11 for the iOS simulator, and they run in parallel.
- **iOS `target=simulator`, never `device`.** A device build consumes signing material and is a
  release path, not a check. Leave `submit` alone entirely.
- The iOS simulator job also **launches** the app and uploads a screenshot, so this doubles as a
  runtime smoke test rather than only a compile check.
- Feed failures into the Step 7 auto-fix loop the same as any other check.

Skip this only for a docs-only or `.claude/`-only diff, and say in the report that it was skipped
and why. When in doubt, run them: a runner is free and a broken build found after merge is not.

## Step 7 - Auto-fix loop (max 3 rounds, fully automatic)

For each failing or flaky check: pull the failure detail (`gh run view <run-id> --log-failed`),
classify (real regression vs broken test vs flaky test), fix with `Edit` or delegate to
`test-builder`, commit (conventional message via `.kangentic/COMMIT_MSG.tmp`), push
(`git push origin HEAD:<branch> --force-with-lease`), then return to Step 6. After 3
unsuccessful rounds, stop: report the classification and root cause per failing check, plus the
PR URL, and do not `--admin` bypass.

## Step 8 - Report (success)

Report the PR URL, branch name, commit count, and "All checks green." Include the two build runs
from Step 6b with their conclusions, or say plainly that they were skipped and why. "All checks
green" without a build run behind it overstates what was verified, because the PR gate does not
build either platform.

Next step: the user moves the task Tests -> Ship It, where `/merge-pull-request` merges it. Do
NOT merge.

## Rules

**CRITICAL: No chained commands.** Every Bash call is exactly ONE command. Never `&&`, `||`,
`|`, `;`. Use `git -C <path>` in another directory. Conventional commit messages. No em-dashes
or `--` as punctuation.

**Never fork a side-check while this skill is active.** A `subagent_type: "fork"` inherits the
full conversation context and can pick up and independently execute the rest of this skill. To
check on a background agent, wait for its `<task-notification>` instead.
