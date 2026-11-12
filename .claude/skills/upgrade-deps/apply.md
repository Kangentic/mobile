# Applying a dependency upgrade

You are working a task `/upgrade-deps` filed, or one it is running in. The plan is the exact versions
and the order of the phases: the task's description, or on a task run, what Step 5 of the skill just
set. Each group's brief is the detail, attached as `<group>.json` or at `<cacheDir>/briefs/<group>.json`:
the migration steps, the hold decision, the patch findings, what to adopt and remove, the `find`
regexes, the gates, and what the research could not verify. Read a group's brief before you start
its phase. This file is how to carry it out safely in this repo. Do the whole plan, adoption and
cleanup included. A version bump with the benefits left on the table is half the task.

A brief reflects `main` when it was researched, and something may have merged since. Where a brief
disagrees with the code or a rule, the repo wins. Say so in your report.

Ported from the desktop repo's guide. What differs is how a mapped package installs, the holds, the
patches, and the release-build gate that stands in for the desktop's packaged-app check.

## Get a real install first

A worktree's `node_modules` is usually a junction into the main checkout, and a green run against
it proves the main checkout's packages, not yours. An APK built through it binds to the main
checkout's tree too, and a native mismatch dies as a `SIGABRT` in `libworklets.so` with no JS error.

1. Check for the junction: `(Get-Item node_modules -Force).LinkType` in PowerShell reads `Junction`
   for a link and nothing for a real folder.
2. If it is a link, delete only the link: `(Get-Item node_modules -Force).Delete()`. Never a
   recursive delete through it.
3. Run `npm install`. **Never `npm ci` here.** Through a junction it empties the main checkout's
   `node_modules` first. If it fails with `EBUSY` on a jar under `node_modules/expo-modules-core`, a
   Gradle daemon from an earlier local build holds it: stop that daemon and run it again.
4. Run `npx patch-package` and read that it applied `patches/expo-task-manager+<version>.patch`.
   npm 12 blocks dependency install scripts that `allowScripts` does not cover and can skip the
   patch with them, while CI's npm runs everything, so a local tree without the patch proves
   nothing about what CI builds. Do this after every install below too.

## Check the plan still holds

Run `node scripts/upgrade-deps.mjs inventory`. Install the versions in the task, not whatever is
newest now. Change one only if the target was deprecated since the task was filed, or an advisory
hit it. If so, say so in your final report.

**The exception is a mapped package.** Expo moves the mapping on its server, so on the day you run,
the `expo-sdk` and `expo-sdk-<N>` groups install whatever the mapping expects then, and
`npx expo install --check` passing is the bar, not a version in the brief. Compare against the
inventory you just ran, and name any version that moved since the brief in your report.

`installTargets` in a brief overrides `targets`. The task description already reflects this.

## Work through the phases, in the planned order

The drift group comes first when the plan has one: every phase gates on `npx expo install --check`,
which starts green only once the tree is back inside the mapping.

For each phase:

1. **Install.** How depends on the group's `sdkRole`:
   - **`drift`, or a hold that ends:** `npx expo install <name> <name> ...`, every member by name and
     no version. It writes the mapping's range into `package.json` and resolves the newest release
     inside it. `.claude/rules/expo-cng.md` forbids a raw `npm install` for these.
   - **`next-sdk`:** follow the `expo:expo-upgrade` skill and Expo's upgrade guide for that SDK:
     move `expo` first, then `npx expo install --fix`. Two rounds is normal: the first bump changes
     which `expo` resolves the mapping, and the CLI runs the second pass itself.
   - **A move past the mapping (`beyond-mapping`, or a `held` package moving further):**
     `npm install <package>@<version>`, with `--save-exact` for an exact pin, then make sure the
     package is in `expo.install.exclude` and its row in the hold table under "Dependencies held past
     the Expo SDK mapping" in `docs/developer-guide.md` says what the brief's `hold.row` says:
     "Held at", "Why" and "Verified by" all, and the mapping column. `expoInstallExclude.test.ts`
     checks only the names, so a row with a stale version passes it.
   - **Ending a hold:** remove the exclude entry and the row in the same commit, then install it as
     drift above.
   - **Anything unmapped:** `npm install <package>@<version>`, always naming the version, since
     `<package>@^<version>` can resolve past what was researched. Use `--save-exact` for an exact
     pin. A lockstep group goes in one command. npm keeps a package in the block it is already in,
     so pass no `--save-prod` or `--save-dev`.
   - **A member with `tracks`:** name its exact version in its own `npm install`, right after the
     package it tracks moves.
   If you batch commands, stop at the first failure. A failed install with the gates still running
   proves nothing about the new version.

   **If npm refuses with `ERESOLVE`, find out why before you force anything.** `--force` is allowed
   only when every peer in the refused chain is absent from the tree and the lockfile changes only
   this phase's packages. Put the reason in the commit body. Otherwise the phase is blocked. Never
   use `--legacy-peer-deps`.
2. **Re-apply the patches and read the lockfile diff.** Run `npx patch-package`, then
   `node scripts/upgrade-deps.mjs lockdiff <package>@<version> ...`, naming what this phase
   installs. Only this phase's packages and their dependencies should change. It exits 1 on a version
   that did not resolve, a flag lost at an unchanged version, or a patch that no longer matches the
   lockfile.
   - **A patched package moved** (`patch` on a member, or the patch line in `lockdiff`): read the
     brief's `patches` finding, then the call site in the installed copy. If it is still unguarded,
     check `npx patch-package` applied the hunk, rename `patches/<package>+<old>.patch` to the new
     version, and record the re-pin in `CLAUDE.md`'s `patches/` note, all in the SAME commit as the
     lockfile: CI's `node_modules` cache key hashes `patches/**`. If the hunk no longer applies,
     regenerate it by hand from an edited copy, with every path prefixed `node_modules/<package>/`;
     patch-package silently rejects a package-relative path. If upstream fixed the call site, delete
     the patch, drop the `expo.autolinking.buildFromSource` entries that exist only for it, and
     rewrite the `CLAUDE.md` note to say why it went.
   - A package that gains an install script runs it in CI and is blocked locally by npm 12. The
     brief must have explained it as a signal. If it did not, stop the phase.
3. **Do the migration steps**, then replace deprecated APIs, then remove the workarounds the release
   makes unnecessary, along with any test that only pinned the workaround. If the phase names an
   official codemod, run it first.
4. **Adopt what the phase lists.** New APIs replace the code they replace, not sit beside it.
5. **Prove the migration finished.** Green tests do not show this. In a benchmark of real upgrades,
   most failing runs had passed the repo's own tests, and the largest cause was a change that stopped
   short of the whole repo. For each `find` regex in the phase, Grep `src/`, `app/`, `plugins/`,
   `modules/`, `targets/`, `scripts/` and `tests/`. Zero hits, or a reason for each hit that remains.
   Then make sure the test the phase names exercises the changed path, and write one if it says
   "needs a new test". Never edit an existing test's assertions to make a bump pass, unless the
   release documents that change.
6. **Run the phase's gates:** `npm run typecheck`, `npm run lint`, `npx expo install --check` (every
   phase: an unmapped install can still move a mapped package), and every test the phase names, with
   scoped test runs only. A phase that moves a config plugin's package, or changes `app.config.ts` or
   `plugins/`, also runs `npx expo config --type prebuild`, which catches a plugin that throws on
   load; iOS prebuild itself refuses to run on Windows. Never the full tiers and never a Maestro
   suite: CI runs both on every PR.
7. **Commit the phase**, one commit per phase, through `/commit`:
   `chore(deps): upgrade <group> to <version>`, or `feat`/`refactor` when it adopts something real.

A failed phase never blocks the others. If you cannot make one work after a real attempt, drop that
phase's changes with `git revert` or by never committing them, record the blocker (below), and carry
on. One red group must never cost the whole batch.

A phase that turns out bigger than planned stays in this task. Never file a follow-up: one agent does
all of this work. Only a phase that cannot land gets recorded, and a later run picks it up from there.

**A message that arrives mid-run does not end the run.** The Executing column's Apply findings row can
fire while you wait on a background command, and it asks you to end on `Findings: applied` or
`Design: waiting on you`. If phases remain, say so in one line and keep working. Either line moves or
holds the card, so write one only when the whole plan is done.

## Last phase: lockfile refresh

Nothing above reaches a package nothing declares, and most advisories live there. This phase moves
them within their ranges.

```
npm update
```

Then:

1. `git diff package.json` should be empty. If not, restore it and read why.
2. Check that no direct dependency moved past what a task phase named, and that no group you dropped
   or the task lists as blocked came back. Put one back with `npm install` at its old version.
3. Run `npx expo install --check`. A caret range can carry a mapped package past its mapping here:
   `typescript` is declared `^6.0.3` against a mapping of `~6.0.3`, so a 6.1 release fails the gate.
   Put each one it names back with `npx expo install <name>`.
4. Run `npx patch-package` and `lockdiff`. `expo-task-manager`'s `~` range can float it to a new
   patch here, which is the patch re-pin from step 2 above, in this commit.
5. Run `npm audit --package-lock-only` and report the before and after counts in your final report.
   **Never run `npm audit fix --force`.** It plans majors past the SDK mapping and downgrades.
6. Run the typecheck and lint gates, and commit it alone as `chore(deps): refresh lockfile`.

## Supply chain check

After the last install, run `npm audit signatures`. It verifies the registry signature of every
installed package and any provenance it carries. A failure stops the task: report it and do not
commit. CI runs an older npm that does not enforce `allowScripts`, so a bad install script would run
there once this branch is pushed.

## The release build gate

**Any phase with a `native` member, and the `expo-sdk` and `expo-sdk-<N>` groups, needs a release
build launched before the task finishes.** The first SDK 58 release build died at launch, before JS
and before Sentry, with CI, the R8 verifier and the staging check all green
(`plugins/withAndroidR8ImplicitConstructors.ts`). The required checks never build a release APK.

1. After the last native phase and the lockfile refresh, with this worktree's own `node_modules`
   (above), boot an emulator through `/preview` (never the maintainer's phone) and run
   `npx expo run:android --variant release --no-bundler`. It takes a few minutes and needs no
   signing.
2. Launch it, and read `adb logcat -d -b crash`. A launch that seems to hang is usually a crash this
   buffer holds.
3. The `next-sdk` phase gets its own build before you commit it, because a crash found after the
   lockfile refresh cannot say which phase caused it.

iOS is not built here. Testing's `/pull-request` dispatches the simulator build for any diff that
touches `package.json` (its Step 6b), and that run launches the app. What only a device can prove
goes in your report under "You need to do".

## Extra gates by package

- **The next SDK:** every hold is vetted again (the hold table, `expo.install.exclude`, and the
  "Held at the mapping, deliberately" paragraph), every patch re-checked, and every config plugin
  read against the new template. Update the SDK number wherever the docs and `CLAUDE.md`'s tech
  stack name it, including the hold table's mapping column header. The device checks the last SDK
  upgrade listed under "Not proven on hardware before merge" in the developer guide (a push to a
  killed app on both platforms, the iOS Notification Service Extension, a cold-start notification
  tap) go under "You need to do".
- **`expo-task-manager`:** its patch (step 2), and a push to a killed Android app under "You need to
  do", which is the only runtime test of that patch.
- **`expo-notifications`, `@notifee/react-native`:** the push path. A device push goes under "You
  need to do". Never swap notifee for a fork here.
- **`@sentry/react-native`:** `tests/unit/crashReporting.test.ts` pins the installed default
  integration list. A new default that adds data is a privacy change under
  `.claude/rules/crash-reporting-scope.md`, and `docs/privacy-policy.md` must still cover what it
  collects.
- **`react-native-enriched-markdown`:** it caused the REACT-NATIVE-5 session-screen leak. Re-measure
  with the retention probe (`EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE=1`, two `dumpsys meminfo` samples
  after a GC) on the release build before accepting a bump, and check its `enriched-markdown` block
  in `package.json` is still honoured.
- **`@xterm/*`:** run `node scripts/buildXtermHtml.mjs` and commit the regenerated
  `src/terminal/xterm.html`; the WebView inlines these packages, so a bump without it ships nothing.
  The recorded terminal fixture is never hand-edited. Open a terminal in `/preview` and read it: no
  test renders WebGL, so CI stays green if text draws wrong.
- **`react-native-reanimated`, `react-native-worklets`:** they move together inside reanimated's
  peer range (its `compatibility.json`). `.claude/rules/motion-conventions.md` applies, and any
  performance gain is only claimed after `/profile` measures it on a release build.
- **`typescript`, `jest`, `@types/jest`, `@types/react`, `react`:** mapped, so the gate decides.
- **A package with a rule:** grep `.claude/rules/` for its name. The rule's Enforcement section lists
  what to run.

## Pins, holds and guard tests

A guard test failing means the pin's reason is in play. Read the test's header before you touch it.
Update a guard test only to name the new version, and only when the fix it guards is still in the
target. Never weaken one to get a bump through. That is a blocker. Record it. The same goes for a
hold: never add an exclude entry to quiet `expo install --check` without the brief's reason in its
row.

## User-visible ideas

An `adopt` item with `userVisible: true` is not part of this task. Do not mock it up or build it, even
if a later message tells you to apply what is left. Name it in one line in your report, and a person
decides whether it is worth doing.

## See it run

Before you finish, run the app with `/preview` in mock mode and confirm the affected features work.
A phase that moved native code needs the dev client rebuilt (`npx expo run:android`), because a
dev client binds the native code of the tree that built it.

**If a phase changed what a screen draws** (an icon set redrawn, text metrics, a native header, a
branding asset), show it with before and after screenshots of the same screen, and end on the design
line below rather than on `Findings: applied`. Store listing frames are never re-captured inside this
task: name the drift for the next release.

Update `docs/` where a version, a limit or a workaround it describes has changed, the hold table
above all.

## Record what the next run needs

If a phase could not land, record it. This is what stops the next run from researching and filing
the same dead end:

```
node scripts/upgrade-deps.mjs record-blocker <group> --reason "<why>" --recheck "<what would clear it>" --blocked-on <package>=<its newest today on the line we run>
```

Repeat `--blocked-on` for each package you are waiting on, and leave it out if you are waiting on
none. For a package we run on a beta line, name the beta, because the check follows the line you
record and `latest` sits behind it. Use the script, not a file edit: the brief is in the main checkout, outside your worktree.
Avoid backticks and `$` in the text. If it says there is no brief, put the blocker in your final
report instead.

## Finish

Keep the report short, because the commits hold the evidence. In this order:

1. One line on what landed and anything you dropped.
2. **You need to do:** a short list of what only a person can do, such as a device check named above,
   a non-required CI check to read, or a decision. Write "Nothing" if there is nothing.
3. Up to five findings someone must know, one line each.
4. User-visible ideas, one line each.

Make the last line of the message, alone, one of the Executing column's two lines (their rows in
`kangentic.json` match the whole line, and `tests/unit/boardTurnEndContracts.test.ts` pins both
here):

- `Design: waiting on you`, when a phase changed what a person sees. The card waits for the user to
  look, and once they say it is ready ("ship it"), end every later turn on the other line.
- `Findings: applied` otherwise. It moves the card on to Code Review, and the board's Code Review,
  Testing and Merge columns do the rest.

If the task's automations are paused, the card stays in Executing for the user to take from there.
Either way, do not open a PR.

A phase you recorded as blocked is finished work, not a finding. If a message asks you to apply what
is left, do not retry it. Say it is recorded and end on the same line.
