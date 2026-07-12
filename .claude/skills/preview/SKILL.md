---
description: Boot the Android emulator if needed and run the app for previewing live changes (Expo dev client)
allowed-tools: Bash(npx:*), Bash(adb:*), Bash(emulator:*), Bash(npm:*), PowerShell(Get-NetTCPConnection:*), PowerShell(Stop-Process:*)
argument-hint: [--clear] [--avd <name>]
---

# Preview

Get the app running on the Android emulator for previewing live code changes, end to end - boot
an emulator if none is attached, build/install the dev client if it isn't there yet, then start
Metro. Windows-first: the Android emulator is the daily local target; iOS previewing happens
through EAS cloud builds and a physical device or TestFlight, never a local simulator.

## Instructions

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
   - Launch it in the background: `emulator -avd <name> -no-snapshot-load` (use
     `run_in_background: true` - this process stays alive for the life of the emulator window).
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
4. **Check whether the dev client is installed.** Run
   `adb shell pm list packages` and look for `com.kangentic.mobile` (the app's package id, from
   `app.config.ts`).
   - **Installed:** run `npx expo start --android` (add `--clear` if the user passed it). This
     reuses the existing native build and just starts Metro.
   - **Not installed** (e.g. a freshly created AVD, or first run on this machine): run
     `npx expo run:android` (add `--variant release` only if the user explicitly asks for a
     release build). This builds the native project via Gradle, installs the APK, and starts
     Metro - the first run can take several minutes (Gradle downloads + native compilation); say
     so before running it.
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

## Allowed Tools

Use `Bash` (for `adb`, `emulator`, and `npx expo`) and `PowerShell` (only for
`Get-NetTCPConnection`/`Get-Process`/`Stop-Process`, and only per step 3's safety check - never
kill a process you have not first identified as a stray Metro/Node instance). Run from the
current working directory, do not chain Bash commands - each step above may take several
separate tool calls.
