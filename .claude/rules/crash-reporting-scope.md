---
paths:
  - "src/observability/**"
  - "src/pairing/**"
  - "src/channel/**"
  - "src/demo/**"
  - "src/devsupport/**"
  - "src/notifications/**"
  - "app/+native-intent.ts"
  - "src/navigation/screenTracking.tsx"
  - "src/state/connectionBreadcrumbs.ts"
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
  that bypasses the configured scrubber. Behind the door there are exactly two capture calls:
  `reportCaughtError` (the error boundaries, the root one and the chat feeds' `FeedErrorBoundary`,
  whose names are the closed `CaughtErrorBoundary` union; the message is kept, because a render
  throw's message is app-authored and is what makes the event diagnosable) and `reportHandledError` (the
  handled-error door, next bullet but one; the message is never sent). Nothing else calls
  `captureException`.
- **`src/pairing/**`, `src/channel/**`, `src/demo/**`, `src/devsupport/**`,
  `src/notifications/**`, and `app/+native-intent.ts` must not report
  to Sentry at all**, neither the SDK nor the `src/observability/` wrapper. Their error messages can carry
  ciphertext, key material, or attacker-controlled bytes (`src/devsupport/` holds the loopback
  transport and stub peer the shipped demo runs its handshake against, and `app/+native-intent.ts`
  receives raw deep-link URLs before any error boundary exists):
  `src/notifications/pushDecrypt.ts` states it directly, and swallows without logging for
  exactly this reason (see `e2e-notification-privacy.md`). The global handler still reports a
  genuine crash originating in these directories; what is banned is a hand-written
  `captureException` call.
- **Handled failures go through `reportHandledError(site, error)`, and only the door decides
  what leaves.** Call it where the user is shown a failure or a wrong-but-plausible state: an
  inline error note, a silently empty column, a fallback to the pairing CTA. Never for an
  expected best-effort catch (a dropped keystroke, a permission refresh, a snippet pre-warm, a
  retried bootstrap), and never for a pairing or handshake failure even from a screen
  (`PairingScanScreen`, `PairingConfirmScreen`): the door strips the message, but a ceremony
  failure's existence and timing is itself information about a pairing attempt, and
  `src/pairing/`'s convention is silence. Two existing sites read like exceptions to that and are
  not, so that a reviewer does not have to re-derive it: `connection-open` sits on a catch that
  `controller.connect()` can never reach, because the dial and the KK handshake are caught and
  swallowed locally (`connectionManager.ts`, the `.catch(() => {})` on that call), leaving only
  pre-handshake setup failures; and `devices-paired-info` catches a Keychain READ of material an
  existing pairing already stored, not an attempt at a new ceremony. `site` is a member of the `HandledErrorSite` union, a
  literal and never computed, and it is the only thing a caller supplies besides the error. The
  door forwards no message text and no `cause`; it tags `site`, `errorName` and, for a
  capability error, `verb` and the refusal's `code` (each only when it is one of the protocol's
  closed literals: the wire decoder accepts any string as `code`, so the door checks it against
  a record the compiler holds to `CapabilityErrorCode`; the scope's `screen` and `lens` tags ride
  the event as well, as they ride every event), keeps the stack frames, fingerprints on
  those tags (the code is appended only when present, so an uncoded event keeps the fingerprint
  it had before the tag existed), drops
  `NotConnectedError` and `ChannelDisconnectedError` by name and the transport-noise patterns by
  the ORIGINAL message, and rate-limits per fingerprint (one a minute, ten a launch). `scrubEvent`
  re-redacts every exception value on any event tagged `site`, as the second line. Adding a site
  means adding the literal and asserting the call in that surface's component test, on failure
  and not on success. Sites still owed: MoveTask, EditTask, TaskActions (all but its
  automations switch and its single-link row, which report as `task-automations` and
  `task-artifact-open`; the Artifacts sheet reports as `task-artifact-open` too), the Devices unpair,
  FileDiff, and `settingsStore.readSetting` (its import graph reaches a dozen test files; do it
  once a shared vitest mock for the door exists). `usePromptAnswer` matches on message text today
  and needs a typed stale-prompt error at the verb layer, not a door call.
- **Every privacy control is set at its source, not in `beforeSend`.** Turning a capture off
  means removing the integration or disabling the feature in `Sentry.init()`. Specifically:
  no screenshots, no view hierarchy, no console breadcrumbs, no network (`xhr`/`fetch`)
  breadcrumbs, no captured failed requests, no structured logs, no session tracking, no
  performance tracing, no Session Replay, no PII, no message text from a handled catch, no iOS
  memory introspection (`enableMemoryIntrospection: false`), and none of the three default
  integrations @sentry/react-native 8.x added that attach data with no option of their own:
  `ExpoConstants` (a per-launch session id and project metadata on every event),
  `TurboModuleContext` and `ExpoUpdatesListener`, all dropped by name in
  `DROPPED_DEFAULT_INTEGRATIONS`. `tests/unit/crashReporting.test.ts` pins the INSTALLED SDK's
  full default-integration list, so the next default an upgrade adds fails CI until it is
  reviewed here, rather than shipping because nothing asked.
- **The app itself ADDS exactly four things to the payload, and this is the whole list.** Each is
  a bare count or a member of a closed set; none is content; none is a capture call.
  1. A breadcrumb, category `app.memory`: when the OS reports memory pressure,
     `src/observability/memoryPressure.ts` records a count of warnings this launch and nothing
     else - no byte figure, no free text, no session content.
  2. Two scope tags, `screen` and `lens`. `screen` is the open screen's route TEMPLATE
     (`/task/[taskId]`), `none` before any screen has rendered, or `unknown`; **never the resolved
     path, whose parameter is one of the desktop's task IDs**. `lens` is which surface of a
     screen was showing, or `none`.
  3. A breadcrumb, category `app.navigation`, on each change of that pair, carrying
     `{ screen, lens }` and nothing else. Its `message` is those same two values joined
     (`/task/[taskId] chat`), there only because the Sentry CLI's trail view prints the message
     column and nothing from `data`.
  4. A breadcrumb, category `app.connection`, carrying `{ state }` where `state` is one of
     `connecting`, `connected`, `established`, `reconnecting`, `closed`, `board-snapshot`, with
     the state repeated as its `message` for the same reason. No relay address, no project, no
     count of anything the desktop sent, no rekey, and nothing about pairing.

  Items 2 to 4 (task #152, 2026-11-18) are written only by `src/observability/reportContext.ts`,
  and every value is checked there, at runtime, against the closed sets in
  `src/observability/reportVocabulary.ts`: a caller cannot widen what leaves by casting, and a
  resolved path handed to the door comes out as `unknown`. The React half
  (`src/navigation/screenTracking.tsx`) reads expo-router's `useSegments()`, never
  `usePathname()`. The screen and its lens are reported by two different components in no
  guaranteed order, and the door is built so either order leaves one trail entry carrying the
  real pair; never reintroduce an assumption about which effect runs first (the one this was
  first built on was read from source and disproved by the first delivered event).
  Which connection transitions are worth a slot is decided in
  `src/state/connectionBreadcrumbs.ts` (each state once per connection cycle, so a retry loop or
  a busy board cannot spend the trail), which watches the stores so that neither
  `src/connection/` nor the banned `src/channel/` records anything.
  This list, with the bullet above, is the canonical enumeration;
  `docs/security.md` mirrors it, so an addition here has to land there in the same change.
- **JS breadcrumbs are allowlisted, not denylisted.** An unanticipated category must be dropped
  by default, because a future SDK version can add one this repo never reviewed. The allowlist
  holds exactly four entries: Sentry's own `sentry.event` bookkeeping, and the app's three
  above, `app.memory`, `app.navigation` and `app.connection`. Each app-owned one deliberately
  avoids a platform category. `app.memory` is NOT `device.event`, which would have
  admitted sentry-cocoa's and sentry-android's battery, keyboard and screen-state breadcrumbs
  along with it. `app.navigation` is NOT the SDK's `navigation`, whose contents the SDK's own
  navigation integration owns and an upgrade can widen, and which both native bridges treat
  specially (they copy its `data.to` into the native scope's current screen). An allowlist entry
  is also what lets a breadcrumb reach a native event at all: `beforeBreadcrumb` runs before the
  sync to the native scope, so a category missing here is recorded in JS and never leaves it.
  Read the
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
- **The crash-test affordance (`crashTestEnabled`, `throwTestError`, `crashNatively`,
  `reportHandledTestError` in `crashReporting.ts`) exists to verify the above against a real
  delivered payload, not to relax it.** `EXPO_PUBLIC_KANGENTIC_CRASHTEST` follows the DSN's own
  rule: dispatch-only (`build-android.yml`'s and `build-ios.yml`'s `crash_test` inputs), never
  in `eas.json`, defaults off, forced off on a tag build. Note the tag clause is the weaker half:
  this project releases by DISPATCH (`-f submit_track=internal`, `-f submit=testflight`), not by
  tag, so the gates that actually matter are Android's `plan` job refusing any dispatch that sets
  both `crash_test` and a real `submit_track`, backed by `submit-play`'s own
  `inputs.crash_test != true`, and the refusal step at the top of both iOS build jobs plus
  `submit-testflight`'s own clause. All are pinned by `tests/unit/buildWorkflow.test.ts`. A
  crash-test build reports to its own Sentry environment, `crash-test`, because it carries the
  SAME release string as the shipped build cut from that version. The flag also gates
  `debug: true`, which DOES reach native (`initNativeSdk` does not strip it) - see the crash
  reporting section of `docs/developer-guide.md`. The third row, `reportHandledTestError`, is
  how the door's redaction is checked against a delivered event: its canary message must not
  arrive.

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
and `allowlistBreadcrumb` govern the JS scope only. sentry-android keeps its own default
auto-breadcrumbs and those ride a NATIVE crash unfiltered. **Observed directly** (a
crash-test build with `debug: true`, a real native crash, the delivered event read back through
the Sentry MCP - not inferred from source): `app.lifecycle` (foreground/background transitions),
`device.event` (battery level, charging state, screen on/off), and `network.event`, which is
more detailed than "coarse app-lifecycle timing" suggests - it carries `action`,
`network_type`, `vpn_active`, `signal_strength`, `download_bandwidth`, and `upload_bandwidth`.
None of it is session content, but "the allowlist is default-deny" is true of the JS path and
not of the native one. Say "JS breadcrumbs are allowlisted", not "breadcrumbs are allowlisted".

**It is now closable from `Sentry.init()`, and is deliberately kept open: a maintainer decision.**
An earlier revision said closing it needed a config plugin and that iOS had no switch at all.
Since @sentry/react-native 8.28 (in this app from 8.29, task #102) every family has an init option
that reaches native: Android `enableAppLifecycleBreadcrumbs` (`app.lifecycle`),
`enableSystemEventBreadcrumbs` (`device.event`), `enableNetworkEventBreadcrumbs`
(`network.event`), `enableActivityLifecycleBreadcrumbs` and `enableAppComponentBreadcrumbs`; iOS
`enableAutoBreadcrumbTracking` and `enableNetworkBreadcrumbs` (the latter a native breadcrumb per
network request). **Decided 2026-10-06: they stay on.** The maintainer's standard is that a crash
report always carries the data relevant to the failure, with enough information to fix it, and
the lifecycle and network trail is exactly that context. The same decision keeps the
approximate city-level location Sentry derives from the report's IP address (a server-side
lookup; the app has no location permission). Both are disclosed in `docs/privacy-policy.md`.
The line this does NOT move is session content: the scrubber, the breadcrumb allowlist and the
handled-error door stay exactly as they are. Reversing either native decision is still a
privacy-policy change that edits `docs/privacy-policy.md` and `docs/security.md` together.

**A report must say where, doing what, and since when. Decided 2026-11-18, and what was
considered and not adopted.** The maintainer's directive, extending the 2026-10-06 standard
above: an issue that cannot be fixed for lack of information the app could have captured is a
REPORTING bug, and the report is what gets strengthened. Sentry MOBILE-H (an iOS app hang on
1.5.0 build 24) was the first handled under it: its event named no screen and no app state, and
its trail was exactly `maxBreadcrumbs: 20` entries of sentry-cocoa's own battery and clock
crumbs, about three per background wake over two and a half days. MOBILE-8 had the same gap
earlier. Task #152 answered with `maxBreadcrumbs: 100` and items 2 to 4 of the app-added list
above. `/sentry` now files such an issue against a reporting-gap task instead of listing it as
not filed.

Recorded so the next pass does not re-propose them, each considered for the same gap and NOT
adopted:

- **Performance tracing and profiling.** Usage telemetry: a transaction per screen visit and per
  interaction, sent whether or not anything broke, against a privacy policy that says nothing
  is sent while the app works. (This file and `crashReporting.ts` used to give a second reason,
  that transaction names carry route parameters. Read out of @sentry/react-native 8.34.0, that
  is wrong: under expo-router a transaction is named for the route template, and the resolved
  URL and params are span attributes only under `sendDefaultPii`. The decision does not need
  it, and the correction is kept in `crashReporting.ts` beside the option.)
- **Screenshots, view hierarchy and Session Replay.** Screen content, which is session content.
- **`enableJsHangTracking`.** Experimental, and it would not have helped: MOBILE-H's JS thread
  was idle in its run loop while the main thread laid out text.
- **The SDK's own navigation integration** (`reactNavigationIntegration` /
  `expoRouterIntegration`). It would have recorded route names with no code of ours, and read
  from 8.34.0 it does emit templates. But its `navigation` breadcrumb's contents belong to the
  SDK, so an upgrade can widen them with every check green, it is built around tracing spans
  this app keeps off, and its breadcrumb sets the native scope's current screen as a side
  effect. An app-owned category whose one writer checks a closed set is the same information
  with nothing delegated.
- **Recording every connection transition, every board snapshot, and rekeys.** A retry loop
  against an absent desktop alternates `connected` and `reconnecting` on a five-second floor, a
  busy board is re-read on a 300 ms debounce, and a rekey arrives every two minutes or so. Any
  one of them would spend the 100-entry trail and evict the screen crumbs that say where the
  user was, which is the failure MOBILE-H already demonstrated with the native SDK's crumbs.

**What the app-added tags and breadcrumbs are known to reach, and how it is known.** Three
different strengths of evidence, kept apart on purpose (see
`performance-claims-are-measured.md` for why this repo labels them):

- **Read from source** (@sentry/react-native 8.34.0): `Sentry.init` makes only the ISOLATION and
  GLOBAL scopes sync to native (`dist/js/sdk.js`, `enableSyncToNative`). The top-level
  `Sentry.setTag` and `Sentry.addBreadcrumb` write the isolation scope, so they sync;
  `Sentry.getCurrentScope().setTag(...)` looks equivalent and stays in JavaScript. A breadcrumb
  syncs only after `beforeBreadcrumb` admits it. `maxBreadcrumbs` reaches both native SDKs
  (`RNSentryStart.java`; sentry-cocoa's `Options+Dictionary.swift`), as does
  `enableNdkScopeSync`, which is pinned on so an NDK-caught Android crash keeps the scope.
- **Read from source** (sentry-cocoa 9.33.0, the version 8.34.0 bundles): an app hang has the
  scope applied when it is detected (`SentryHangTrackingIntegration`,
  `scope.applyTo(event:maxBreadcrumbs:)`), though on a UI build the event is stored and sent
  when the hang ends or on the next launch. A watchdog-termination event is built on the next
  launch from tags (`readPreviousTagsFromDisk`) and from a breadcrumb file bounded by, and
  trimmed to, `options.maxBreadcrumbs`. So the persisted trail follows the same cap.
- **Observed on a delivered event:** see the crash reporting section of
  `docs/developer-guide.md`, which records what each platform's native crash carried and the
  date. Two things that section says plainly because no crash-test row can produce them: an app
  hang and a watchdog termination have not been observed carrying the tags, and the `lens` tag
  has only been observed as `none`, because both crash rows live in Settings. A recurrence of
  MOBILE-H on a build with this change is the first direct proof of the hang path.

**The trail is a ring the native SDKs share, so the TAG is the durable answer.** Raising the cap
to 100 does not stop sentry-cocoa's `device.event` crumbs filling it on a phone left alone for
long enough; it moves the horizon by a factor of five. What survives any amount of that is the
`screen` and `lens` tags, which are single values that are replaced rather than appended. Read
an event's tags first and its trail second, and count the trail against 100 before concluding
that something did not happen.

**The native breadcrumbs also ride a JS-CAPTURED event, and there the allowlist does reach
them.** Observed on the first iOS event the project ever received (the handled canary from
`build-ios.yml` run 34672597979, 2026-09-12): `started` and `ui.lifecycle`, sentry-cocoa's own
auto-breadcrumbs, arrived on a JS-captured event that `beforeBreadcrumb` never saw them on. The
SDK's device-context integration concatenates the native scope's breadcrumbs into every JS
event in a `processEvent` hook (`dist/js/integrations/devicecontext.js`), which runs before
`beforeSend`. So `scrubEvent` applies `allowlistBreadcrumb` to `event.breadcrumbs` as well,
default-deny, and omits the key when nothing survives; `tests/unit/scrubEvent.test.ts` pins it.
That closes the ride-along for JS-captured events on both platforms and changes nothing about a
native crash, which still never passes through JS.

**An iOS memory warning is recorded by this app because the SDK does not record it.**
sentry-cocoa's `SentrySystemEventBreadcrumbs` (read at 8.58.0; the sentry-cocoa changelog through
9.30.0, which @sentry/react-native 8.29 bundles, records "Remove MemoryWarningIntegration #537" and
nothing re-adding it) observes keyboard, screenshot, battery,
orientation, timezone and significant-time-change notifications, and **not**
`UIApplicationDidReceiveMemoryWarningNotification`. So on iOS there is no memory-warning
breadcrumb to be absent, and the absence of one says nothing - a trap worth knowing before
reasoning about a `WatchdogTermination` event (Sentry MOBILE-8, where exactly that inference was
drawn and then retracted). `src/observability/memoryPressure.ts` closes it by subscribing to React
Native's `AppState` `memoryWarning` event and recording the breadcrumb itself. The path to a
watchdog-termination event is verified in sentry-cocoa source rather than assumed:
`RNSentry.addBreadcrumb` writes to the real `SentryScope`, whose observers include
`SentryWatchdogTerminationScopeObserver`, which forwards to a processor that serializes and
appends to disk immediately (no batching, so a fast kill cannot lose it), and
`SentryWatchdogTerminationTracker` builds its event with `readPreviousBreadcrumbs` after clearing
the current scope's.

**The breadcrumb is effectively iOS-only, and on Android 14+ it does not fire at all.** React
Native's `AppStateModule` never emits `memoryWarning` and RN does not surface `onTrimMemory`, so
the local Expo module in `modules/memory-pressure` registers a `ComponentCallbacks2` on the
APPLICATION context and forwards it. **From Android 14 the system delivers only
`TRIM_MEMORY_UI_HIDDEN` and `TRIM_MEMORY_BACKGROUND`**; the `RUNNING_*`, `MODERATE` and `COMPLETE`
constants are no longer sent and were deprecated in Android 15
([Android docs](https://developer.android.com/topic/performance/memory/manage-app-memory)).

Those two mean "the user is not looking", not "memory is short", so they are classed
`backgrounded` and **deliberately do not reach the breadcrumb count**: on a modern Android device
they are the only signal that ever arrives, so counting them would make `app.memory` a record of
how often the user left the app - present on every launch, absent never, and therefore worth
exactly as much as the missing iOS signal it was built to replace. They DO drive the memory
shedders, which is the safest possible moment to shed. The legacy levels still classify as
`moderate` / `serious` and still breadcrumb on pre-14 devices. An earlier revision of this file
claimed Android reported the same breadcrumb; that was wrong, and the module it described was
inert on every current Android device. The payload is identical on both platforms (a count, no level, no free
text), so the two sources cannot be told apart in a delivered event. The two never both fire on
one device, so a single episode is never counted twice.

**A crash caught by the operating system, not by the app's own code, carries a per-install
identifier in `user.id` - `sendDefaultPii: false` does not stop it.** sentry-android always
populates `contexts.device.id` (a random UUID generated once per app install, unrelated to
`Secure.ANDROID_ID` or any advertising ID; confirmed against docs.sentry.io) in the device
context, and on the uncaught-exception path it additionally promotes that same value into
`user.id` before the JS layer, and `scrubEvent`, ever sees the event - `beforeSend` does not run
for a native-captured event at all. Confirmed with two real delivered events off the same
install: a JS-caught throw carried `Users: 0` (`scrubEvent` strips `user`), the OS-caught crash
carried `Users: 1` with `user.id` identical to that event's `contexts.device.id`. This is the
sharpest instance of "`beforeSend` cannot reach native" in the whole file: it is not a missing
breadcrumb, it is an identifier. **`Sentry.setUser(null)` was tried as a suppression, called
immediately after `Sentry.init()`, and did not visibly suppress it**: a fresh native crash with
that call in place still carried `user.id` equal to `contexts.device.id`. `setUser` does bridge
to the native scope (`RNSentry.setUser`, a runtime call, unlike an init option destructured out
in wrapper.js) and Sentry's own docs describe `contexts.device.id` as populated by the device
context independent of the user scope, which is the likely reason nulling the user did not
touch it - but that explanation was not confirmed by reading sentry-android's source in this
session, and the probe run also crossed a fresh app install (a new `device.id` on its own), so
the observation does not isolate `setUser(null)` as cleanly as a controlled before/after would.
There is no known JS-reachable way to suppress this identifier; the control point is disclosure,
not removal. `docs/privacy-policy.md` and `docs/store-listing.md` describe this identifier
rather than claim it does not exist.

**What was NOT tested: a real native (NDK/signal-handler) crash.** Every native-path observation
above came from `Sentry.nativeCrash()`, which is `RNSentryModuleImpl.crash()` throwing a
`RuntimeException` caught by Android's `UncaughtExceptionHandler` - `platform: java`,
`mechanism: UncaughtExceptionHandler` (on @sentry/react-native 8.29 the same crash reports
`mechanism: expoReactHost`, observed 2026-10-06, with `contexts.expo_constants` and
`contexts.turbo_module` absent and the same `app.lifecycle`/`device.event` breadcrumbs as
before). That is the Java-uncaught path, not a SIGSEGV or other
signal caught by sentry-android's NDK handler. The two paths share the same auto-breadcrumb and
`user.id` machinery in sentry-android, so there is no specific reason to expect them to differ,
but that is an inference, not an observation, and this file says so rather than implying full
coverage.

**Channel-origin exception messages reach Sentry on the UNCAUGHT path.** The handled-error door
removes them from every deliberate catch that reports, and the import ban stops
`src/pairing/`, `src/channel/` and `src/notifications/` making a deliberate capture call; neither
does anything about an error from those directories propagating out uncaught and being picked
up by the global handler. That is not hypothetical: `EXPECTED_TRANSPORT_NOISE` in
`crashReporting.ts` exists precisely because `src/channel/relayTransport.ts` errors do arrive,
and `CapabilityError` (`src/channel/verbClient.ts`) puts the desktop-supplied `response.error`
string verbatim into its message. `scrubEvent` deliberately never touches `exception.value` on
an uncaught event - reporting the message is the point of a crash reporter - so such a message
ships as-is. Truncating or genericizing peer-supplied error text at its construction site is
the fix if this ever matters; until then it is a named gap, not an unbroken invariant.

**The door trades diagnosability for the redaction, deliberately.** Every bare `Error` caught at
one site shares one issue (the fingerprint is site, class name, verb, and a refusal code when
there is one), so a Keychain error and a JSON error at the same site are told apart only by their
stack frames inside it. The fix is a typed error at the throw site, which
`ChannelDisconnectedError` and `CapabilityTimeoutError` in `src/channel/capabilityClient.ts`
began, or a protocol refusal code for a desktop refusal (Sentry MOBILE-C, whose event could not
say which refusal fired until the desktop sent `unknown-session`); never a message allowlist.

**Counts read out of Sentry for a handled site are lower bounds.** The door reports at most one
event per fingerprint per minute and ten per launch, and the SDK's default Dedupe
integration drops back-to-back identical events besides. Use them to see THAT a site fails, not
how often.

## Enforcement (self-maintaining)

- **Lint (live now):** `eslint.config.mjs` declares three `no-restricted-imports` zones - two
  confining `@sentry/*` to `src/observability/` (one for `.ts`/`.tsx` with `allowTypeImports`,
  one for `.js`/`.mjs`/`.cjs`), and one banning both the SDK and the wrapper from the pairing,
  channel, demo, devsupport, and notification directories plus `app/+native-intent.ts`.
  `Lint (ESLint)` is a required status check on `main`,
  so this is mechanical rather than review-only. Each zone was verified to fire by probe file,
  not merely assumed, and `tests/unit/eslintConfig.test.ts` pins BOTH directions: every banned
  entry refuses the door, and `src/screens`, `src/components`, `src/connection` and `src/state`
  may import it, so a reordered zone cannot silently ban the door from every screen and read as
  "nothing calls it". **Its one hole is closed by a scan for `src/` and `app/`:**
  `no-restricted-imports` matches `import` syntax only, never `require()` or a dynamic
  `import()`, and `metro.config.js` legitimately does `require('@sentry/react-native/metro')`,
  so the pattern is live in this repo. `tests/unit/crashReportingConfinement.test.ts` scans
  every source file for a `require()` or `import()` of the SDK outside `src/observability/`,
  and for any route at all to the SDK or the wrapper from the banned directories;
  `metro.config.js` sits outside the scan by design.
- **Test (live now):** `tests/unit/scrubEvent.test.ts` locks the scrubber, the `site`-keyed
  redaction and the breadcrumb allowlist, including its default-deny behaviour.
  The app-added screen and connection data has its own set, each written against a named
  mutation: `tests/unit/reportVocabulary.test.ts` (a resolved path is `unknown`, and the route
  record matches the files under `app/` in both directions, so a new screen cannot ship
  reporting as `unknown`), `tests/unit/reportContext.test.ts` (the door refuses any value
  outside the closed sets, keeps a lens to the screen instance that set it, and records one
  trail entry per arrival whichever of the screen and the lens is reported first),
  `tests/unit/connectionBreadcrumbs.test.ts` (each state once per connection cycle, and a
  deliberate close is recorded), `tests/components/ScreenTracker.test.tsx` (the tracker under
  expo-router's REAL `useSegments`, red when it is swapped for the resolved pathname),
  `tests/unit/rootLayoutWiring.test.ts` (the tracker is mounted, once, outside the Stack) and
  `tests/unit/bundleEntry.test.ts` (the scope's starting tags are set straight after init).
  `tests/unit/crashReporting.test.ts` locks the door's contract (a synthetic error, frames only,
  the four tags, the fingerprint, the exclusions, the cooldown and cap) and the four
  environments. `tests/unit/buildWorkflow.test.ts` locks the pre-prebuild ordering of the Sentry
  env export on both platforms, the crash-test gates, and asserts no DSN is committed. One
  mechanical consequence for the vitest tier: a test that loads a module importing the door
  while stubbing `react-native` without `NativeModules` must
  `vi.mock('@/observability/crashReporting')`, because `@sentry/react-native`'s wrapper reads
  `NativeModules.RNSentry` at import time.
- **Review (live now):** the `crypto-pairing-auditor` agent should treat any new Sentry call
  site, or any relaxation of an init option above, as in scope during `/code-review`.
- **Skill (live now):** `/sentry` (`.claude/skills/sentry/SKILL.md`) reads arriving issues and
  defers to this rule for the privacy controls and their known limitations rather than
  restating them. It also carries the 2026-11-18 directive at the point of use: its first
  diagnosis check is whether the event says where, doing what, and since when, and an issue
  that cannot be fixed for lack of that is filed against a reporting-gap task. Its no-raw-payload boundary (never paste an event payload or a `user.id` into
  a task, PR, or reply) is this rule's "Known limitations" section applied at retrieval time, so
  the two move together.

## Scope

`src/observability/**` and the directories (plus `app/+native-intent.ts`) banned from reporting.
Does not govern what the desktop or relay log about themselves.
