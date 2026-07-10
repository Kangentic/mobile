---
description: Run the app on the Android emulator for previewing live changes (Expo dev client)
allowed-tools: Bash(npx:*), Bash(adb:*), Bash(npm:*)
argument-hint: [--clear]
---

# Preview

Launch the Expo dev server against the Android emulator for previewing live code changes.
Windows-first: the Android emulator is the daily local target; iOS previewing happens through
EAS cloud builds and a physical device or TestFlight, never a local simulator.

## Instructions

1. Run `adb devices` to confirm an emulator or device is attached. If none is listed, report
   that an Android emulator must be booted first (Android Studio's Device Manager) and stop.
   Do not attempt to launch emulator GUI tooling yourself.
2. If the user passed `--clear`, run `npx expo start --android --clear`. Otherwise run
   `npx expo start --android`.
3. Report the Metro bundler status and port.
4. If the command fails, report the error message.

## Notes

- This app needs a **development build** installed on the emulator, not Expo Go: it uses custom
  native modules (`react-native-quick-crypto`, `expo-secure-store`, Notifee) that Expo Go does
  not include. Build one once with `eas build --profile development --platform android`, or for
  a fully local build `npx expo run:android`.
- `npx expo start --android` reuses an already-installed dev build; it does not rebuild native
  code. Rebuild only when a native dependency or config plugin changes.
- Live reload works for JS/TS changes; a native or config-plugin change needs a fresh build.

## Phase 0 note

This skill targets the Expo app scaffold that lands in App Phase 1. If `package.json` does not
exist yet, report "the Expo scaffold lands in App Phase 1; nothing to preview yet" and stop.

## Allowed Tools

Only use `Bash` (for `adb` and `npx expo`). Run from the current working directory, do not chain
commands.
