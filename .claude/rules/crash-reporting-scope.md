---
paths:
  - "src/observability/**"
  - "src/pairing/**"
  - "src/channel/**"
  - "src/notifications/**"
---
# Rule: crash reporting reports crashes, never content

Sentry is the only path by which this app's data reaches a third party that is not the relay or
the push network. The app tells users their session content never leaves the device in cleartext
(`docs/privacy-policy.md`, `docs/security.md`), so a crash reporter that captured a console line,
a screenshot, or a request URL would quietly make that untrue. The default configuration of
`@sentry/react-native` does capture all three.

The load-bearing fact is that **a JavaScript `beforeSend` hook does not filter native events**. A
hard iOS or Android crash is captured and sent by sentry-cocoa / sentry-android without ever
passing through the JS layer. Worse, JS breadcrumbs are synced into the native scope, so a
console breadcrumb recorded in JS rides a native crash straight past every JS scrubber. A
scrubber is therefore a second line of defence, never the control itself.

## The rule

- **One door.** `src/observability/` is the only place that may import `@sentry/react-native`.
  Everywhere else, crash reporting is automatic through the global handler. This exists so that
  no other module can re-enable a default the init deliberately turned off, or capture an event
  that bypasses the configured scrubber.
- **`src/pairing/**`, `src/channel/**`, and `src/notifications/**` must not report to Sentry at
  all**, neither the SDK nor the `src/observability/` wrapper. Their error messages can carry
  ciphertext, key material, or attacker-controlled bytes:
  `src/notifications/pushDecrypt.ts` states it directly, and swallows without logging for
  exactly this reason (see `e2e-notification-privacy.md`). The global handler still reports a
  genuine crash originating in these directories; what is banned is a hand-written
  `captureException` call.
- **Every privacy control is set at its source, not in `beforeSend`.** Turning a capture off
  means removing the integration or disabling the feature in `Sentry.init()`. Specifically:
  no screenshots, no view hierarchy, no console breadcrumbs, no network (`xhr`/`fetch`)
  breadcrumbs, no session tracking, no performance tracing, no Session Replay, no PII.
- **Breadcrumbs are allowlisted, not denylisted.** An unanticipated category must be dropped by
  default, because a future SDK version can add one this repo never reviewed.
- **The DSN is never committed.** It arrives as `EXPO_PUBLIC_SENTRY_DSN` from the `SENTRY_DSN`
  GitHub repository **variable** (deliberately a variable, not a secret: a DSN ships inside the
  published bundle and is write-only, so keeping it out of the repo is about fork quota, not
  confidentiality). Absent, `Sentry.init()` is never called, so a build from source collects
  nothing. This is what keeps the app self-hostable without routing a fork's crashes into
  Kangentic's Sentry project.
- **Changing any of the above changes what leaves a user's device**, so it also requires
  updating `docs/privacy-policy.md` and `docs/security.md`, and re-checking the Play Data Safety
  and App Store privacy declarations.

## Known limitation, deliberately not papered over

Stack frames cannot be scoped by source file on-device. Under Expo,
`createReactNativeRewriteFrames()` rewrites every frame's `filename` to a single constant bundle
name (`app:///index.android.bundle` / `app:///main.jsbundle`) before `beforeSend` runs; real
paths are resolved server-side from the uploaded source map. So a rule like "redact the message
if the crash came from `src/pairing/`" is not implementable in the SDK, and is not attempted -
a check that can never fire is worse than none, because it reads as protection. What protects
those directories is the import ban above plus their own never-log convention. If that
convention is broken by a future change, nothing downstream will catch it.

## Enforcement (self-maintaining)

- **Lint (live now):** `eslint.config.mjs` declares two `no-restricted-imports` zones - one
  confining `@sentry/*` to `src/observability/`, one banning both the SDK and the wrapper from
  the pairing, channel, and notification directories. `Lint (ESLint)` is a required status check
  on `main`, so this is mechanical rather than review-only. Both zones were verified to fire by
  probe file, not merely assumed.
- **Test (live now):** `tests/unit/scrubEvent.test.ts` locks the scrubber and the breadcrumb
  allowlist, including its default-deny behaviour. `tests/unit/buildWorkflow.test.ts` locks the
  pre-prebuild ordering of the Sentry env export and asserts no DSN is committed.
- **Review (live now):** the `crypto-pairing-auditor` agent should treat any new Sentry call
  site, or any relaxation of an init option above, as in scope during `/code-review`.

## Scope

`src/observability/**` and the three directories banned from reporting. Does not govern what the
desktop or relay log about themselves.
