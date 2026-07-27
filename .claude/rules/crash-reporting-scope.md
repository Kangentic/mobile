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
  breadcrumbs, no captured failed requests, no structured logs, no session tracking, no
  performance tracing, no Session Replay, no PII. This list is the canonical enumeration;
  `docs/security.md` mirrors it, so an addition here has to land there in the same change.
- **JS breadcrumbs are allowlisted, not denylisted.** An unanticipated category must be dropped
  by default, because a future SDK version can add one this repo never reviewed. Read the
  breadcrumb entry under Known limitations before assuming this covers a native crash: it does
  not.
- **The DSN is never committed.** It arrives as `EXPO_PUBLIC_SENTRY_DSN` from the `SENTRY_DSN`
  GitHub repository **variable** (deliberately a variable, not a secret: a DSN ships inside the
  published bundle and is write-only, so keeping it out of the repo is about fork quota, not
  confidentiality). Absent, `Sentry.init()` is never called, so a build from source collects
  nothing. This is what keeps the app self-hostable without routing a fork's crashes into
  Kangentic's Sentry project.
- **Changing any of the above changes what leaves a user's device**, so it also requires
  updating `docs/privacy-policy.md` and `docs/security.md`, and re-checking the Play Data Safety
  and App Store privacy declarations.

## Known limitations, deliberately not papered over

**Stack frames cannot be scoped by source file on-device.** Under Expo,
`createReactNativeRewriteFrames()` rewrites every frame's `filename` to a single constant bundle
name (`app:///index.android.bundle` / `app:///main.jsbundle`) before `beforeSend` runs; real
paths are resolved server-side from the uploaded source map. So a rule like "redact the message
if the crash came from `src/pairing/`" is not implementable in the SDK, and is not attempted -
a check that can never fire is worse than none, because it reads as protection.

**The breadcrumb controls are JavaScript-side only.** This is the sharpest edge of the
`beforeSend`-cannot-reach-native fact above, and it cuts the other way too:
`@sentry/react-native` destructures `beforeSend`, `beforeBreadcrumb` and `integrations` out of
the options object before passing the rest to `initNativeSdk`
(`node_modules/@sentry/react-native/dist/js/wrapper.js`), and neither `RNSentryModuleImpl.java`
nor `RNSentry.mm` bridges a replacement. So `breadcrumbsIntegration({ console: false, ... })`
and `allowlistBreadcrumb` govern the JS scope only. sentry-cocoa and sentry-android keep their
own default auto-breadcrumbs (app foreground/background, activity or view-controller lifecycle,
connectivity and system events) and those ride a NATIVE crash unfiltered. They carry no session
content, but "the allowlist is default-deny" is true of the JS path and not of the native one.
Closing it needs native configuration through a config plugin (Android reads
`io.sentry.breadcrumbs.*` manifest meta-data; iOS has no equivalent plist switch), which is a
larger change than this rule should smuggle in. Say "JS breadcrumbs are allowlisted", not
"breadcrumbs are allowlisted".

**Channel-origin exception messages already reach Sentry today.** The import ban stops
`src/pairing/`, `src/channel/` and `src/notifications/` making a deliberate capture call; it
does nothing about an error from those directories propagating out uncaught and being picked up
by the global handler. That is not hypothetical: `EXPECTED_TRANSPORT_NOISE` in
`crashReporting.ts` exists precisely because `src/channel/relayTransport.ts` errors do arrive,
and `CapabilityError` (`src/channel/verbClient.ts`) puts the desktop-supplied `response.error`
string verbatim into its message. `scrubEvent` deliberately never touches `exception.value` -
reporting the message is the point of a crash reporter - so such a message ships as-is.
Truncating or genericizing peer-supplied error text at its construction site is the fix if this
ever matters; until then it is a named gap, not an unbroken invariant.

## Enforcement (self-maintaining)

- **Lint (live now):** `eslint.config.mjs` declares three `no-restricted-imports` zones - two
  confining `@sentry/*` to `src/observability/` (one for `.ts`/`.tsx` with `allowTypeImports`,
  one for `.js`/`.mjs`/`.cjs`), and one banning both the SDK and the wrapper from the pairing,
  channel, and notification directories. `Lint (ESLint)` is a required status check on `main`,
  so this is mechanical rather than review-only. Each zone was verified to fire by probe file,
  not merely assumed. **Know its one hole:** `no-restricted-imports` matches `import` syntax
  only, never `require()`. `metro.config.js` legitimately does
  `require('@sentry/react-native/metro')`, which proves the pattern is live in this repo, so a
  future CommonJS file could reach the SDK without tripping the rule.
- **Test (live now):** `tests/unit/scrubEvent.test.ts` locks the scrubber and the breadcrumb
  allowlist, including its default-deny behaviour. `tests/unit/buildWorkflow.test.ts` locks the
  pre-prebuild ordering of the Sentry env export and asserts no DSN is committed.
- **Review (live now):** the `crypto-pairing-auditor` agent should treat any new Sentry call
  site, or any relaxation of an init option above, as in scope during `/code-review`.

## Scope

`src/observability/**` and the three directories banned from reporting. Does not govern what the
desktop or relay log about themselves.
