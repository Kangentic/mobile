# Dependency upgrades

`/upgrade-deps` researches every npm dependency with a newer eligible release, within what the Expo
SDK mapping allows, and one agent does the upgrade by following
`.claude/skills/upgrade-deps/apply.md`. The task then runs through Code Review, Testing and Merge
like any other. It is ported from the desktop repo's skill of the same name. This page says how it
works here and why it differs: most of this app's native stack is mapped by the Expo SDK, a
required gate enforces that mapping, and the mapping moves on Expo's server.

There are two ways to run it, and the folder it runs in decides which:

- **In a task.** Make a card with `/upgrade-deps` as its description and drag it straight to
  Executing. That agent researches and does the upgrade itself, and files nothing. Planning runs in
  plan mode, which cannot install, so the run stops there and says so.
- **From a Command Terminal.** It starts at the project root, where no task branch can carry the
  work, so the run researches, files one task in To Do, and stops. Drag that task when you want it.

To stay with a task yourself, pause its automations before you drag it to Executing. The card stays
there, so no Apply findings message arrives and nothing moves it to review.

Run it as often as you like. Packages ship daily and Expo moves its mapping without a release, so
nothing here depends on the date: every run reads the newest releases and today's mapping, and
research already done is skipped. `--dry-run` prints the planned task and files nothing.

It is not the fix for a red `Native config (prebuild)` on `main`. Drift there blocks every pull
request, and the fast path stays what it was: `npx expo install --fix` (or one
`npx expo install <package>`) on its own branch cut from `main`. `/upgrade-deps` is a
research-and-upgrade task that can take hours, and it stops without doing anything while an upgrade
task is already past To Do. It picks drift up on its normal runs, as the first phase.

## Who does what

| Piece | Job |
|---|---|
| `scripts/upgrade-deps.mjs` | Reads the manifest, the lockfile, the registry, Expo's version service, `patches/` and `npm audit`. Decides by version number what can move, what the SDK mapping allows, and whether earlier research still answers it. |
| `upgrade-researcher` agent | Reads the release notes for every version crossed, checks how the app uses the package, decides whether a move past the mapping earns a hold, finds what can be removed or adopted, and writes a brief. |
| `/upgrade-deps` skill | Drives the run: spawns the researchers, orders the phases, and either follows `apply.md` or files a task, then records the task on the briefs. |
| `apply.md` | What the agent follows to install, migrate, adopt, verify and commit. |
| `scripts/upgrade-researcher-guard.js` | The researcher's hook: Bash may only read, and Write may only touch a brief. |

## The Expo SDK decides how far a mapped package moves

`npx expo install --check` runs in the required `Native config (prebuild)` check. It fails any
package the SDK maps that sits outside its mapping, and it reads `dependencies` and `devDependencies`
alike (read from `@expo/cli`'s `validateDependenciesVersions`). The mapping is wider than the
`expo-*` packages: SDK 58 maps `typescript` `~6.0.3`, `jest` `~30.5.2`, `@types/jest`,
`@types/react`, and `react` at exactly 19.3.0. So `npm outdated` and npm's `latest` are the wrong
answer for a third of this app's dependencies: TypeScript 7 or React 19.3.1 would turn every pull
request red.

The script combines the mapping the way the Expo CLI does: the `native-modules` list for the SDK,
overridden by the `versions` endpoint's `relatedPackages` plus `react`, `react-dom`, `react-native`
and `expo` itself. The override is how Expo moves an expected version server-side, which is why the
gate can go red with no change in this repository. If the versions endpoint cannot be read, the
inventory reports the mapping as `incomplete` and the skill stops, because those packages would
otherwise look unmapped.

Each package gets an `sdkRole`:

| Role | When | What the task does |
|---|---|---|
| none | not mapped | moves to the newest eligible release, as on the desktop |
| `drift` | mapped, not held, and the mapping accepts something newer | one `expo-sdk` group, installed by name with `npx expo install`, so the mapping on the day decides |
| `beyond-mapping` | mapped, not held, with a release past the mapping that a newer SDK does not cover | a hold only if research names a fix on a path this app uses; otherwise blocked, which means stay |
| `held` | in `expo.install.exclude` | judged by the registry; `holdCanEnd` when the mapping catches up, and the exclude entry and its row then come out |
| `next-sdk` | `expo`'s npm `latest` is a newer SDK | one `expo-sdk-<N>` group with every member its mapping moves, held packages included |

A hold silences the gate for one package (`.claude/rules/expo-cng.md`), so it carries its reason in
the "Dependencies held past the Expo SDK mapping" table in the
[developer guide](developer-guide.md), and `tests/unit/expoInstallExclude.test.ts` ties the table to
`package.json`. That test checks names only, so `apply.md` makes the agent update the row's version
and reason itself.

Two couplings the mapping does not express are kept anyway. `react-native-reanimated` is mapped and
`react-native-worklets` is held, so they land in different groups, and reanimated's peer range on
worklets (`0.13.x`) is what reports a worklets move that would break it. `@react-native/jest-preset`
is not mapped and peers only on `react`, so nothing would notice it drifting off `react-native`: it
moves in whichever group moves `react-native`, to the same version.

A newer SDK is its own group, last before the lockfile refresh, because it is the widest change a
dependency task can carry. The drift group stays beside it, so the required gate can go green even
if the SDK phase is dropped. The newer SDK is read off npm's `latest`, never the versions endpoint's
keys, which can list an SDK still in beta.

## Why a script decides what can move

The inventory never takes `latest` at face value. A target must be above the installed version. A
stable install never takes a prerelease or crosses its ceiling, which is `latest`, or a stable
dist-tag on the installed major when that is higher, as Expo's `sdk-<N>` tags can be. A prerelease
install takes another prerelease only of the same major.minor.patch. A deprecated release is skipped,
and a package with nothing else to move to is reported as `deprecated`, because the fix is to replace
or remove it.

It treats a `^0.x` minor as a major, because caret ranges do, and reports the peer conflicts one
group would add. Each group is checked alone against what is installed, so TypeScript 7 conflicting
with typescript-eslint blocks the `typescript` group and not typescript-eslint's patch.

## Patches

`patches/expo-task-manager+58.0.14.patch` names the version it was cut against, and patch-package
only warns when the installed version differs, then drops the patch the day the hunk stops applying.
CI's `node_modules` cache key hashes `patches/**`, so a rename belongs in the same commit as the
lockfile. The inventory reports `stalePatches` whenever the lockfile and a patch name disagree, a
member that carries a patch is flagged `patched`, and `lockdiff` exits 1 on a stale patch after every
install, the lockfile refresh included, since a `~` range can float a patched package there.

npm 12 blocks dependency install scripts that `allowScripts` does not cover, and this repo declares
none, so a local install can skip what CI's older npm runs. `apply.md` runs `npx patch-package`
after every install for that reason.

## First-party packages

`@kangentic/protocol` and `@kangentic/branding` are published from the desktop and branding repos.
A protocol minor is new wire behaviour this app has to consume, and a branding release redraws what
a person sees, so each moves with the feature task that adopts it. The inventory lists them under
`firstParty` with their newest release and never researches them, and the task names them in "Not
in this task" so nobody wonders where they went.

## Supply chain signals

There is no age gate. A target can be minutes old, so the run looks instead of waiting for someone
else to catch a bad release. The inventory compares each target to what is installed for what the
2026 npm attacks changed: a new dependency, a new install script, a `binding.gyp` with no script,
lost provenance, and a new publisher. A signal is a reason to look. It gives the group its own
researcher, who has to explain it or block the group. On the first run here, TypeScript 7 carried
two: 20 new platform packages and a new publisher. `apply.md` then runs `npm audit signatures`,
which proves a package came through the registry intact. It does not prove a maintainer's account
was safe, and transitive packages get no research at all.

Research reads text anyone can publish, about packages that can be minutes old, so the agent reads a
package and never runs one. On the desktop, an agent told to use read-only commands extracted a
release from that morning and loaded it in node, so the guard is a hook in the agent's frontmatter.
It is an allowlist that fails closed: Bash may read through npm, gh and git, and Write may touch only
the briefs folder.

## How research is reused

The registry and the mapping are read on every run. Only research is cached, as one JSON brief per
group in `.upgrade-deps/briefs/`, a gitignored folder in the root checkout, which every worktree of
the clone can reach. Losing it costs a research pass and nothing else. Briefs are not committed,
because a run that files nothing must still be reusable tomorrow.

Research never expires. The only things that send a group back to an agent are a version moving, or
`--refresh`:

| State | When | Cost |
|---|---|---|
| `reuse` | Same versions | None |
| `blocked` | Same versions, and what the blocker waits on has not moved | None |
| `filed` | A board task already carries the brief | None |
| `recheck` | Blocked, and what it waited on moved | The blocker alone |
| `delta` | Brief exists for older versions | The new releases only |
| `research` | No usable brief | Everything |

A beyond-mapping group whose answer is "stay at the mapping" is a blocked brief that names the
package at its newest, so the next run spends nothing until a newer release appears. A deep pass
writes a draft as it goes, which the next pass continues and never reuses as an answer. A brief's
`targets` is its cache key; when the task should install something else, the brief says so in
`installTargets`.

## One task, one agent

One agent does all of it, whatever its size. A run never splits a group out and never files a
follow-up: tasks in sequence wait on a merge each, and tasks in parallel conflict in
`package-lock.json`. The cost of one task is one large PR. A run from a task does the upgrade itself,
because a filing task has no commits and loops through Code Review for having no diff.

Each group is a phase with its own commit. The drift group goes first: every phase runs
`npx expo install --check` as a gate, so on a tree Expo has already moved outside the mapping, an
earlier phase would fail for a reason it did not cause and be dropped. After drift, every later phase
is checked against a gate that starts green. Then dev tool patches, medium risk unmapped groups, the
holds, native runtime majors, a newer SDK, and the lockfile refresh last. `apply.md` drops a phase that cannot pass its gates and carries on. An
upgrade task is one with the `dependencies` label, and there is only ever one: a filing run adds to
the one waiting in To Do, and while one is past To Do a run reports and stops.

A new feature a person would see is never a phase. It gets one line in the report, and you decide
whether it is worth a task. A bump that changes what a screen draws anyway (an icon set, text
metrics) is shown with before and after screenshots, and the agent ends on
`Design: waiting on you` instead of `Findings: applied`, which is the Executing column's own contract.

## The release build gate

The required checks never build a release APK, and the first SDK 58 release build died at launch,
before JS and Sentry, with every other check green. So any phase with a `native` member (the
inventory reads that from `android/`, `ios/` or `expo-module.config.json` in the installed package)
and the SDK groups need `npx expo run:android --variant release --no-bundler` launched on an emulator,
with `adb logcat -d -b crash` read afterwards. iOS is compiled and launched by the simulator build
that Testing's `/pull-request` dispatches for any `package.json` change. What only a device can prove,
such as a push to a killed app, goes in the task's "You need to do".

## Which model does what

Match the model to what a miss would cost.

| Stage | Model | Effort |
|---|---|---|
| Orchestrator, which judges the briefs and orders the phases | Opus | The session's |
| Research, low-risk batches | Haiku | Medium |
| Research, the drift group, holds, and other risky groups | Sonnet | High |
| Research, a newer SDK and native runtime majors | Opus | High |
| Planning, Executing, Code Review | Opus | The column's |
| Testing, on an upgrade task | Opus, through the `Upgrade` Board Profile | High |

Haiku is fine at reading but over-flags and misjudges reach (on the desktop's first full run it
cleared 8 of its 16 low-risk groups, and Sonnet reversed most of the other 8's alarms), so a Haiku
brief is a cheap first read, and anything not simple goes to Sonnet before planning. Filed tasks set
no model pins, because a pin lasts the task's whole life and would bypass the columns. Testing needs
the profile because `/pull-request` fixes code there when CI fails, and this board otherwise runs
Testing on Sonnet.

## Why green tests are not the finish line

The [DepBench](https://arxiv.org/abs/2608.30300) study gave coding agents 203 real dependency upgrades
and the best setup solved 51%, with npm among the hardest ecosystems. The largest failure, excluding
runtime exceptions, was a migration that stopped short of the whole repo, and 61.8% of the failures
analyzed had passed the repo's visible tests first. So each breaking change in a brief carries a
`find` regex and a named test, and `apply.md` requires zero hits, or a reason for each, before a
phase commits.

## What it costs

An inventory took 2.9 and 3.6 s here (two runs, 2026-11-11, 64 declared packages). Agent tokens are
the real cost, and they have only been measured on the desktop: 43k for a patch and 98k for a small
major. A run with nothing new spawns no agents.

## See Also

- [developer-guide.md](developer-guide.md) - the hold table, "What is pinned, and what is
  deliberately not", and the Expo SDK 58 upgrade record.
- `.claude/rules/expo-cng.md` - why mapped packages install through `npx expo install`.
