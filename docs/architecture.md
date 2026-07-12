# Architecture

kangentic-mobile is a companion app that remote-controls agent sessions running in the desktop
[Kangentic](https://github.com/Kangentic/kangentic) app. This document describes the
architecture as scaffolded in App Phase 1; see `CLAUDE.md`'s Project Structure for the current
layout. The durable research behind these decisions lives in the desktop repo's
[`docs/research/mobile-companion-app.md`](https://github.com/Kangentic/kangentic/blob/main/docs/research/mobile-companion-app.md);
this document is the implementation-facing summary and is authoritative where the two disagree
(notably the pairing ceremony, see below).

## Overview

```
  Desktop (Kangentic)                            Phone (kangentic-mobile)
  mobile-bridge module                           Expo / React Native app
  - device identity + roster    QR pairing       - device identity (Keychain/
  - capability router          <=============>     Keystore)
  - session/board/diff feeds    (token-PSK + SAS) - board + conversation UI
        |                                                |
        |  outbound WSS                    outbound WSS  |
        +-----------> [ blind relay ] <------------------+
        |             (ciphertext only,                  |
        |              self-hostable: kangentic-relay)    |
        +===== Noise KK secure channel (E2E) =============+
        +---- Expo Push (E2E-encrypted blob -> NSE / Notifee handler) -->+
```

A later phase adds a WebRTC data channel upgrade for direct P2P; the relay remains the permanent
fallback for the networks that cannot punch through.

## Repos and boundaries

- **`kangentic`** (desktop, this app's counterpart): hosts a `mobile-bridge` module that exposes
  session, board, diff, and activity feeds to paired devices, and is the source of truth for the
  `@kangentic/protocol` npm package.
- **`@kangentic/protocol`**: the wire schema, the shared Noise KK implementation, capability
  verbs, and transcript/board/activity event types. Published from the desktop repo; this app
  never forks or redeclares these types (see `.claude/rules/protocol-types-from-package.md`).
- **`kangentic-relay`** (separate, open-source repo): a stateless, self-hostable blind
  byte-forwarder. It authenticates nothing and reads nothing beyond ciphertext framing.
- **`kangentic-mobile`** (this repo): the Expo/React Native client.

The pairing, transport, and capability layer is **accountless** by design: it works identically
self-hosted or on a Kangentic-hosted relay, and a Kangentic account is only ever relevant to
using the hosted relay past a free cap. See `.claude/rules/accountless-core.md`.

## Pairing

The desktop displays a QR code; the phone scans it. The desktop is the trust root. The QR
carries, and nothing more:

1. The desktop's static X25519 public key.
2. A short-lived (~10 minute), single-use, high-entropy (>=128-bit) pairing token.
3. The relay address.
4. The protocol version.

It never carries a long-lived secret. The token is mixed into the Noise handshake as a
**pre-shared key (PSK)**; see `docs/security.md` for why this is deliberately not a PAKE. After
the handshake, both sides derive a **Short Authentication String (SAS)** from the transcript
hash and display it on both screens; the user confirms the two match before the pairing
completes. On success, the desktop signs the phone's public key into a device roster with a
per-device capability set. The roster, not the relay, is the source of truth for who is paired.

## Secure channel

Every session runs a **Noise KK** handshake (`Noise_KK_25519_ChaChaPoly_BLAKE2s`): both static
keys are pre-messages from pairing, so there is no trust-on-first-use and neither identity ever
travels on the wire in the clear. The desktop always initiates the handshake and owns the ~2
minute rekey timer; the phone is the responder, reacting identically to the very first handshake
and to every later peer-initiated rekey.

- Version negotiation is bound into the Noise prologue; a differing prologue fails the handshake
  outright, closing downgrade attacks.
- No state-changing command may ride the first Noise message (it is replayable pre-ephemeral).
- Sessions rekey roughly every 2 minutes (WireGuard's `REKEY_AFTER_TIME`) for bounded
  post-compromise security.
- Per-direction 64-bit counter nonces reject anything at or below the last seen value.
- Crypto library: `@kangentic/protocol` is pure TypeScript on `@noble/curves`/`@noble/hashes`/
  `@noble/ciphers` - no native crypto module. The exact same handshake and `secretstream`-style
  AEAD framing code runs on Node (the desktop) and on Hermes (this app), tested once against
  official Noise test vectors. The app adds only `react-native-get-random-values` (Hermes has no
  built-in `crypto.getRandomValues`, which the protocol's key generation needs) and
  `@bacons/text-decoder` (Hermes has `TextEncoder` but not `TextDecoder`).

## Capability allowlist

The encrypted channel proves *which* device is connected; a separate, desktop-enforced layer
decides *what* it may do:

| Verb | Purpose |
|------|---------|
| `read-stream` | Read live transcript/terminal output |
| `read-board` | Read board and task state |
| `read-diff` | Read git diffs for a task |
| `send-user-message` | Send a message into an agent session |
| `move-task` | Move a task between board columns |
| `answer-permission-prompt` | Respond to an outstanding agent permission prompt |

**There is no shell, file-read, or arbitrary-command verb in the protocol.** It is absent, not
filtered. `answer-permission-prompt` is the most sensitive verb: the phone renders exactly what
is being approved, and the desktop enforces that the response binds to a specific outstanding
prompt id.

## App structure

```
app/              # expo-router route wrappers (thin - render the src/screens/ implementation)
src/
  screens/        # TriageHome, Board, Pairing (Scan/Confirm), Settings, Devices; TaskDetail is later phase
  components/      # Design system + transcript-terminal cells, tool cards, diff viewer
  pairing/         # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/         # Relay WebSocket transport, KK session manager (responder), slot derivation, capability client
  notifications/   # Push registration, E2E blob decrypt, category prefs, presence suppression - later phase
  state/           # Zustand stores
  lib/             # Shared pure utilities (crypto polyfills)
```

Route files under `app/` are thin wrappers that render the matching `src/screens/` implementation
(e.g. `app/pair.tsx` renders `PairingScanScreen`); this keeps the documented `src/` layout as the
place screen logic actually lives while still getting expo-router's file-based routing. In Phase 1
the pairing on-ramp is the in-app camera scan (or the paste-link fallback) inside
`PairingScanScreen`; OS-level deep-link routing of a `kangentic-pair://` URI is not wired yet.
The pairing payload is a base64url blob in the URI authority (not a `/pair` path), so routing it
needs a dedicated `expo-linking` handler that feeds the captured URL through the same
`validateScannedQr` then `beginPairing` path; that lands in a later phase.

Navigation: an activity-triage home (Needs you / Working / Idle) plus a swipeable Board tab.
Opening a task is full-screen with a bottom tab bar (Conversation-terminal / Terminal / Changes)
and a composer pinned at the bottom - this is App Phase 2 scope; Phase 1 ships the triage home and
Board tab on mock data only.

## Rendering

The primary session view renders the **transcript styled as a terminal**: it reflows to phone
width (the desktop terminal is never resized to accommodate the phone), streams the in-progress
turn token-by-token, and renders `AskUserQuestion`/permission prompts as tappable cards. It is
built on FlashList for feed performance (see `.claude/rules/ui-conventions.md`). The raw
interactive terminal grid (a faithful mirror with pinch-zoom and a quick-key bar) is a secondary
view for nested full-screen programs.

## Notification pipeline

1. The desktop POSTs directly to Expo's push API (no maintainer server in the data path). FCM
   and APNs credentials live only in the maintainer's EAS account.
2. The phone's `ExponentPushToken` is exchanged over the paired E2E channel and treated as a
   per-device bearer secret.
3. The payload is ciphertext plus a generic placeholder (see `.claude/rules/e2e-notification-privacy.md`).
   On iOS, a Notification Service Extension (added via an Expo config plugin, no eject) decrypts
   and rewrites the notification on-device. On Android, a high-priority data-only FCM message is
   decrypted by a Notifee background handler, which posts the rich local notification.
4. Presence suppression: when the app is foregrounded with the channel up, the desktop notifies
   over the socket and skips the push.

## Later phases (future, not built yet)

- **WebRTC data channel upgrade**: direct P2P for the majority of network pairs, with signaling
  over the already-secure channel and DTLS fingerprints pinned at pairing time. The relay
  remains the permanent fallback.
- **Tailscale "bring your own network"** detection for users who already run a tailnet.
- **Android foreground-service local mode**: an opt-in mode that holds a socket open in the
  background (iOS cannot do this; see `docs/security.md`'s notification discussion).

## See Also

- [docs/security.md](security.md) - threat model, the pairing ceremony's crypto detail, key
  storage.
- [docs/developer-guide.md](developer-guide.md) - setup, build system, testing tiers.
