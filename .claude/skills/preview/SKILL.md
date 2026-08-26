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

## When this, and not a CI build

`gh workflow run build-android.yml` is the normal way to produce an ARTIFACT. It is the wrong way
to ITERATE. Each dispatch is ~15 minutes, and a JS-only change (anything under `src/`, including
the generated `src/terminal/xterm.html`) needs no native build at all: with a dev client already
installed, the loop is edit, regenerate if needed, reload. Seconds.

Reach for a CI build when you need a standalone APK someone can install and run without Metro (a
device handoff, a store-adjacent check, a release). Reach for this skill whenever you expect more
than one try, which is almost always true of anything you have to LOOK at to judge: gestures,
animation, layout, timing.

The failure mode to avoid is picking CI once for a good reason and then not re-examining it as
the work changes shape. If you are on your second rebuild of a pure-JS change, stop and set up
the dev client instead; it pays for itself immediately.

## Instructions

0a. **If `ios` was given, or the user asks how it looks on iOS / iPhone**, jump to the "iOS preview"
   section below and do nothing on Android. Do not try to boot a simulator locally; there isn't one.

0. **If a mode was given (`mock`, `live`, or `pair`), or the work is connected in any way**,
   delegate to the dev rig instead of the manual steps: run `node scripts/dev.mjs <mode>` (pass
   `--clear` / `--avd <name>` / `--serial <adb serial>` through) with `run_in_background: true`
   and monitor its output.

   **Infer the mode; do not wait to be told one.** The trigger is the GOAL, not the word. If the
   preview has to talk to the user's real desktop, show real tasks, or exercise anything that
   needs a pairing, that is `live` - even if nobody said "live". Following steps 1-6 by hand
   instead is the most expensive mistake available here, because the rig also does the thing the
   manual path cannot: **it pairs for you.**

   Live mode quick-pairs by exchanging PUBLIC keys through
   `.kangentic/mobile-dev-pairing/`, adopts the dev phone key into the desktop roster with every
   verb granted, and hands the matching secret to the app via a dev-only env var. No QR, no SAS,
   no human. Doing it manually instead blocks on the user scanning a code and comparing a string,
   on their schedule rather than yours. Physical devices are supported: with one device attached
   the rig picks it automatically and skips the emulator boot.

   That path is a deliberate dev backdoor and is safe only because of how it is confined: gated
   on `__KANGENTIC_DEV__` so esbuild strips it from packaged builds, only public keys crossing,
   and only files inside the developer's own checkout trusted. It needs BOTH sides to be dev
   builds on the same machine. Never widen it, never reimplement it somewhere less contained
   (an MCP tool, a script that ships), and never reach for it to skip a real pairing test -
   `dev:pair` exists for that. The rig
   performs steps 1-4 of this skill itself (emulator boot, port-8081 hygiene, Metro) plus
   everything connectivity needs (relay startup with the widened slot pattern, `adb reverse`,
   pm clear for pair mode, mock env for mock mode). When the rig reports Metro up, continue at
   step 5 (foreground verification). `node scripts/dev.mjs doctor` diagnoses a broken setup.
   Mode meanings: `mock` = in-app fake desktop, no peers needed; `live` = the user's real
   running Kangentic desktop through a local relay; `pair` = reset to unpaired and exercise the
   pairing ceremony. For a plain UI preview with no mode, follow steps 1-6 as written.
1. **Check for an attached device.** Run `adb devices`.
   - If a device is already listed, skip to step 3. A **physical phone** counts and is often the
     better target (real GPU, real touch, real relay latency) - see "Physical devices" in the
     Notes for the three things that differ from an emulator.
   - **If the user said a phone is connected but `adb devices` is empty, do NOT fall through to
     step 2 and boot an emulator.** They asked for their phone; silently substituting an emulator
     answers a question nobody asked. Diagnose instead - step 1a.
   - If none is listed and nobody mentioned a phone, continue to step 2.

1a. **A phone is plugged in but adb cannot see it.** Do not guess between "bad cable", "bad
   driver" and "USB debugging is off" - Windows can tell you which, in one call, and the answer
   is objective:

   ```
   Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_18D1' } |
     Select-Object Status, Class, FriendlyName, InstanceId | Format-List
   ```

   `VID_18D1` is Google (Pixel). For another vendor, drop the filter and match the model name.
   Read the **PID**, which is what the phone's USB mode actually is:

   | PID | Meaning | adb sees it? |
   |---|---|---|
   | `4EE1` | MTP / file transfer only | **No.** USB debugging is OFF. |
   | `4EE2` | MTP + ADB | Yes (may need authorising) |
   | `4EE5` | PTP + ADB | Yes (may need authorising) |
   | `4EE7` | ADB only / charging | Yes (may need authorising) |
   | *no entry at all* | Windows does not see the phone | Cable is charge-only, or a driver problem |

   - **`4EE1`, or any entry with `Class : WPD` and no ADB interface:** USB debugging is off. This
     is not something any tool on this machine can fix. Tell the user exactly this, once:
     **Settings > About phone > tap "Build number" 7x**, then
     **Settings > System > Developer options > USB debugging > On**, then accept
     **"Allow USB debugging?"** (tick "Always allow from this computer"). Then wait for the device
     rather than making them come back and report - a background `until adb devices | grep -qE
     "(device|unauthorized)$"; do sleep 3; done` exits the moment it appears, and matching
     `unauthorized` too means a pending authorisation dialog surfaces instead of hanging silently.
   - **`unauthorized` in `adb devices`:** the dialog is up on the phone and unanswered.
   - **No entry at all:** cable or port. A charge-only cable is the usual cause.

   Do not spend turns theorising before running this check - it is one call and it ends the
   ambiguity. And note the serial it prints (the trailing segment of `InstanceId`): it is the
   same string `adb -s` wants later.

1b. **Check WHICH phone it is against what the docs assume.** `docs/developer-guide.md` describes
   "the maintainer's physical device", and that device changes. A brand-new phone has Developer
   options off, no dev client installed, and none of the adb authorisations the notes take for
   granted - so "it worked last time" is about a different handset. Confirm the model and serial
   from step 1a before assuming any recorded setup still applies.
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
- **A reload is ASYNCHRONOUS: confirm it landed before judging a fix.** Triggering one (the
  dev-client deep link, or `r` in Metro) returns immediately while the previous bundle keeps
  serving for a second or more. Testing a gesture in that window exercises the OLD code and
  produces a confident, wrong "still broken". This burned three separate diagnoses in one
  session, twice sending the investigation after a bug that was already fixed.

  Assets make it worse than plain JS: `src/terminal/xterm.html` is a Metro asset, cached by
  content hash under `/data/user/0/<pkg>/cache/ExponentAsset-<hash>.html`, so a regenerated file
  is a NEW hash the app has to fetch before anything changes. Fast Refresh does not cover it.

  Cheapest confirmation: `adb logcat -d -t 200 -e <a marker string>` and check the asset hash in
  the `source:` field actually changed, or watch for a fresh mount log. A screenshot alone will
  not tell you which bundle is live.
- **Physical devices.** A real phone is a first-class target here and usually the honest one, but
  three things differ from an emulator:
  - **Do not pass `--device <serial>`.** `npx expo run:android --device 57181FDCH00CZ5` fails with
    `CommandError: Could not find device with name: ...` - the flag wants a device NAME, not the
    adb serial. With exactly one device attached, omit the flag entirely and it picks correctly.
    Note this failure arrives AFTER prebuild has already run, so it looks later and more alarming
    than it is; just re-run without the flag.
  - **Metro needs `adb reverse tcp:8081 tcp:8081`** over USB. An emulator reaches the host loopback
    on its own; a phone does not. This is separate from the `tcp:8080` relay mapping below, and
    like it, it is wiped on reboot and on unplug. `adb reverse --list` to check.
  - **It replaces the user's working app.** A dev client will not launch without Metro running, so
    installing one on a daily-driver phone takes their app away until they reinstall a standalone
    APK. Say so before doing it, and keep the last preview APK around as the way back.
  - **ANY already-installed build blocks the local install, and clearing it costs the pairing.**
    Whether the phone carries a `preview`/`production` APK from `build-android.yml`, a TestFlight
    equivalent, or - the most likely case on a daily driver - **the app installed from Play**, the
    local debug build cannot go over it:

    ```
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.kangentic.mobile
    signatures do not match newer version
    ```

    Three different signing keys are in play and no two match: Play re-signs with its own app
    signing key, `build-android.yml` uses the CI keystore, and `expo run:android` uses the local
    debug key. The only way through is `adb uninstall com.kangentic.mobile`, which **wipes app
    data, including the pairing**. The device identity key lives in Android Keystore and is
    non-exportable, so there is no backup or restore - the user re-pairs by QR plus SAS.

    **A Play build is also a RELEASE build**, so two further things follow that are easy to miss:
    it cannot load JS from Metro at all (no dev client, no Fast Refresh), and its JS is whatever
    version shipped - so a working-tree change is simply not in it, however many times you reload.
    Confirm the installed version before concluding a change "did not work":
    `adb shell dumpsys package com.kangentic.mobile | grep versionName`.

    **Always ask before uninstalling.** This is the one step in this skill that destroys user
    state, and it arrives late (after a full successful Gradle build), so it is easy to treat as
    a mechanical retry. It is not. On an EMULATOR just uninstall; on the user's real phone, get
    a decision first, and mention that re-pairing needs their hands on both devices.
- **Any connected mode needs `adb reverse tcp:8080 tcp:8080`.** The app only accepts `ws://` for
  loopback hosts, so the emulator reaches a host relay exclusively through adb reverse - and the
  mapping is wiped on every emulator reboot. The dev rig re-applies it on every run; if you
  bypass the rig, re-run it yourself after any reboot (`adb reverse --list` to check).
- **Relay slot pattern.** A local relay must accept 32-hex slots: as of protocol 0.12.0 BOTH
  the pairing and the session slot are derived 32-hex values, so a relay narrowed to 64-hex
  rendezvouses nothing at all. The rig starts the relay with
  `SLOT_ID_PATTERN='^([0-9a-f]{32}|[0-9a-f]{64})$'` (the 64-hex alternative tolerates an older
  relay checkout only) and warns when it adopts a relay that rejects 32-hex slots.

## Allowed Tools

Use `Bash` (for `adb`, `emulator`, and `npx expo`) and `PowerShell` (only for
`Get-NetTCPConnection`/`Get-Process`/`Stop-Process`, and only per step 3's safety check - never
kill a process you have not first identified as a stray Metro/Node instance). Run from the
current working directory, do not chain Bash commands - each step above may take several
separate tool calls.
