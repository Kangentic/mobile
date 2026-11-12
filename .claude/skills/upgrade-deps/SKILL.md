---
name: upgrade-deps
description: Research every npm dependency with a newer eligible release, within what the Expo SDK mapping allows, reading each changelog and migration guide and what the release lets us remove or adopt, and get the upgrade done by one agent. Inside a board task it does the upgrade itself by following apply.md. From a Command Terminal it files one board task for an agent to do that. It never files a follow-up. Reuses earlier research when nothing moved or a known blocker still stands. Use for "update our packages", "upgrade dependencies", or "what can we upgrade". Not the fix for a red `expo install --check` on main: that is a quick `npx expo install --fix` on its own branch.
allowed-tools: Read, Glob, Grep, Write, Edit, Bash(node:*), Bash(npm:*), Bash(npx:*), Bash(git:*), Bash(gh:*), Agent
argument-hint: [--dry-run] [--refresh] [package or group ...]
---

# Upgrade deps

Find every npm dependency that can move, research what each move means for this app, and get the
upgrade done by one agent. Ported from the desktop repo's skill: what differs is the Expo SDK,
whose mapping decides how far most of the native stack may move, the patch-package patches, and
the release-build gate.

**Where this runs decides what it does.** Check the working directory first:

- **Inside `.kangentic/worktrees/`, a task run.** This session does the upgrade. Research as below,
  skip Step 6, and follow `apply.md` in this task. The branch then has commits for Code Review and
  Testing to work on. If this session is in plan mode it cannot install anything, so say the card
  belongs in Executing and stop.
- **Anywhere else, a filing run.** A Command Terminal starts at the project root, where no task branch
  can carry the work. Research as below, file one task, and stop. A filing run edits no code, installs
  nothing and pushes nothing.

Go by the folder. `kangentic_get_current_task` with a branch name is no test for this: `main` matches
old tasks.

Run it as often as you like. Timing never matters: every run checks the newest releases and the
mapping Expo serves today, and work already done is skipped. A run with nothing new costs one
inventory and no agents.

**Usage:** `/upgrade-deps [--dry-run] [--refresh] [package or group ...]`

- `--dry-run` researches and prints the planned task but files nothing. Research is still cached.
- `--refresh` ignores the cache and researches every group again.
- Naming packages or groups limits the run to those groups.

**Arguments:** $ARGUMENTS

Run it on an up-to-date `main` in an Opus session, because this session judges the briefs and orders
the phases. It reads the tree it is in, so a checkout behind `main` reports versions that already
moved. Its agents write to the main checkout's cache from any worktree.

## What it covers, and what never moves

The root `package.json`, both blocks. Packages nothing declares move in a lockfile refresh, the
task's last upgrade phase. GitHub Actions are out of scope: this repo has no Dependabot, and its
Actions pins are kept by hand ("What is pinned, and what is deliberately not" in
`docs/developer-guide.md`). Everything else is up for a full upgrade, majors and exact pins
included, unless one of these stops it:

- **The Expo SDK mapping.** `npx expo install --check` is a required gate (`Native config
  (prebuild)`), and it fails any package the SDK maps that sits outside its mapping, devDependencies
  included: `typescript`, `jest`, `@types/jest`, `@types/react` and `react` are mapped, not just the
  `expo-*` packages. The inventory gives every package an `sdkRole` (below), so nothing is planned
  past the mapping without a hold the research earned. A hold means an `expo.install.exclude` entry
  and a row in the developer guide's hold table (`.claude/rules/expo-cng.md`).
- **A downgrade.** The inventory never moves a package below what is installed, whatever `latest`
  says, so never pick a version by hand from `npm outdated`.
- **A peer range nothing satisfies.** It goes on the record as blocked, with what would clear it.
- **A pin whose reason still holds** and which the target would break. An exact pin moves only to
  another exact pin.
- **First-party `@kangentic/*` packages.** A protocol minor is new wire behaviour the app has to
  consume, and a branding release redraws what a person sees, so each moves with the feature that
  adopts it. The inventory lists them under `firstParty`, and the task names them in "Not in this
  task".
- **`@notifee/react-native`** stays on 9.1.8, the final release of an archived package. Swapping it
  for a fork is a trust decision for a person, never a phase.

## Step 1: Inventory

```
node scripts/upgrade-deps.mjs inventory
```

Pass `--refresh` through if given. It reads the registry and Expo's API on every run, so a release
or a mapping change from an hour ago shows up. Only research is cached. A field that is absent
means no. Read:

- `sdk`: `installed` is the SDK major, `next` a newer SDK whose mapping Expo serves.
  **If `sdk.incomplete` is present, report it and stop.** Without the full mapping, `react`,
  `react-native`, `typescript` and `jest` look unmapped and would be planned past the gate.
  `sdk.nextUnavailable` means `expo`'s npm `latest` is a newer SDK whose mapping is not served yet:
  report it in one line.
- `groups`: what can move. Each group carries its `sdkRole`, its `members` (`installed`, `target`,
  `published`, `pinned`, `runtime`, `native`, `kind`, and per member `sdkRange`, `held`,
  `holdCanEnd`, `beyondMapping`, `patch`, `tracks`), its `peerConflicts`, a `research` state,
  `hasBrief`, and any `task`. The roles:

  | `sdkRole` | Means |
  |---|---|
  | none | Not mapped. The registry decides, as on the desktop. |
  | `drift` | The `expo-sdk` group: every mapped package moving to the newest release its mapping accepts, which `npx expo install` does at once. This is what keeps the required gate green when Expo moves the mapping server-side. |
  | `beyond-mapping` | A mapped package with a release past the mapping. Taking it is a hold research has to earn; usually the answer is to stay. |
  | `held` | Already in `expo.install.exclude`, judged by the registry. `holdCanEnd` means the mapping caught up and the exclude entry can come out; kind `unhold` means that is the only work. |
  | `next-sdk` | The `expo-sdk-<N>` group: a newer SDK, every member its mapping moves, held ones included. |

  `targetsDisagree` means a lockstep set's newest releases do not match, so the researcher picks a
  matching set. `signals` means a member's target changed what the 2026 npm attacks changed: a new
  dependency, install script or `binding.gyp`, lost provenance, or a new publisher. A `kind` of
  `deprecated` means there is no upgrade, and the work is to replace or remove the package.
  `patched` means a member carries a `patches/` file its phase must re-check and rename.
- `firstParty`: the `@kangentic/*` packages, with their newest release. Never researched.
- `stalePatches`: a patch whose version no longer matches the lockfile. The task must fix it even if
  nothing else moves, because patch-package only warns about a mismatch and drops the patch the day
  the hunk stops applying.
- `cacheDir`: where briefs live. It is the same folder from any worktree.
- `errors`: packages the registry would not answer, and Expo API failures. Report them. A package
  missing from the run is not up to date.

## Step 2: Work out what needs research

If the arguments named packages or groups, work only on those from here on, and leave the rest out
of the report. The `research` state says how much of the earlier work still stands:

| State | Meaning | Action |
|---|---|---|
| `reuse` | Same versions | Read the brief. No agent. |
| `blocked` | Same versions, and what the blocker waits on has not moved | Report it. No agent. |
| `filed` | A board task carries this brief | Confirm the task in Step 3. No agent. |
| `recheck` | Blocked, and what it waited on moved | One agent tests the blocker alone. |
| `delta` | A brief exists for older versions | One agent covers only the new releases. |
| `research` | No usable brief | The full pass. |

Research never expires. Only a version moving, or `--refresh`, sends a group back to an agent, so do
not research a `reuse` group again because you are unsure, or because the brief is old. Read it.

## Step 3: Check the board

Search active tasks for earlier upgrade work:

```
kangentic_search_tasks query: "Upgrade deps", status: "active"
```

An upgrade task is one with the `dependencies` label. Ignore any other match, however it is titled,
and ignore the task you are running in. There is only ever one upgrade task.

**If one is past To Do, stop here.** Name it in the report with how many groups could move, then spawn
nothing and file nothing. Whatever moved waits for the next run after that task merges, so a run during
an upgrade costs one inventory. A task run stops too if one is waiting in To Do, because that task
already holds the plan: say to drag it.

On a task run, find your own task with `kangentic_get_current_task`, passing `cwd` and no branch, and
set the `dependencies` label on it now with a labels-only `kangentic_update_task`, so a run that starts
while this one works stops here.

For every group with a `task`, whatever its `research` state, find that task with
`kangentic_find_task` and `task.displayId`. A new release moves a filed group to `delta`, and it still
belongs to that task:

- **Still in To Do:** research it as its state says, then update that task in Step 6 rather than
  filing another.
- **Done or deleted, and the group still shows as movable:** the work did not land. Set the brief's
  `task` to `null`. Treat a `filed` group as `reuse`, and research a `delta` group as usual.

## Step 4: Research

Spawn `upgrade-researcher` agents in parallel, in one message:

- **Critical groups get one agent each on Opus,** with `model: "opus"`: the `next-sdk` group, and
  any group that is `native` and `runtime` with kind `major`. A miss here can ship a crash at launch.
- **Other risky groups get one agent each on the agent's default, Sonnet at high effort:** the
  `expo-sdk` drift group, any `beyond-mapping` or `held` group, and any group whose `kind` is `major`
  or `deprecated`, or that is `pinned`, `runtime`, `native` or `patched`, or has `signals`,
  `peerConflicts`, an `advisory` or an `inheritedAdvisory`. `@sentry/react-native` and the `xterm`
  group always get their own agent too: one carries the crash-reporting privacy posture, the other
  generates the terminal page.
- **Everything else goes in batches of up to six groups on Haiku,** with `model: "haiku"` and
  `effort: "medium"`. A patch to a dev tool needs its release notes read, not an investigation.

When the batches finish, read their briefs and **escalate**. Haiku is trusted for groups that turned
out simple, not for judging hard ones. Send a group to one agent on the default, with state `research`
and its brief as the prior brief, if the brief has any of these:

- `risk` above `low`, or `verdict: blocked`
- a change that needs a source edit, or that moves a package the app ships. A range in
  `package.json` or a lockfile line for a dev tool is not one, even when the brief marks it as
  affecting us
- a value in `installTargets`, which means it wants something other than the newest release
- anything in `adopt` or `workaroundsToRemove`
- an unverified claim about how the app uses the package
- a claim about an advisory that `npm audit` does not back

Each prompt carries, per group: the name, the `sdkRole`, every member's `installed`, `target`,
`published`, `pinned`, `runtime`, `native`, `signals`, `deprecated`, `sdkRange`, `held`,
`holdCanEnd`, `beyondMapping`, `patch` and `tracks`, the `peerConflicts`, any `advisory` or
`inheritedAdvisory`, the `research` state, and the absolute path `<cacheDir>/briefs/<group>.json`.
Say whether a prior brief exists at that path. For the `next-sdk` group, add the SDK numbers and
every held package with its hold-table row.

The agents write their briefs to disk as they finish, so a stopped run keeps its work. Run the
inventory again to pick up where it stopped. Do not research anything yourself in the main loop.

## Step 5: Plan the task

Read every brief with `verdict: ready`. **All of it goes in one task, worked by one agent.** Never split
a group out and never file a follow-up, whatever its size or risk. Tasks run one after another wait on
a merge each, and tasks run in parallel conflict in `package-lock.json`. Groups become phases inside
the task, each with its own commit.

On a filing run, if an upgrade task is waiting in To Do, add the new groups to it. Otherwise file a task.

Order the phases so a red group late in the run leaves every commit before it standing:

1. the `expo-sdk` drift group, FIRST. Every phase runs `npx expo install --check` as a gate, so a
   tree Expo has already moved outside the mapping would fail an earlier phase for a reason that
   phase did not cause, and `apply.md` would drop it. Once drift lands, every later phase is
   checked against a gate that starts green.
2. patches and minors to dev tools
3. medium risk unmapped groups
4. `held` and `beyond-mapping` groups, the holds
5. native runtime majors
6. the `next-sdk` group
7. the lockfile refresh

`apply.md` drops a phase that cannot pass its gates and carries on, so a high risk group never needs a
task of its own. A `stalePatches` entry with no group of its own goes ahead of the drift group: it
does not touch the gate.

A blocked group gets no phase. It goes in the task's "Not in this task" section and in the report, so
nobody wonders where it went. So do the `firstParty` packages, each with its newest release.

**A user-visible idea is never a phase.** An `adopt` item with `userVisible: true` gets one line in the
report and nothing else: no mockup and no build. Whether it is worth doing is a separate decision for
a person, and a mockup inside an upgrade reads as finished work.

## Step 6: File the task

A task run skips the filing here. Record your own task on the briefs, as the last paragraph of this
step says, then follow `.claude/skills/upgrade-deps/apply.md`, with the order from Step 5 as your plan.

With `--dry-run`, print the planned title and description and stop here.

Otherwise create the task in To Do with `kangentic_create_task`, with `profile: "Upgrade"` and no
`column`. Title it `Upgrade deps: <what moves>`, and attach the brief of every group in it, as
`attachments: [{ filePath: "<cacheDir>/briefs/<group>.json" }, ...]`. Then set the label `dependencies`
in a separate labels-only `kangentic_update_task` call, because labels on a long create can drop.

To change the waiting task, use `kangentic_update_task` with `descriptionEdits`, and pass the new or
changed briefs in `attachments`, which adds to what is there. Remove a superseded copy with
`kangentic_remove_task_attachment`.

Attach the briefs rather than copy them into the description, because the attachment paths reach the
agent's opening prompt anyway. Keep the description to the plan a person reads on the card, and under
25,000 characters, which leaves room for the briefs' paths. The field allows 27,500, and the paths
ride the same command line: past the shell's limit the spawn refuses the start, except on an agent
that can take the prompt typed.

The `Upgrade` Board Profile puts the Testing column on Opus, because `/pull-request` fixes code there
when CI fails and an upgrade's fixes are app changes. If the board has no such profile, file without
one and say so in the report.

**Set no `autoCommand`, `modelOverride`, `effortOverride`, `agentOverride` or `permissionMode`.** The
columns decide how a task runs: code changes go through Planning, Executing and Code Review on Opus. A
pin lasts the task's whole life, so it would bypass that and lock the permission mode too, and
`autoCommand` replaces the commands the board runs as the task moves.

The description stands alone, because the task agent shares no context with this run:

```markdown
Follow `.claude/skills/upgrade-deps/apply.md`. Install exactly the versions below, except where a
phase says the SDK mapping decides. Each group's full research is attached as `<group>.json`: read it
before you start that phase.

## Phases

### 1. expo-sdk: drift to the SDK <N> mapping  (risk: low)
Install by name with `npx expo install`; the mapping on the day decides the versions.

### 2. <group>: <installed> to <target>  (risk: low)
<the brief's summary>
Must change: <the source edits in a line, or "nothing">

### 3. ...

### Last: lockfile refresh

## Not in this task
Blocked: <group, reason, what clears it>
Held at the mapping: <package, why staying is the answer, what clears it>
First party: <package, installed, newest; adopted by the feature that needs it>
Idea: <a user-visible item in one line, not to be mocked up or built here>
```

Paraphrase, and never write a contributor's path, because the board is mirrored publicly.

After the task exists, record it on its briefs, so the next run knows it is handled. In each
brief, set `"task": { "displayId": <number>, "filedAt": "<UTC ISO timestamp>" }`.

## Step 7: Report

A task run reports through `apply.md`'s Finish section instead. A filing run ends with what the user
needs to act on, short:

- The task filed or updated, with its number and how many groups it holds.
- Blocked groups and packages held at the mapping, each with its reason and what clears it.
- A newer SDK, if the inventory saw one, and whether the task carries it.
- User-visible ideas, one line each.
- What the run reused, as a count: "11 groups from the cache, 4 researched".
- Any registry or Expo API errors, and anything an agent could not verify.

If everything is current, blocked or already filed, say that in one line and file nothing.

## Rules

- A filing run never edits source, runs an install, commits or pushes. A task run does all of that
  except the push, by `apply.md`'s rules.
- One upgrade task at a time. Never split it, and never file a follow-up.
- Never start the filed task, and never move it. The user drags it when they want it.
- Every version in a task comes from a brief, and every brief's versions come from the inventory.
  The one exception is a mapped package, where the mapping on the day the task runs decides.
- Never plan a mapped package past its mapping without a brief that earned the hold.
- One command per Bash call.
