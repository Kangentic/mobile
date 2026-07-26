# Pre-live hardening: what was verified, and what was not

Board task #14, branch `pre-live-hardening-t-bfaf877d`. This is the on-device baseline the task's
definition of done asks for: what is proven, what is reasoned, and what is still open. It is
deliberately explicit about the difference.

## Verified on real hardware

**Pixel 10 Pro, paired to the real desktop through the real QR + SAS ceremony**, over a local
relay at `ws://127.0.0.1:8080` via USB `adb reverse`.

- **The 0.9.0 board projection, end to end.** Across 15 projects the board holds 5 tasks - 3 + 1
  + 1 and zero elsewhere - exactly matching the 5 live sessions. Under the previous full
  projection that was 34 tasks. Measured payload: 15 projects **63 kB -> 12 kB** compressed, and
  the busiest project's per-board-change **17.7 kB -> 4.6 kB**.
- **The feed stays live with no terminal open.** All 5 sessions `feedStatus: "live"`, three
  thinking, unread counts climbing, on list-only subscriptions. This is the real-desktop
  counterpart to a `mockDesktop` bug fixed in this branch, where the same condition froze the
  entire simulated agent.
- **Terminal rendering on real hardware**, including the wide-park (308-col) case that broke the
  emulator: Pixel WebView `MAX_TEXTURE_SIZE` is 8192 against the emulator's 4096, the font cap
  provably engages, WebGL is active, and a full keystroke round-trip (up-arrow -> PTY ->
  `History 2/2` recalled -> redraw) works against a real TUI.
- **Native sheets, tabs and the rebuilt surface switcher**, exercised by hand during the
  migration.

**Android emulator, e2e release build, paired to the stub peer**

- **The paired Maestro suite: 11/11 in 8m 37s**, against a release-shaped e2e APK, not a dev
  client. `approve-permission`, `board-create-task`, `board-delete-task`, `board-edit-task`,
  `board-move`, `chat-fallback-reading-view`, `home-needs-you-approve`, `open-task-from-triage`,
  `session-ended-state`, `session-mode-toggle`, `session-respawn-recovery`. Two of these are
  load-bearing for this branch: **`session-ended-state`** is the regression that opened the task,
  now proven on a device for the first time, and **`session-mode-toggle`** covers the rebuilt
  surface switcher.
- **The pairing ceremony against a release-shaped binary** - paste link, submit, SAS accept, and
  the stub's session row landing on the Agents feed.

## Verified by test only, not on a device

- Everything under `tests/unit` (437) and `tests/components` (252).
- **One coverage boundary worth naming:** RNTL never fires `onLayout`. The session switcher's
  indicator reads its geometry from `onLayout`, so its mount behaviour is invisible to the
  component tier - a real bug there (the indicator sliding in from the wrong segment) was found
  by review, not by tests, and cannot be caught by them.

## NOT verified, and why

- **iOS: nothing.** This app has never been compiled for iOS. There is no Mac, and an iOS build
  is a cloud build the maintainer declined on cost grounds. Every iOS statement in this branch is
  reasoning, not evidence. Component choice does not substitute: React Native primitives already
  render native iOS views, so the open risks are elsewhere. The largest is the terminal, which is
  a `WKWebView` running xterm.js with WebGL and entirely untested there. Notifications are
  Android-only by design (`src/notifications/index.ts` returns early off Android; the iOS
  Notification Service Extension is a later phase).
- **`expo-router/unstable-native-tabs`** carries a vendor warning that its API may change in a
  minor version. Adopted deliberately for iOS native feel.
- **Remote push** end to end, which needs FCM credentials and a real push round trip.

## Fixed in this branch, worth knowing about

**Security.** `isSecureRelayAddress` accepted `ws://127.0.0.1:8080@evil.test`. Everything before
an `@` in a URL authority is userinfo, so that address dials **evil.test** - and the pairing
token IS the Noise PSK, dialed verbatim as the relay slot. One crafted QR field put it on the
wire in cleartext to an attacker-chosen host, and `activePairing` then persisted that host to the
trust anchor for every later session. The loopback list was not behind the dev gate, so this
applied to production builds. Now parses the authority rather than prefix-matching. **The same
flaw exists in the published `@kangentic/protocol` and still needs fixing upstream.**

**Correctness.** A stale `read-board` response could revert an upgraded board to the filtered
projection (no post-await staleness guard, unlike `subscribeDiff`). `applySnapshot` could
resurrect a session already reported `ended`. The session screen lost its ended state entirely
once the 0.9.0 projection dropped the task from the board - the bug that opened this task.

**Platform.** `keyboardShouldPersistTaps` was missing on four scrollables, so the first tap on a
control was spent dismissing the keyboard - including **Approve/Deny on permission prompts**, the
single worst control in the app to need two taps.

## Deferred, with reasons

- **Native stack headers** (the last item of the native-migration pass). Evaluated, not done.
  The tab roots' header carries the brandmark and is deliberately merged with the board's column
  chips into one surface, which a native header cannot do; and the session header hosts live
  agent status. Defensible either way, and it needs on-device iOS judgement that is not
  available. Not a silent skip - a decision.
- **Left/right arrows in the terminal quick keys**, dropped for touch size (eight shares left
  40dp per key on a 360dp phone, under the 44pt minimum) and because they edit inside an input
  line, which is keyboard-up work anyway.
- **A sticky `Ctrl` modifier** (the Blink/Termius pattern). It would need the keyboard raised to
  press the letter, which is the wrong cost for an interrupt. `Ctrl+C` stays hardcoded, matching
  how TeamViewer treats Ctrl+Alt+Del.
- **`.maestro/paired/home-needs-you-approve.yaml` selects on copy text** (`"Approve:.*"`) rather
  than a testID. The Home row has no structural prompt-pending signal by design - uniform inbox
  styling is the product decision - so honouring the rule means adding a marker to production
  render purely for a test.

## Cross-repo work shipped

Desktop PR #205 merged and `@kangentic/protocol` **0.9.0** published: `read-board` takes
`view: 'full' | 'sessions'`, returns `taskCountsByColumnId`, and `backlog` became optional.

Two bugs handed to the desktop board: **#431** (Mobile Devices "Pair a device" no-ops after the
QR dialog is closed once) and **#432** (pairing UX and capability model).

## Tooling unblocked

**Local Android builds now work**, which they did not for most of this task. Any build from
`.kangentic/worktrees/<branch>/` dies on CMake's 250-character object-path cap inside
`node_modules/<pkg>/android/.cxx/` - at every variant, and a directory junction does not help
because Node realpaths `node_modules`. A git worktree whose REAL path is short does:
`git worktree add --detach C:\kw HEAD`. Full recipe, including the ABI flag the emulator needs,
is in `docs/developer-guide.md`.

This is what made the e2e APK - and therefore this document's Maestro results - possible at all.
Board task #5 (build execution on GitHub Actions) is still worth doing for CI, but is no longer
the only path.
