---
paths:
  - "app.json"
  - "app.config.*"
  - "eas.json"
  - "plugins/**"
  - "ios/**"
  - "android/**"
---
# Rule: native projects are generated, never hand-edited

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

## Enforcement (self-maintaining)

- **Mechanical (live now):** `.gitignore` blocks committing `/ios/` and `/android/`.
- **Review (live now):** the `expo-rn-reviewer` agent flags any diff touching `ios/` or
  `android/` during `/code-review`.
- **Check (planned, App Phase 1 CI):** an `npx expo prebuild --no-install` reproducibility gate.

Mind the read-trigger gap: because `ios/`/`android/` are gitignored, this path-scoped rule
rarely enters context on its own. The same summary is restated always-on in `CLAUDE.md`'s
Architecture section so the constraint is visible without a triggering file read.

## Scope

`app.json`, `app.config.*`, `eas.json`, `plugins/**`, and any content under `ios/**` or
`android/**` (which should never exist as tracked files).
