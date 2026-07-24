---
description: Direct quick-push escape hatch - commit, rebase, and push straight to the source branch, bypassing the PR gate. Use only when the user explicitly asks to push, land, or merge back a quick change. The normal flow is the board (Tests -> /pull-request, Ship It -> /merge-pull-request). NOT for a plain local commit (use /commit for that).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Agent
argument-hint: [commit message]
---

# Merge Back

Safely commit, rebase, and push changes straight to the source branch. Works from both
worktrees and the main repo.

This is the **direct quick-push escape hatch**: it bypasses the pull-request gate, so it relies
on admin push access. It is not wired to a board column. The normal flow goes through a PR: the
**Tests** column runs `/pull-request` and the **Ship It** column runs `/merge-pull-request`.
Reach for `/merge-back` only for a small, urgent change you want to land without a PR.

**Usage:** `/merge-back [commit message]`

**User-provided commit message (if any):** $ARGUMENTS

## Pre-flight Checks

All git commands below run from the **current working directory** - never `cd <path> &&
git ...`. The only exception is Step 6, which uses `git -C <projectRoot>` to target the main
repo.

1. **Detect mode:** CWD contains `.kangentic/worktrees/` -> worktree mode; otherwise -> main
   repo mode.
2. Get the current branch: `git rev-parse --abbrev-ref HEAD`. If `HEAD` (detached), warn and
   stop.
3. **Worktree mode only:** derive the project root by walking up from the worktree path.
4. Determine the source branch: worktree mode `git config kangentic.baseBranch` (fallback
   `main`); main repo mode, the current branch.
5. Run `git status --porcelain` to check for uncommitted changes.

## Step 0 - Install, typecheck, lint

1. Run `npm ci`. If it fails with EBUSY, stop: "A file in node_modules is locked by a running
   process."
2. Run `npm run typecheck`. Stop on failure.
3. Run `npm run lint`. Stop on error (warnings do not block).

## Step 1 - Commit Changes

If there are uncommitted changes (non-empty `git status --porcelain`):

1. Show `git status` and `git diff --stat`.
2. Determine the commit message (conventional format; infer the type prefix from the diff if
   `$ARGUMENTS` is empty or unprefixed).
3. **Targeted doc-anchor check.** Identify changed source files (exclude `docs/`, `.claude/`,
   `tests/`). If any match an anchor in `.claude/skills/sync-docs/SKILL.md`'s canonical list,
   spawn a `doc-auditor` agent with the matching files and fix any reported gaps with `Edit`.
4. Stage: `git add -A`.
5. Write the message via the **Write tool** to `.kangentic/COMMIT_MSG.tmp`, then
   `git commit -F .kangentic/COMMIT_MSG.tmp`. Never write to `.git/` (in worktrees it is a file,
   not a directory). Never use `$(...)` or backtick substitution.

If the working tree is clean, skip to Step 2.

## Step 2 - Fetch Latest Source Branch

`git fetch origin <sourceBranch>`. Report success or errors.

## Step 3 - Rebase onto Source Branch

`git rebase origin/<sourceBranch>`.

**On conflicts:** show the conflicting files (`git diff --name-only --diff-filter=U`), then
either resolve them (`Edit`, `git add <file>`, `git rebase --continue`), abort and merge instead
(`git rebase --abort`, `git merge origin/<sourceBranch>`), or abort entirely
(`git rebase --abort`) per the user's preference.

## Step 4 - Push to Source Branch

**Worktree mode:** push to the source branch (e.g. `main`), not the worktree branch name.

`git push origin HEAD:<sourceBranch>`

This is guaranteed to be a fast-forward after a successful rebase. If the push fails (someone
else pushed in the meantime), report it and suggest re-running `/merge-back`. Never force-push.

## Step 5 - Report

Summarize: mode, branch merged, source branch, commit count landed. Worktree mode only: remind
the user they can clean up the worktree by moving the task to Done on the board.

## Step 6 - Update Local Source Branch (worktree mode only, always runs after Step 5)

Skip entirely in main repo mode. The project root always has the source branch checked out;
keep it in sync.

1. Fast-forward it: `git -C <projectRoot> pull --ff-only`. If it succeeds, done.
2. If it fails, diagnose rather than soft-warn:
   a. `git -C <projectRoot> status -sb` for ahead/behind counts.
   b. Behind only but ff failed: uncommitted changes; report and stop, do not stash or discard.
   c. Ahead: list the local-only commits
      (`git -C <projectRoot> log --oneline origin/<sourceBranch>..<sourceBranch>`).
3. Offer to reconcile the ahead case (never silently): rebase
   (`git -C <projectRoot> rebase origin/<sourceBranch>`), or push if the user wants those commits
   on the source branch. On conflict, abort cleanly and report manual steps.

**Prevention:** the local source-branch checkout should only ever fast-forward. Do not commit
directly to it; use a worktree or feature branch.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never `&&`,
`||`, `|`, `;`. For git commands in another directory, use `git -C <path>`, never
`cd <path> && git ...`.
