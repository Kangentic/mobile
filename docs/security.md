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

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).

## See Also

- [docs/architecture.md](architecture.md) - system overview, the capability verb table, the
  notification pipeline.
- [docs/developer-guide.md](developer-guide.md) - setup and testing.
