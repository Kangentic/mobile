---
description: Boot the Android emulator if needed and run the app for previewing live changes (Expo dev client), optionally through the dev rig's mock/live/pair modes. Pass `ios` to get an iOS look instead, via a free macOS runner that launches the app on a simulator and returns a screenshot.
allowed-tools: Bash(npx:*), Bash(adb:*), Bash(emulator:*), Bash(npm:*), Bash(node:*), Bash(gh:*), Bash(unzip:*), Read, PowerShell(Get-NetTCPConnection:*), PowerShell(Stop-Process:*), PowerShell(Expand-Archive:*)
argument-hint: [mock|live|pair|ios] [--clear] [--avd <name>]
---

# Preview

Get the app running for previewing live code changes. Android is the daily local target: boot an
emulator if none is attached, build/install the dev client if it isn't there yet, then start Metro.

**iOS is not a local target and cannot be.** There is no Mac, and `expo prebuild --platform ios`
refuses to run on Windows at all ("Run npx expo prebuild again from macOS or Linux"). So `/preview
ios` does the only free thing that works: dispatches the simulator job on a GitHub macOS runner,
which builds, **launches** the app, and uploads a screenshot. See "iOS preview" below. It is a look,
not a live-reload loop, and it costs one runner and about eight minutes.

## Instructions

0a. **If `ios` was given, or the user asks how it looks on iOS / iPhone**, jump to the "iOS preview"
   section below and do nothing on Android. Do not try to boot a simulator locally; there isn't one.

0. **If a mode was given (`mock`, `live`, or `pair`), or the user asks for a connected preview**
   (mentions the relay, the stub peer, pairing, or their live desktop board), delegate to the
   dev rig instead of the manual steps: run `node scripts/dev.mjs <mode>` (pass `--clear` /
   `--avd <name>` through) with `run_in_background: true` and monitor its output. The rig
   performs steps 1-4 of this skill itself (emulator boot, port-8081 hygiene, Metro) plus
   everything connectivity needs (relay startup with the widened slot pattern, `adb reverse`,
   pm clear for pair mode, mock env for mock mode). When the rig reports Metro up, continue at
   step 5 (foreground verification). `node scripts/dev.mjs doctor` diagnoses a broken setup.
   Mode meanings: `mock` = in-app fake desktop, no peers needed; `live` = the user's real
   running Kangentic desktop through a local relay; `pair` = reset to unpaired and exercise the
   pairing ceremony. For a plain UI preview with no mode, follow steps 1-6 as written.
1. **Check for an attached device.** Run `adb devices`.
   - If a device is already listed, skip to step 3.
   - If none is listed, continue to step 2.
2. **Boot an emulator.**
   - Run `emulator -list-avds` to see what AVDs exist.
     - If none exist, report that no AVD is configured (see `docs/developer-guide.md`'s
       Prerequisites for how to create one) and stop. Do not try to create one yourself - that
       requires a deliberate system-image/API-level choice.
     - If the user passed `--avd <name>`, use that one (error if it isn't in the list).
     - Otherwise use the first AVD listed.
   - Launch it in the background: `emulator -avd <name> -no-snapshot-load -gpu host`
     (use `run_in_background: true` - this process stays alive for the life of the emulator
     window). The `-gpu host` flag is deliberate: it pins the accelerated host GPU renderer
     (the same flag `scripts/dev.mjs` passes) instead of leaving it to the AVD config or
     `auto`, which can leave the emulator in software rendering that degrades over long
     sessions. Verified against Android emulator 36.6.11.0 - that version rejects the older
     `angle_indirect` option name (silently falling back to `auto`), and its only remaining
     ANGLE mode (`swangle`) is software, not a hardware backend, so `host` is the accelerated
     option. This flag does not guarantee against the emulator's Qt window occasionally
     wedging on this Windows host (stale frames while the device keeps running; clicks land
     invisibly) - if a running emulator shows a frozen frame, diagnose with a device-side
     `node scripts/mobileInspect.mjs screenshot` (device fine + window stale = the wedge), then
     `adb -s emulator-5554 emu kill` and relaunch with this flag.
   - Wait for it to come up: `adb wait-for-device`.
   - Wait for it to finish booting (not just the ADB bridge):
     `adb wait-for-device shell "while [[ -z \$(getprop sys.boot_completed) ]]; do sleep 1; done; echo booted"`.
   - Report that the emulator booted before continuing.
3. **Free port 8081 if a stale Metro is squatting on it.** Metro (or a previous `expo start`/
   `run:android` you or an earlier session left running) can still be listening on 8081 even
   after its Bash task shows as stopped - `npx expo run:android` in particular spawns Metro as a
   detached child that outlives the parent task. Before starting a new one:
   - Check for a listener: (PowerShell) `Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue`.
   - If none is found, move on to step 4.
   - If one is found, **check what it is before killing it**:
     `Get-Process -Id <OwningProcess> | Select-Object Id, ProcessName, Path`. Kill it without
     asking only when it is safely identifiable as a stray Metro/Node process (`ProcessName` is
     `node`, and/or its command line references this project's path or `expo`/`metro`) -
     `Stop-Process -Id <OwningProcess> -Force` - then re-check the port is free. If it is anything
     else (a different `ProcessName`, or you cannot tell what it is), do NOT kill it - stop and
     ask the user, since something unrelated may have grabbed the port.
   - Do this unconditionally before step 4 rather than waiting for `npx expo` to fail first - in
     non-interactive mode it does not prompt to pick a different port, it just prints "Skipping
     dev server" and exits looking successful.
4. **Check whether the dev client is installed, AND that it matches this checkout.** Run
   `adb shell pm list packages` and look for `com.kangentic.mobile` (the app's package id, from
   `app.config.ts`).
   - **Installed:** before trusting it, run step 4a below. If it matches, run
     `npx expo start --android` (add `--clear` if the user passed it). This reuses the existing
     native build and just starts Metro.
   - **Not installed** (e.g. a freshly created AVD, or first run on this machine), **or step 4a
     reports a mismatch:** you need a new dev client. Build it in place with step 4b.

4a. **Verify the installed dev client's native libs match this worktree's JS.** Skipping this
   costs a full build plus a confusing debugging detour, because the failure does not look like a
   version problem: the app launches, runs for a few seconds, and dies with a **native `SIGABRT`
   inside `libworklets.so`** on a JSI assertion (`String facebook::jsi::Value::getString(...):
   assertion "isString()" failed`) - no JS error, no red box, no `ReactNativeJS` logcat line, just
   the app vanishing back to the launcher.

   The cause is that the APK's compiled native libs and the JS Metro serves come from **different
   dependency trees**. Every worktree of this repo can resolve a different `react-native` /
   `react-native-worklets` / `react-native-reanimated`, and a dev client built from one checkout
   is not interchangeable with another's bundle. This bites hardest right after an `npm install`
   in a worktree whose `node_modules` was previously a junction to the main checkout's: the
   install materialises a real tree at the versions `package.json` actually pins, and the APK on
   the emulator is suddenly stale.

   Compare the two before launching:
   - The APK's react-native, from the crash path or from
     `adb shell dumpsys package com.kangentic.mobile` plus the build you recorded making it.
   - This worktree's, from `node_modules/react-native/package.json`,
     `node_modules/react-native-worklets/package.json`, and
     `node_modules/react-native-reanimated/package.json`.

   If they differ at all, rebuild via step 4b. Do not try to "fix" it from the JS side.

   Reading a crash: `adb logcat -d -t 800 -s DEBUG:* libc:* AndroidRuntime:*` prints the abort
   message, and it names the react-native version the APK was compiled against, e.g.
   `.../react-android-0.86.0-debug/prefab/modules/jsi/include/jsi/jsi.h`. That string is the
   fastest way to identify a skewed dev client.

4b. **Build the dev client in place, from this worktree.** No separate build checkout, no commit
   first, no detached checkout:

   ```
   npm install
   npx expo run:android --no-bundler
   ```

   `--no-bundler` matters: Metro is already running from this worktree on 8081 and is the one that
   must serve the bundle. Without it `expo` notices the port is taken and prints
   `Skipping dev server`, which is harmless but reads like a failure.

   **`npm install` first is not optional**, and it is the step people skip. A Kangentic worktree
   starts with `node_modules` as a **junction to the main checkout**, which Node realpaths, so
   without a local install the APK compiles against whatever branch the main checkout is on. That
   is exactly the skew step 4a diagnoses.

   **If `android/` already exists from before the staging fix landed, prebuild once first**
   (`npx expo prebuild --platform android --no-install`). `expo run:android` only prebuilds when
   `android/` is MISSING, so a stale native directory keeps the old broken behaviour and the
   build fails with an error naming no file.

   This works because `plugins/withAndroidCmakeBuildStaging.ts` relocates each module's CMake
   staging directory to `%SystemDrive%\kangentic\android\<checkout-hash>\`, which takes checkout
   depth out of the equation. It used to fail here at every variant. If a build ever dies with
   `manifest 'build.ninja' still dirty after 100 tries` (which names no file) or
   `Filename longer than 260 characters`, that plugin is not applying: check
   `npm run verify:staging` and see `docs/developer-guide.md`'s "Local Android builds work from
   any path".

   Never create a drive-root build directory to work around a path problem, and never without
   asking the user first. The plugin is the supported fix; if it is broken, fix the plugin.

   Full background, the ABI flags a direct `gradlew` call needs, and the release/e2e variant:
   `docs/developer-guide.md`'s "Local Android builds work from any path".
5. **Verify the app actually came to the foreground**, don't just trust Metro's log. On a
   cold-booted emulator (just launched in step 2), the `Opening exp+mobile://...` intent
   Metro fires can race ahead of the OS being ready to route it, so the emulator silently sits on
   the home screen even though Metro reports success. Check:
   `adb shell dumpsys window | grep mCurrentFocus` (or `mResumedActivity`) and confirm it names
   `com.kangentic.mobile`. If it doesn't, launch it explicitly:
   `adb shell monkey -p com.kangentic.mobile -c android.intent.category.LAUNCHER 1`, wait a couple
   seconds, and re-check.
6. Report the Metro bundler status and port (e.g. `Waiting on http://localhost:8081`), and confirm
   the app is in the foreground (not just that Metro started).
7. If any command fails, report the exact error message. Common causes: `JAVA_HOME`/`ANDROID_HOME`
   not set in this shell (see the note below), a stale Gradle lock from a previous crashed build,
   or the stale-port-8081 situation in step 3.

## iOS preview

A look at the app running on an iPhone simulator, from Windows, for free. What it is not: a live
reload loop. Every change costs a fresh dispatch, so batch UI edits before asking for one.

1. **Commit and push first.** The runner builds a pushed commit, not the working tree, so uncommitted
   changes are invisible to it. If `git status --porcelain` is dirty, say so and stop rather than
   dispatching a build of stale code and presenting the result as the change.
2. **Dispatch on the current branch:**
   `gh workflow run build-ios.yml --ref <current branch> -f target=simulator`
   Then find the run id: `gh run list --workflow build-ios.yml --limit 1 --json databaseId,status`.
3. **Wait for it.** Roughly 8 to 10 minutes, nearly all of it `xcodebuild`. Poll with
   `gh run view <id> --json status,conclusion,jobs`, or watch with `gh run watch <id>`.
4. **Read the result honestly.** The job builds, then **launches** the app and asserts the process
   survives 15 seconds, so a red run is a real launch failure and worth reading rather than retrying.
   `.github/scripts/smoke-ios-simulator.sh` prints any crash report it finds.
5. **Fetch the screenshot** and look at it:
   `gh run download <id> --name ios-simulator-launch-<sha> --dir <a temp dir>`, then `Read` the PNG.
   It is uploaded even when the job fails, which is the whole point: a process can be alive while
   rendering a blank or red screen, and only the image distinguishes those.
6. **Report what the screenshot shows**, not merely that the run was green. If the screenshot is
   blank, a splash screen, or a red box, say so plainly - that is the finding.

Two things this deliberately does not use. **EAS Simulator** is a paid EAS service, and this project
moved off paid EAS on purpose (see the CI builds section of `docs/developer-guide.md`); do not reach
for it without the user explicitly asking. **A signed device build** (`-f target=device`) is for
releases, not previews: it costs the same runner time, produces nothing you can look at from Windows,
and consumes an `ios.buildNumber` if submitted.

## Notes

- **`JAVA_HOME` / `ANDROID_HOME` in a fresh shell.** These are persisted as Windows user
  environment variables, so a new terminal session picks them up automatically. If a command in
  this skill fails with "java not found" or "SDK location not found", the invoking shell process
  predates that env var change (persisted env vars only apply to processes started *after* they
  were set) - re-run the failing command with `JAVA_HOME=... ANDROID_HOME=... <command>` prefixed
  as a single non-chained command, using whatever `JAVA_HOME`/`ANDROID_HOME` the developer
  configured (see `docs/developer-guide.md`), rather than assuming a specific path - these are
  machine-specific and never hardcoded here.
- This app needs a **development build** installed on the emulator, not Expo Go: it uses custom
  native modules (`expo-secure-store`, `expo-camera`, and later Notifee) that Expo Go does not
  include.
- `npx expo start --android` reuses an already-installed dev build; it does not rebuild native
  code. Rebuild (`npx expo run:android`) only when a native dependency or config plugin changes,
  or the app isn't installed on the target device/emulator yet.
- Live reload (Fast Refresh) works for JS/TS changes; a native or config-plugin change needs a
  fresh build.
- An EAS cloud build (`eas build --profile development --platform android`) is the alternative to
  `npx expo run:android` when you'd rather not compile natively on this machine - download the
  resulting APK and `adb install` it instead of step 3's local build path.
- **Any connected mode needs `adb reverse tcp:8080 tcp:8080`.** The app only accepts `ws://` for
  loopback hosts, so the emulator reaches a host relay exclusively through adb reverse - and the
  mapping is wiped on every emulator reboot. The dev rig re-applies it on every run; if you
  bypass the rig, re-run it yourself after any reboot (`adb reverse --list` to check).
- **Relay slot pattern.** Until the relay-side fix ships everywhere, a local relay must run with
  `SLOT_ID_PATTERN='^([0-9a-f]{32}|[0-9a-f]{64})$'` or pairing succeeds and the ongoing session
  400s at upgrade. The rig sets this when it starts the relay and warns when it adopts a relay
  that rejects 32-hex slots.

## Allowed Tools

Use `Bash` (for `adb`, `emulator`, and `npx expo`) and `PowerShell` (only for
`Get-NetTCPConnection`/`Get-Process`/`Stop-Process`, and only per step 3's safety check - never
kill a process you have not first identified as a stray Metro/Node instance). Run from the
current working directory, do not chain Bash commands - each step above may take several
separate tool calls.
