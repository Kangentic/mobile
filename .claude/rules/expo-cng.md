---
paths:
  - "app.json"
  - "app.config.*"
  - "eas.json"
  - "plugins/**"
  - "ios/**"
  - "android/**"
  - "package.json"
  - "package-lock.json"
---
# Rule: native projects are generated, never hand-edited; dependencies install SDK-resolved

This app uses Expo's Continuous Native Generation (CNG): `ios/` and `android/` are build
artifacts produced by `npx expo prebuild`, gitignored, and never committed. A hand edit inside
either directory is silently discarded the next time prebuild runs locally or on EAS, and is
unreproducible for any other contributor or CI machine.

## The rule

- Never hand-edit or commit anything under `ios/` or `android/`.
- All native configuration (permissions, entitlements, build settings, native dependencies)
  flows through `app.config.ts` and Expo config plugins under `plugins/`.
- Native source that must ship (the iOS Notification Service Extension) is injected by a config
  plugin at prebuild time, not checked into `ios/` directly; its source lives under `targets/`.
- If a change seems to require a hand edit to the native project, write or extend a config
  plugin instead.
- **Install Expo-ecosystem dependencies with `npx expo install <pkg>`** (or the Expo MCP's
  `add_library`), never a raw `npm install <pkg>`. `expo install` resolves the version compatible
  with the pinned SDK (the `expo` entry in `package.json`, currently the 57 line); a raw
  `npm install` takes latest and silently
  drifts against it. Non-Expo packages may use `npm install` normally.
- After any dependency change, run `npx expo install --check` to confirm nothing drifted.

## Enforcement (self-maintaining)

- **Mechanical (live now):** `.gitignore` blocks committing `/ios/` and `/android/`.
- **Review (live now):** the `expo-rn-reviewer` agent flags any diff touching `ios/` or
  `android/`, and vets a new native dependency for config-plugin and New Architecture support,
  during `/code-review`. Note the limit: `expo install` and `npm install` produce an identical
  `package.json` diff, so review cannot tell which command was run. It can only flag a version
  that looks unresolved against the pinned SDK. The install discipline above is enforced in
  practice by the `--check` gate below, not by review.
- **Check (live now, every PR):** the `Native config (expo prebuild)` job in
  `.github/workflows/ci.yml` runs `npx expo prebuild` for **both** platforms on a clean
  checkout, so a config-plugin or native-config change that cannot prebuild fails the PR. It
  covered only Android at first, which is precisely how a broken `expo/config-plugins` import
  reached an iOS build with every gate green. Know its limit even now: `expo prebuild` resolves
  plugin imports through Expo CLI's own loader, which is more forgiving than the strict Node ESM
  resolution `eas build` uses, so it catches a plugin that throws but not every import that only
  fails under strict package exports.
- **Check (live now, every PR):** `npx expo install --check` in the same job makes
  SDK-resolved dependency drift a PR gate. This was previously deferred on the grounds that it
  would redden a green check over cosmetic drift. That was the wrong call: the drift it would
  have caught included `expo` itself three patches behind, and it was masking the config-plugin
  failure above. Drift is not cosmetic when the SDK is one of the drifting packages.
- **Check (live now, on dispatch):** `.github/workflows/build-android.yml` and
  `build-ios.yml` each also prebuild for real before building, so the same class of breakage
  fails a build even if it somehow reached `main`.

Mind the read-trigger gap: because `ios/`/`android/` are gitignored, this path-scoped rule
rarely enters context on its own. The same summary is restated always-on in `CLAUDE.md`'s
Architecture section so the constraint is visible without a triggering file read.

## Scope

`app.json`, `app.config.*`, `eas.json`, `plugins/**`, `package.json`, `package-lock.json`, and
any content under `ios/**` or `android/**` (which should never exist as tracked files).
