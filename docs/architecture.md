# Architecture

Kangentic Mobile is a companion app that remote-controls agent sessions running in the desktop
[Kangentic](https://github.com/Kangentic/kangentic) app. This document describes the
architecture as of App Phase 2 (the core remote-control experience); see `CLAUDE.md`'s Project
Structure for the current layout. The durable research behind these decisions lives in the desktop repo's
[`docs/research/mobile-companion-app.md`](https://github.com/Kangentic/kangentic/blob/main/docs/research/mobile-companion-app.md);
this document is the implementation-facing summary and is authoritative where the two disagree
(notably the pairing ceremony, see below).

## Overview

```
  Desktop (Kangentic)                            Phone (Kangentic Mobile)
  mobile-bridge module                           Expo / React Native app
  - device identity + roster    QR pairing       - device identity (Keychain/
  - capability router          <=============>     Keystore)
  - session/board/diff feeds    (token-PSK + SAS) - board + conversation UI
        |                                                |
        |  outbound WSS                    outbound WSS  |
        +-----------> [ blind relay ] <------------------+
        |             (ciphertext only,                  |
        |              self-hostable: relay)              |
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
- **`relay`** (separate, open-source repo): a stateless, self-hostable blind
  byte-forwarder. It authenticates nothing and reads nothing beyond ciphertext framing.
- **`mobile`** (this repo): the Expo/React Native client.

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
- A **deliberate** teardown (unpairing) seals an empty `FrameTag.Final` frame before the socket
  closes, so the desktop marks the phone offline immediately instead of waiting out reconnect
  grace plus its presence probes. Backgrounding and reconnects stay silent on purpose - the phone
  intends to return - and an involuntary teardown (killed app, dead network) cannot announce
  anything at all.
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
| `read-stream` | Subscribe one session's live feeds: raw PTY tail, activity/usage/permission telemetry, and chunked transcript deltas; its `transcript-window` action serves byte-budgeted history pages (the subscribe response carries the scrollback snapshot and the outstanding `awaitedPromptId`). `transcript-window` alone needs no LIVE session (protocol 0.10.0): it reads session records plus their on-disk JSONL, which is what lets a completed task's conversation be read after its agent is gone. Every other action still requires one. |
| `read-board` | Project list (no `projectId`, carrying the desktop's project groups since 0.11.0), a board snapshot + live board-change subscription, or - via the `archived` action (0.10.0) - a one-shot page of COMPLETED tasks with each one's lifetime session summary. Archived tasks are deliberately not in the snapshot: a board subscription re-snapshots on every change, and the archive only grows. |
| `read-diff` | A task's diff file list (+ a live change-signal watch) or one file's old/new content |
| `send-user-message` | Send a composed message into an agent session (bracketed paste desktop-side) |
| `move-task` | Move a task between board columns |
| `answer-permission-prompt` | Respond to an outstanding agent permission prompt |
| `interactive-terminal` | Raw keystroke write to the session PTY (full terminal parity) |
| `board-tool-read` | The allowlisted read half of the desktop's task/backlog command registry (search, stats, transcripts, ...) |
| `board-tool-write` | The allowlisted mutate half (create/update/delete task, backlog CRUD, link PR, ...) |
| `register-push` | Register/unregister this device's Expo push token plus its 32-byte notification-decrypt key with the desktop's push notifier (in the DEFAULT pairing grant: it only lets the desktop send the device ciphertext) |

**There is no shell, file-read, or arbitrary-command verb in the protocol.** It is absent, not
filtered. `answer-permission-prompt` is the most sensitive verb: the phone renders exactly what
is being approved, and the desktop enforces that the response binds to a specific outstanding
prompt id (`${sessionId}:${toolUseId}`, also covering `AskUserQuestion`/`ExitPlanMode` pauses,
which ride the same permission machinery). `interactive-terminal` and `board-tool-write` are
explicit-grant-only; the default pairing grant is read-only. The `board-tool-*` surface is NOT
MCP: the `tool` name is the desktop's internal command-registry key, dispatched as a direct
function call against a hand-classified allowlist (raw-SQL and code-execution tools are
excluded desktop-side, and the protocol package's `BOARD_TOOL_READ_NAMES`/
`BOARD_TOOL_WRITE_NAMES` tuples keep both sides in lockstep).

## App structure

```
app/              # expo-router route wrappers (thin - render the src/screens/ implementation)
  task/[taskId]/  # index = the Session view (terminal/chat lenses); changes = the diff
                  #   destination; file-diff.tsx hosts the per-file diff on the stack
src/
  screens/        # TriageHome (+ home/ needs-you cards), Board, task/ (SessionScreen + lenses),
                  #   FileDiff, Pairing (Scan/Confirm), Settings, Devices
  components/      # Design system + conversation/ cells and prompt cards, terminal/ pane +
                  #   quick keys, board/ sheets, composer/, diff/ line cells
  pairing/         # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/         # Relay WebSocket transport, KK session manager (responder), slot derivation,
                  #   capability client, typed verb client, feed router, subscription manager
  connection/      # The lifecycle composer: AppState-driven connect/dispose, bootstrap,
                  #   store feed glue, the actions API screens call
  conversation/    # Pure transcript-cell flattener, prompt keystrokes, pending-prompt summary
  terminal/        # Pure liveTail PTY cleaner, key sequences, WebView bridge protocol,
                  #   the generated self-contained xterm.html asset
  diff/            # Pure unified-diff line computation (jsdiff) + path display helpers
  notifications/   # Push registration, E2E blob decrypt, notifee channels, local notifier,
                  #   foreground service, background push task, tap routing (Android; iOS NSE later)
  state/           # Zustand stores (activity/board/transcript/diff/channel/settings) +
                  #   the non-Zustand terminalFeed PTY ring buffers
  voice/           # Dictation hook over the OS speech engines
  observability/   # Sentry crash reporting: the ONLY module allowed to import the SDK, plus
                  #   the pure event/breadcrumb scrubber (lint-enforced, crash-reporting-scope.md)
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

Navigation: an activity-triage home (Needs you / Working / Idle) plus a swipeable Board tab,
both live off the channel feeds. Opening a task is full-screen with a bottom tab bar
(Conversation-terminal / Terminal / Changes) and the active tab's input pinned at the bottom
(the composer on Conversation, the quick-key bar + terminal input row on Terminal). All three
tab pages stay mounted on a non-swipe pager so the terminal WebView never reloads and the
conversation keeps scroll position; tab switching is tap-only.

The connection lifecycle (`src/connection/connectionManager.ts`) connects while the app is
foregrounded and paired, and disposes on background: iOS suspends sockets within seconds
anyway, and remote E2E push covers the away-from-app case. The one exception is Android with
`backgroundNotificationsMode: 'foreground-service'` (the default): with an established
connection, backgrounding keeps the channel alive under a notifee foreground service and starts
the local notifier instead of disposing. Reconnects re-subscribe and
re-snapshot everything (the wire has no cursors by design); the triage home follows board
snapshots - every task with a non-null `session_id` gets a `read-stream` subscription, and
terminal bytes for sessions not open on screen are dropped at the phone's buffer boundary.

## Rendering

The primary session view renders the **transcript styled as a terminal**: it reflows to phone
width (a client-side re-layout of the parsed transcript text, independent of the PTY grid),
streams the in-progress turn token-by-token, and renders `AskUserQuestion`/permission prompts as
tappable cards. It is
built on FlashList v2 block cells (see `.claude/rules/ui-conventions.md`): the phone holds a
contiguous transcript WINDOW, never the whole conversation - the newest page loads on screen
open via the `transcript-window` action, older pages load on scroll-up, and settled content
streams in as indexed delta upserts (protocol v2: changed/new entries only, chunked under a
byte budget and deflate-compressed on the wire, merged identity-preservingly so unchanged rows
never re-render). The live in-progress turn is a cleaned tail of the raw PTY stream
(`src/terminal/liveTail.ts` interprets only line-identity control bytes, filters spinner/frame
chrome, and resets on full-screen redraws), shown while the session is thinking and replaced
when settled entries land at the window's end. Markdown renders through the `MarkdownBlock`
adapter (react-native-enriched-markdown, swappable in one file).

The raw interactive terminal is the full-fidelity view: xterm.js bundled offline in a WebView
(`src/terminal/xterm.html`, generated by `scripts/buildXtermHtml.mjs`, CSP-locked to
inline-only), fed the scrollback snapshot plus live PTY chunks over a small postMessage bridge
(`src/terminal/terminalBridge.ts`). The desktop reports its PTY grid (`ptyDimensions` on the
snapshot, `terminal-resize` events on change), so the phone renders at the exact grid the bytes
were laid out for instead of inferring a width. It is a **faithful read-only mirror**: it renders
that grid 1:1 with horizontal pan, follow-the-cursor and pinch-zoom, and sizes the font so the
grid's ROWS fill the phone's height (a wider-than-screen grid then overflows and pans). It
**never resizes the desktop PTY** - a shared session must not be reshaped by the phone, so the
only thing sent upstream is typed input. The protocol carries `resize` and `release-size` actions
on the `interactive-terminal` verb, but they exist for the desktop: `src/channel/verbClient.ts`
exposes `write` alone, and nothing in `src/` sends the other two. A pre-0.4.0 desktop that reports
no grid falls back to inferring the column count from the scrollback. Arrow keys track the
terminal's DECCKM mode (CSI vs SS3); the quick-key bar (Esc / Tab / arrows / Enter / Ctrl-C /
slash) plus a text input row write through `interactive-terminal`.

## Composer and voice dictation

The conversation composer sends through `send-user-message` (the desktop injects it as a
bracketed paste, exactly like its own Send box). Dictation uses the OS speech engines via
`expo-speech-recognition` (iOS `SFSpeechRecognizer`, Android `SpeechRecognizer` - free, no
per-message cost), isolated in `src/voice/useDictation.ts`. Partial results stream into the
composer; on a final result the default mode **auto-sends**, configurable in Settings to
review-before-sending or off (`src/state/settingsStore.ts`, key `settings.dictationMode`).

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

Phone side (`src/notifications/`; DISPLAY is Android-only in this phase, while registration is
deliberately platform-agnostic - an iOS device registers its key/token ahead of the NSE shipping,
and its pushes safely degrade to the generic placeholder until then): the 32-byte push key is
generated on-device and exchanged via the `register-push` verb on every established bootstrap,
alongside the device's enabled `categories` (`pushRegistration.ts` - idempotent, re-sent on Expo
token rotation or a category-preference change, and non-fatal without FCM credentials or against
an older desktop; `getPushRegistrationStatus()` feeds the Settings UI). Preferences are enforced
**desktop-side**: the desktop filters outgoing notifications to the device's registered set
before sealing, so a future iOS Notification Service Extension never needs to know about them.
`pushDecrypt.ts` opens envelopes with the phone's static public key as the AAD and maps the five
categories (`categoryCopy.ts` - `input-required` / `turn-complete` / `session-failed` /
`plan-complete` / `spawn-stalled`, named for cross-vendor task-lifecycle vocabulary rather than
any one agent's terms) onto four notifee channels (needs-attention / completions / failures /
stalls); any failure degrades to the generic placeholder.

| Category | Placeholder title (`titleForCategory`) |
|----------|------------------------------------------|
| `input-required` | "Agent needs your input" |
| `turn-complete` | "Turn complete" |
| `session-failed` | "Session stopped" |
| `plan-complete` | "Plan complete" |
| `spawn-stalled` | "Still preparing" |

Killed-app data messages run through a
headless expo-notifications background task (`backgroundPushTask.ts`, registered from `index.js`
outside React). While backgrounded in foreground-service mode, `localNotifier.ts` turns
activity-store transitions into the same notifications locally (three of the five categories have
an activity-store signal to fire from; 30s per-session-per-category cooldown, suppressed while
foregrounded, and gated by the same per-category Settings toggle as remote push), and
`foregroundService.ts` owns the ongoing LOW-importance connection notification. Taps route to the
task screen via `tapRouter.ts`. Unpairing sends `register-push` with `action: 'unregister'` while
the channel is still up and wipes the local push key (`pushKeys.clearPushRegistration()`), so the
previously paired desktop can no longer push anything this phone can decrypt - delivery through
Expo/FCM still reaches the OS-level token, but every attempt now degrades to the generic
placeholder, on the same failure path as a tampered or wrong-key blob.

## Later phases (future, not built yet)

- **WebRTC data channel upgrade**: direct P2P for the majority of network pairs, with signaling
  over the already-secure channel and DTLS fingerprints pinned at pairing time. The relay
  remains the permanent fallback.
- **Tailscale "bring your own network"** detection for users who already run a tailnet.
- **iOS Notification Service Extension**: the on-device decrypt path for APNs pushes (the
  Android half of the pipeline above is built; iOS cannot hold a background socket, so it
  relies entirely on remote push).

## See Also

- [docs/security.md](security.md) - threat model, the pairing ceremony's crypto detail, key
  storage.
- [docs/developer-guide.md](developer-guide.md) - setup, build system, testing tiers.
