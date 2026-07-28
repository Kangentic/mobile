# Security

Kangentic Mobile pairs to, and then remotely steers, agent sessions running on a desktop machine
that can edit code and execute commands. This document is the threat model and the security
design; an auditable core is treated as a feature, not a nice-to-have. See
[SECURITY.md](../SECURITY.md) for how to report a vulnerability.

## Threat model

**Assets:** the device identity key (X25519, per device), the pairing token, the signed device
roster, and transcript/board content in transit.

**Adversaries:**
- A network attacker who can observe or inject traffic to and from the relay.
- A malicious or compromised relay operator (including a self-hosted relay run by an untrusted
  third party, or Kangentic's own hosted relay if it were ever compromised).
- An attacker who photographs or otherwise captures the pairing QR code.
- An attacker with physical access to a lost or stolen phone.

**Blast radius:** the channel this app establishes can steer an agent that edits code and runs
commands on the paired desktop. A compromise here is not "read someone's chat", it is closer to
a remote-access compromise, and the design is held to that bar.

## Pairing ceremony

The desktop displays a QR code; the phone scans it. The QR carries the desktop's static public
key, a short-lived (~10 minute) single-use pairing token, a relay address, and a protocol
version. It never carries a long-lived secret (this is the mistake in Happy's `handy://` QR
scheme, which embeds the raw 32-byte master secret).

**This is a token-bound Noise PSK, deliberately NOT a PAKE.** The pairing token is a high-entropy
(>=128-bit), single-use, machine-generated value, mixed into the Noise handshake as a pre-shared
key in PSK mode. A PAKE (SPAKE2, CPace) exists to defend a *low-entropy, human-typed* code
against offline dictionary grinding; that property is irrelevant here because the token is
already high-entropy and scanned, not typed. Reusing the token as a Noise PSK gives the same
practical guarantee a PAKE would (an attacker who intercepts the pairing traffic gets exactly one
online guess, gated by the relay, and nothing to grind offline), while keeping exactly one
audited crypto primitive (Noise) across both pairing and ongoing sessions, and without depending
on a maintained, audited JavaScript SPAKE2 implementation (none currently exists; the one
published package is years-stale, targets an old draft, and is Node-only, which would also break
React Native parity). If a human-typeable short-code pairing path is ever added, a PAKE becomes
relevant again and should be revisited at that time.

## SAS confirmation

After the handshake, both sides derive a **Short Authentication String** (a 6-digit or emoji
code, Matrix-style) from the transcript hash, using commitment-before-reveal so neither side can
choose a value after seeing the other's. The user confirms the two codes match on both screens.
This defeats a photographed or relayed QR: an attacker who intercepts the QR and races to pair
first cannot also make both SAS values agree, because the SAS is bound to the actual handshake
transcript with the real desktop.

## Transport

Every session runs a fresh **Noise KK** handshake
(`Noise_KK_25519_ChaChaPoly_BLAKE2s`): both static keys are pre-messages exchanged during
pairing, so there is mutual authentication by construction and neither identity is ever sent on
the wire.

- **Downgrade protection:** the protocol version is bound into the Noise prologue; a mismatched
  prologue fails the handshake rather than silently negotiating down.
- **No state-changing command in the first payload:** Noise KK message 1 is replayable
  pre-ephemeral, so nothing that changes state may ride it.
- **Rekeying:** sessions rekey roughly every 2 minutes (WireGuard's `REKEY_AFTER_TIME`), bounding
  the damage of a compromised session key.
- **Replay protection:** per-direction 64-bit counter nonces reject anything at or below the last
  seen value.
- **A goodbye is a courtesy, not a proof.** A deliberate teardown (unpairing) sends a
  `FrameTag.Final`-tagged frame so the desktop can drop the device promptly, but its *absence*
  proves nothing: anyone who can drop the socket can suppress it. The desktop's presence probing
  stays load-bearing, and a missing Final must never be read as evidence a device is still there.
- **No Double Ratchet.** Double Ratchet solves offline, asynchronous message queuing, which this
  interactive link does not have; adding it would be unjustified complexity.
- **Relay scheme enforcement:** the pairing token is mixed into the handshake as the Noise PSK
  and dialed verbatim as the relay's slot parameter, so a plaintext relay connection would put
  it on the wire in cleartext. The phone (`src/pairing/qr.ts`) refuses to pair through any
  relay address that isn't `wss://`, carving out only loopback (`ws://localhost`, `127.0.0.1`,
  `::1`) for a local dev relay.

  **That carve-out is decided by parsing the address's AUTHORITY, never by prefix matching.**
  A prefix test can only ask what an address starts with, which says nothing about the host it
  resolves to, and it accepted two impostors: `ws://127.0.0.1:8080@evil.test`, where everything
  before the `@` is userinfo so the real host is `evil.test`; and `ws://[::1]evil.com`, where
  truncating at the closing bracket read the host as `[::1]`. Either would have handed the
  pairing token - the Noise PSK - to an attacker-chosen host in cleartext, and `activePairing`
  would then have persisted that host to the trust anchor for every later session. The same
  rules live in `@kangentic/protocol`'s `relay-address.ts` (0.11.1), which the desktop reads
  through `src/shared/relay.ts`, so both ends enforce one definition. Two build shapes additionally accept `ws://10.0.2.2`, the
  Android emulator's NAT alias for the host's loopback interface, so a rig relay is reachable
  without an `adb reverse`: a `__DEV__` bundle, and a build from the **`e2e` EAS profile**,
  which sets `EXPO_PUBLIC_KANGENTIC_E2E=1`. E2E needs a release-shaped binary (Maestro tests the
  final bundled app, and a dev client drags in a dev menu, a Metro dependency, and a bundle URL
  that `pm clear` wipes), and without the flag that binary refuses the local relay.

  A release-shaped build additionally needs Android's own permission to speak cleartext at all:
  the platform refuses a `ws://` socket before any of our code runs, which surfaces as "Relay
  connection closed before it opened (code 1006)". The `e2e` profile therefore also sets
  `usesCleartextTraffic` (via `expo-build-properties` in `app.config.ts`), gated on the same
  `EXPO_PUBLIC_KANGENTIC_E2E` flag, so it travels with that profile and no other. The dev client
  never needed it because a debug build ships a network-security-config that permits cleartext.

  Both gates are decided at BUILD time and both fold to a constant: `__DEV__` and every
  `EXPO_PUBLIC_*` value are substituted as literals by Metro, so a `production` bundle contains
  neither branch. There is no runtime flag, setting, or intent that can widen an installed app's
  accepted relay addresses. The `e2e` profile is `distribution: internal` and is never the
  profile that ships. Note the gate is on the BUILD, not the device: an `e2e` or dev build
  installed on a physical phone would accept `10.0.2.2`, where it is an ordinary private address
  rather than a loopback alias, so neither belongs on a phone that pairs with anything real.

## Authorization

The encrypted channel proves *which* device is talking; a desktop-enforced capability allowlist
decides *what* it may do (see `docs/architecture.md` for the ten-verb table). **There is no
shell, file-read, or arbitrary-command verb in the protocol at all: it is absent, not filtered.**
This follows the lesson of Chrome Remote Desktop and VS Code tunnels, which are identity-gated
but capability-unscoped, and of the SSH forced-command pattern, which shows that a filter on an
otherwise-general command channel is the wrong shape.

The default pairing grant is the read-only four (`read-stream`, `read-board`, `read-diff`,
`board-tool-read`) plus `register-push`, which only lets the desktop send this device encrypted
notifications and carries no read or write authority of its own; every write/control verb
(`send-user-message`, `move-task`, `answer-permission-prompt`, `interactive-terminal`,
`board-tool-write`) requires an explicit per-verb grant in the desktop's Mobile Devices settings. `interactive-terminal` is deliberately
raw keystrokes to one session's PTY - powerful, but scoped to the agent session the desktop is
already running, never a new shell. Its resize/release actions (the phone sizing that PTY to the
phone screen) ride the same grant rather than a new verb: a device already trusted to type raw
bytes into the PTY gains nothing from resizing it, and the desktop restores its own dimensions
the moment the phone releases, disconnects, or is revoked. The `board-tool-*` verbs dispatch into a hand-classified
allowlist of the desktop's task/backlog command registry; the raw-SQL escape hatch and every
code-execution tool family are excluded desktop-side.

**Revocation is removal from the signed roster AND a rekey of the channel.** Removing a device
from the roster without rotating keys is not revocation; a device also ages out via a per-device
key expiry, so a lost phone is not trusted forever even if revocation is missed.

## Key storage

- **iOS:** `expo-secure-store`, backed by the Keychain. The Secure Enclave only supports P-256,
  so the app's X25519 identity keys cannot be enclave-resident; they get Keychain protection
  instead. This is stated plainly rather than worked around.
- **Android:** `expo-secure-store`, backed by the Keystore (StrongBox-backed where the device
  supports it).
- **No attestation requirement.** Play Integrity and App Attest would break sideloaded and
  F-Droid-style builds of an open-source app, and buy little against this threat model, so this
  app does not require them.
- **Device-bound, not backup-portable.** The identity key (`src/pairing/deviceIdentity.ts`),
  the pinned trust anchor (`src/pairing/trustAnchor.ts` - the desktop's static key, the relay
  address under `trust.relayAddress`, and the paired-at timestamp), and the push secrets
  (`src/notifications/pushKeys.ts` - the 32-byte push-decrypt key under `push.decrypt.key` and
  the last-registered Expo push token, itself a per-device bearer secret, under
  `push.expoToken.lastRegistered`) are written with
  `SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so none of it is included in an encrypted iOS
  device backup or restorable onto different hardware. Restoring a backup onto a new phone
  cannot reconstitute a working paired client; the device must re-pair. The only other
  secure-store values are the non-secret user preferences (`src/state/settingsStore.ts`),
  stored there because AsyncStorage is banned in `src/state/**`.

## Relay metadata honesty statement

A blind relay forwards ciphertext only, but it still sees source and destination IP addresses,
connection timing, frame sizes and frequency, and the pairing graph (which devices talk to which
relay slot). This app does not claim otherwise. Mitigations: self-hosting your own
`relay` instance, single-use pairing tokens, and relay slot tokens so only paired
devices can consume relay capacity at all.

One frame size is worth naming rather than leaving under "frame sizes". The deliberate-teardown
goodbye seals an EMPTY plaintext, so it is the only frame the phone ever sends at the
secretstream minimum (a tag byte plus the Poly1305 tag); every ordinary `BridgeMessage` is
encoded JSON and far larger. A relay operator can therefore tell a deliberate unpair from a
dropped socket by length alone, without breaking anything. That is a departure signal, not
content, and it is information the operator would get from the slot going quiet moments later
anyway - but it is newly precise, so it is stated here rather than implied.

## Push privacy

Push notifications are ciphertext plus a generic placeholder only (see
`.claude/rules/e2e-notification-privacy.md`); every failure mode degrades to the placeholder,
never to plaintext or raw ciphertext shown to the user. On-device decrypt lives in
`src/notifications/pushDecrypt.ts`: the envelope is sealed with a device-generated push key and
this phone's static public key as the AAD, opened with a 24h staleness / 5min future-skew
window, and any failure (missing key, wrong key, wrong recipient, tamper, malformed, stale)
returns the placeholder. Decrypted content is never logged.

Unpairing revokes push, not just trust: `DevicesScreen` calls
`connectionManager.revokePushRegistrationForUnpair()` while the channel is still up, which sends
`register-push` with `action: 'unregister'` and then wipes the local push key
(`pushKeys.clearPushRegistration()`) before the trust anchor is cleared. Without this, an
unpaired desktop would retain a valid `(expoPushToken, pushKey)` pair and could still push
notifications this phone would decrypt and display.

### Expo is in the delivery path, deliberately

`src/notifications/pushRegistration.ts` calls `Notifications.getExpoPushTokenAsync()`, so the
token registered with the desktop is an `ExponentPushToken`, not a raw FCM token. Delivery is
therefore **desktop -> Expo push service -> FCM/APNs -> device**, and Expo relays on our behalf
using an FCM V1 service-account key uploaded to the Expo project's Android credentials.

This is a conscious trade, not an oversight, and it is worth stating plainly because it sits
awkwardly next to `.claude/rules/accountless-core.md`:

- **What Expo cannot see:** notification content. Payloads are ciphertext plus a generic
  placeholder, which is the whole point of the rule above. This holds regardless of who relays.
- **What Expo can see:** metadata. Which device receives a notification, when, and how often.
  Expo also holds a credential that can push to every install of the app.
- **What it costs a self-hoster:** an Expo account, and uploading their own FCM key to Expo, for
  remote push to work at all. Everything else in the pairing, transport, and capability path is
  genuinely accountless. Push is one of two places a third party sits in a path at all; crash
  reporting, below, is the other, and it costs a self-hoster nothing because it is inert without
  a build secret they will not have.
- **Why we accept it:** Expo Push is free (no per-notification charge, no paid plan required) and
  covers Android and iOS through one token and one API. Going direct means implementing FCM v1
  *and* APNs separately, and APNs is the expensive half.
- **Degradation:** push is optional. Without any of this the app records
  `unavailable-no-fcm` and works fully, minus remote notifications.

The exit path, if the metadata exposure or the account requirement ever becomes unacceptable:
switch to `getDevicePushTokenAsync()` for a raw FCM token and have the desktop call FCM v1
directly. That is a `@kangentic/protocol` change first (`RegisterPushRequestPayload.expoPushToken`),
per `.claude/rules/protocol-types-from-package.md`, then desktop send-path work, then APNs for iOS.

## Crash reporting

Official builds report crashes to [Sentry](https://sentry.io). Like Expo push above, this is a
conscious trade rather than an oversight, and it sits next to the same accountless-core rule, so
it gets the same plain accounting.

The controls are set at their source rather than in a filter, because **a JavaScript `beforeSend`
hook does not filter native events**: a hard iOS or Android crash is captured and sent by
sentry-cocoa / sentry-android without passing through the JS layer at all. JS breadcrumbs are
also synced into the native scope, so a console breadcrumb recorded in JS would ride a native
crash past any JS scrubber. Anything that must not be sent is therefore never collected, rather
than collected and stripped. `src/observability/crashReporting.ts` is the single place this is
configured, and `.claude/rules/crash-reporting-scope.md` is the rule that keeps it that way.

- **What Sentry cannot see:** session content. No screenshots, no view hierarchy, no console
  output, no captured network requests, no JS network breadcrumbs, no Session Replay, no
  performance traces, no structured logs, and no PII - each disabled explicitly, several of them
  ON by default in the SDK. Screenshots and view hierarchy are the two that reach native, and
  both are off there too. Transcripts, terminal output,
  diff content, board data, pairing material and notification payloads are never collected, and
  `src/pairing/`, `src/channel/` and `src/notifications/` are forbidden by lint from reporting to
  Sentry at all, because their error messages can echo ciphertext, key material, or
  attacker-controlled bytes (see `src/notifications/pushDecrypt.ts`).
- **What Sentry can see:** that this app crashed, where in the code, and on what kind of device.
  A stack trace, the exception type and message, app version, and the SDK's standard device and
  OS context. That context is wider than model and OS version alone: it is the platform's normal
  diagnostic block, and includes things like battery level, free memory and storage, screen
  resolution, orientation, and device timezone. None of it is session content, none of it is an
  account, and it is not used to profile a user, but "device model and OS" understates it and
  this document would rather be exact.
  A crash is by definition an unplanned state, so a message could in principle carry a fragment
  of app data; the exception is code that runs on the paths above, which cannot report.
- **What the native SDKs still record, which JS cannot turn off.** The breadcrumb controls in
  `Sentry.init()` are JavaScript-side only: `@sentry/react-native` strips `beforeSend`,
  `beforeBreadcrumb` and `integrations` out of the options before handing them to the native SDK
  (`node_modules/@sentry/react-native/dist/js/wrapper.js`), so sentry-android keeps its own
  default breadcrumbs and those ride a NATIVE crash. **Observed directly** (a crash-test build, a
  real native crash, the delivered event read back through the Sentry MCP - not inferred from
  source): `app.lifecycle` (foreground/background), `device.event` (battery level, charging,
  screen on/off), and `network.event`, which carries `action`, `network_type`, `vpn_active`,
  `signal_strength`, `download_bandwidth`, and `upload_bandwidth` - more detail than "coarse
  app-lifecycle timing" suggested before this was verified. None of it is session content.
  Closing this needs native configuration through a config plugin, not a JS option; it is a named
  gap, not an oversight. iOS app-hang and watchdog-termination reporting are likewise left at
  their native defaults (on), deliberately: a hang and an out-of-memory kill are the app
  breaking, which is what this reports.
- **What the native SDK sends that `sendDefaultPii: false` does not stop: a per-install
  identifier, on a crash the OS catches rather than the app's own code.** sentry-android always
  populates `contexts.device.id` (a random UUID generated once per app install - not
  `Secure.ANDROID_ID`, not an advertising ID) and, on the uncaught-exception path, promotes that
  same value into `user.id` before `beforeSend` ever runs - `beforeSend` does not run for a
  native-captured event at all. Confirmed with two real delivered events off the same install: a
  JS-caught throw carried `Users: 0` (`scrubEvent` strips `user`), the OS-caught crash carried
  `Users: 1` with `user.id` equal to that event's `contexts.device.id`.
  `Sentry.setUser(null)` was tried as a suppression, called immediately after `Sentry.init()`,
  and did not visibly suppress it - a fresh native crash with that call in place still carried
  `user.id` equal to `contexts.device.id`. There is no known JS-reachable fix. This identifier is
  declared in the Play and App Store Connect privacy answers (`docs/store-listing.md`) and
  described, not denied, in `docs/privacy-policy.md`.
  **Not tested:** a real native (NDK/signal-handler) crash - every observation above came from
  `Sentry.nativeCrash()`, a Java-uncaught `RuntimeException`, not a SIGSEGV caught by
  sentry-android's NDK handler; and iOS native crash reporting at all (no Mac, no iOS device).
- **What it costs a self-hoster:** nothing. The DSN is injected at build time from a GitHub
  repository variable (`vars.SENTRY_DSN`, not a secret: a DSN ships inside the published bundle
  and is write-only, so it is not confidential) and is never committed, so a build made from this
  repository never calls `Sentry.init()`, starts no native SDK, and sends nothing. This is deliberate twice over: it keeps self-hosted builds free of any
  Kangentic-operated service, and it stops a fork's crashes consuming this project's free-tier
  quota.
- **Why we accept it:** the alternative is shipping blind. The app has no logger, no error
  boundary, and no other diagnostics, so before this a production crash was simply invisible.
  Store dashboards (Play Console, App Store Connect) report crash counts but no JavaScript
  frames, which for a React Native app is most of the story.
- **Degradation:** entirely optional and entirely absent when unconfigured. There is no runtime
  dependency on it, no user-facing behaviour attached to it, and no failure mode if Sentry is
  unreachable.

Two things are deliberately off and are worth naming because they would each be a defensible
default elsewhere. **Session tracking** is disabled: it produces crash-free rate, a genuinely
useful stability metric, but it is a per-foreground ping and therefore usage telemetry, which
this app tells users it does not collect. **Sampling** is not used; every error is sent, because
the volume is low and the free tier's budget is better spent on completeness than on smoothing.

The exit path, if this ever becomes unacceptable: delete the `SENTRY_DSN` repository variable
(GitHub Settings, Variables rather than Secrets) and the SDK goes inert across every build with
no code change. Removing the dependency outright is four edits, not one: drop it from
`package.json`, delete `src/observability/` and its call in `index.js`, revert `metro.config.js`
to `getDefaultConfig`, and remove the conditional plugin entry from `app.config.ts`. The last two
matter, because leaving either behind after uninstalling the package breaks Metro startup and
prebuild respectively.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).

## See Also

- [docs/architecture.md](architecture.md) - system overview, the capability verb table, the
  notification pipeline.
- [docs/developer-guide.md](developer-guide.md) - setup and testing.
