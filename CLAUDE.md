# Kangentic Mobile

Mobile companion app that remote-controls agent sessions running in the desktop Kangentic app.

## Tech Stack

- **Framework:** Expo SDK 55+, React Native New Architecture, TypeScript strict mode
- **State:** Zustand
- **Lists:** FlashList (transcript feed, board, chat-style streaming)
- **Crypto:** `@kangentic/protocol` (pure TypeScript on `@noble/curves`/`@noble/hashes`/`@noble/ciphers` -
  no native crypto module; the same handshake code runs on Node and Hermes), plus
  `react-native-get-random-values` (CSPRNG polyfill) and `@bacons/text-decoder` (Hermes has no
  built-in `TextDecoder`)
- **Storage:** expo-secure-store (Keychain / Android Keystore)
- **Notifications:** Expo Push, Notifee (Android), a native iOS Notification Service Extension via config plugin
- **Build:** EAS Build/Submit/Workflows (cloud, including all iOS builds), Continuous Native Generation (no checked-in native projects)
- **Testing:** vitest (unit), Jest + React Native Testing Library (components), Maestro (E2E, Windows + Android emulator locally, EAS Workflows cloud iOS simulators), Playwright via react-native-web (later)

## Project Structure

**App Phase 2 (core experience).** `app/` holds thin expo-router route wrappers; the actual
screen implementations and everything else live under `src/`. If the layout changes, update
this tree and the rule `paths:` globs together.

```
app.config.ts                 # Expo config; CNG - config plugins only, no checked-in native projects
eas.json                      # EAS Build/Submit/Workflows profiles (development/preview/production)
app/                           # expo-router route wrappers (thin - render the src/screens/ implementation)
  _layout.tsx, (tabs)/         # root Stack + bottom Tabs (Home, Board); boots connection + notifications + splash
  task/[taskId]/               # index.tsx = the SESSION view (terminal/chat lenses); changes.tsx = the diff destination
  file-diff.tsx                 # per-file unified diff, pushed over the changes screen
  pair.tsx, pair-confirm.tsx    # pairing flow routes; pair.tsx renders the scan/paste screen (OS deep-link routing of kangentic-pair:// is a later phase)
  settings.tsx, devices.tsx
assets/brand/                 # Synced identity rasters (icon/splash/adaptive) - scripts/syncBranding.mjs owns them
plugins/                      # Local Expo config plugins (withAndroidPushService: notification permissions + FGS type)
targets/nse/                  # iOS Notification Service Extension source, injected via plugin - later phase
src/
  screens/        # TriageHome (+ home/ needs-you cards), Board, task/ (SessionScreen, mode toggle,
                  #   input bar, ChatPane, ChangesScreen), FileDiff, Pairing (Scan/Confirm), Settings, Devices
  components/     # Design system primitives + brand/ (Overseer, Brandmark, EmptyState), motion/
                  #   (presets, Skeleton, PressScale), conversation/ cells and prompt cards, terminal/
                  #   xterm pane + quick keys, board/ sheets (actions/move/create/edit), composer/, diff/ cells
  brand/          # Generated brand data (brandmark XML, Overseer frames) - syncBranding.mjs owns them
  pairing/        # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/        # Relay WebSocket transport, KK session manager (responder), slot derivation,
                  #   capability client, typed verb client, feed router, subscription manager
  connection/     # Lifecycle composer: AppState connect/background policy, bootstrap, store feed glue,
                  #   the actions API screens call (accountless-core scoped), dev-only
                  #   mockDesktop peer (EXPO_PUBLIC_KANGENTIC_MOCK)
  conversation/   # Pure transcript-cell flattener, prompt keystrokes, pending-prompt summary
  devsupport/     # Loopback transport, protocol-faithful stub peer classes, wire fixtures, and the
                  #   dev-only inspect bridge (EXPO_PUBLIC_KANGENTIC_INSPECT) - shared by tests + rigs
  terminal/       # Pure liveTail PTY cleaner, clean-feed differ, key sequences, WebView bridge,
                  #   generated xterm.html
  diff/           # Pure unified-diff lines (jsdiff) + path display
  notifications/  # Push key + registration, E2E envelope decrypt, notifee channels, background task,
                  #   local notifier, foreground service, tap routing (Android display; iOS NSE later)
  state/          # Zustand stores (activity/board/transcript/diff/channel/settings/readingView, all
                  #   channel-fed, in-memory) + the non-Zustand terminalFeed PTY ring buffers
  voice/          # Dictation hook over the OS speech engines (expo-speech-recognition)
  lib/            # Shared pure utilities (crypto polyfills, haptics)
tests/
  unit/           # vitest (pure TS, no RN runtime) - includes the loopback-transport + stub-desktop-peer helpers
  components/     # Jest + React Native Testing Library
  web/            # Playwright via react-native-web (later)
.maestro/         # Maestro E2E flows (smoke unpaired; paired/ flows need scripts/stubDesktopPeer.mjs)
scripts/          # bash-guard.js, dev.mjs, stubDesktopPeer.mjs, buildXtermHtml.mjs,
                  #   mobileInspect.mjs, syncBranding.mjs, easProfile.mjs (CI reads eas.json
                  #   profiles through it), checkPlayVersionCode.mjs + repo scripts
```

## Commands

- `npm install` - Install dependencies
- `npx expo start --dev-client` (`npm start`) - Start the dev server against a dev-client build
- `npm run dev:mock` / `dev:live` / `dev:pair` / `dev:stub` / `dev:doctor` - The local dev rig
  (`scripts/dev.mjs`): emulator + adb reverse + relay + Metro in one command, in mock
  (in-app fake desktop), live (real desktop dev instance), pair (pairing-ceremony testing),
  or stub (Maestro E2E rig) mode; doctor is a read-only preflight. See
  [docs/developer-guide.md](docs/developer-guide.md)'s Local Dev Rig section.
- `npx expo run:android` (`npm run android`) - Build, install, and launch the dev client on the
  Android emulator (rebuilds native code; use this after a native dependency or config plugin
  change, or the first time on a fresh emulator)
- `gh workflow run build-android.yml -f profile=<development|preview|e2e|production>` - **The
  normal way to build.** Runs `expo prebuild` + Gradle on a free GitHub runner, spends no EAS
  cloud credit, and uploads the APK/AAB as a run artifact. Add `-f submit_track=internal` to queue
  a Play upload (gated behind an approval). See the CI builds section of
  [docs/developer-guide.md](docs/developer-guide.md).
- `gh workflow run build-ios.yml` - Unsigned iOS simulator compile check on a free macOS runner.
  No Apple Developer account or signing needed.
- The `eas build` wrappers below are **cloud** builds that each spend one of the 15 free monthly
  Android builds. Prefer the workflow; use these only when a runner will not do:
  - `eas build --profile development --platform android` (`npm run build:dev`) - dev-client build
  - `eas build --profile preview --platform android` (`npm run build:preview`) - internal
    distribution build
  - `eas build --profile production --platform android` (`npm run build:prod`) - store-release build
  - `eas build --profile production --platform ios` - App Store build (cloud, no Mac needed)
- `npm run typecheck` - `tsc --noEmit`
- `npm run lint` - `eslint . --max-warnings 0`
- `npm run test:unit` - Unit tests (`vitest run tests/unit`)
- `npm run test:components` - Component tests (`jest tests/components`)
- `maestro test .maestro/` - E2E flows against the Android emulator
- `eas update` - Push a JS-only OTA update

## Cloud-spend and public-write MCP tools

Four MCP servers are wired in: `context7`, `maestro`, and `firebase` from `.mcp.json`, plus the
official Expo plugin from `enabledPlugins` in `.claude/settings.json`. `context7` is
documentation-only and unguarded; the Expo plugin, `maestro`, and `firebase` expose tools with
consequences outside this machine, gated by `permissions.ask` in `.claude/settings.json` (a prompt
on every call in every normal permission mode; a bypass mode skips it, so this section, not the
prompt, is the real guard) - never call these without an explicit user request, and re-check this
list against `/mcp` when any server is upgraded.

- **Never without an explicit request - spends money or quota:** `build_run`, `build_submit`,
  `workflow_run` (Expo MCP), `run_on_cloud` (Maestro MCP). `build_run` spends one of the Expo
  Free allowance of 15 iOS + 15 Android **cloud** builds per month, and it is no longer how this
  project builds: `.github/workflows/build-android.yml` runs `expo prebuild` plus Gradle on a
  free GitHub runner, so a normal build costs no EAS credit at all. Reach for the workflow, not
  `build_run`. EAS is still the path for a manual `eas submit`, so `build_submit` is "explicit
  request only" rather than "never our path". Note the Expo MCP authenticates as the individual
  developer's **personal** Expo account via `/mcp` OAuth, and CI holds no Expo credential
  whatsoever, so anything the MCP fires is both off-path and attributed to a personal identity
  (see the auth table in [docs/developer-guide.md](docs/developer-guide.md)'s Agent tooling
  section).
- **Never without an explicit request, higher bar - posts publicly and is effectively
  irreversible:** `appstore_reply_review`, `appstore_delete_review_response`,
  `playstore_reply_review` (Expo MCP). These write to real App Store and Play Store listings
  under the company identity. Confirm the exact text with the user before posting, every time.
- **Never without an explicit request, higher bar - reaches real devices:**
  `messaging_send_message` (Firebase MCP). This delivers an FCM push to real installs. It also
  cannot satisfy `.claude/rules/e2e-notification-privacy.md`, which requires every payload to be
  ciphertext plus a generic placeholder: a console-style FCM send is plaintext by construction.
  Use it only to debug delivery mechanics with the user's explicit say-so, never as a way to
  send app content.
- **Never without an explicit request - creates or mutates cloud resources:**
  `firebase_create_project`, `firebase_create_app`, `firebase_create_android_sha`,
  `firebase_deploy`, `firebase_init`, `firebase_update_environment` (Firebase MCP). The Firebase
  MCP is scoped to `--only core,messaging` in `.mcp.json` because this app uses Firebase solely
  for FCM. Widen that list only when a feature is actually adopted. Note `firebase_init` writes
  a `firebase.json` into the repo, which this project deliberately does not have.

## Architecture

Full detail lives in [docs/architecture.md](docs/architecture.md) and
[docs/security.md](docs/security.md); this is the always-visible summary.

- **Pairing:** the desktop displays a QR (its static public key, a short-lived single-use
  high-entropy token, a relay address, a protocol version), the phone scans it. The token is
  mixed into the Noise handshake as a **pre-shared key**, not used in a PAKE - this is a
  deliberate deviation from the original research doc's SPAKE2 recommendation; see
  `docs/security.md` for why a high-entropy scanned token makes a PAKE unnecessary. After the
  handshake, both sides confirm a transcript-derived SAS (Short Authentication String) before
  the pairing completes.
- **Secure channel:** every session runs a fresh Noise KK handshake
  (`Noise_KK_25519_ChaChaPoly_BLAKE2s`) over a blind, self-hostable relay
  (`relay`, a separate repo) that forwards ciphertext only. The desktop always
  initiates the KK handshake and owns the ~2 minute rekey timer; the phone is the responder.
  Version negotiation is bound into the prologue to close downgrade attacks.
- **Capability allowlist:** the channel proves which device is connected; a desktop-enforced
  allowlist decides what it may do. Ten verbs (`read-stream`, `read-board`, `read-diff`,
  `send-user-message`, `move-task`, `answer-permission-prompt`, `interactive-terminal`,
  `board-tool-read`, `board-tool-write`, `register-push`); the default pairing grant is the
  read-only four plus `register-push` (which only lets the desktop send the device encrypted
  notifications), and every write/control verb needs an explicit per-verb grant on the desktop.
  **There is no shell, file, or arbitrary-command verb in the protocol - absent, not filtered.**
- **Session view (two lenses):** a task's screen is one SESSION with a terminal/chat mode pill
  in the input bar - Terminal (the raw mirror, the default) and Chat (the readable feed) - plus
  a separate pushed Changes destination. Chat renders the structured transcript when the agent
  has one, and degrades agent-agnostically to a cleaned live reading view derived from the
  terminal (a headless xterm in the WebView) when it does not.
- **Transcript-terminal rendering:** the chat lens renders the transcript styled as a
  terminal, reflowed to phone width, with `AskUserQuestion`/permission prompts as tappable
  cards; the in-progress turn streams token-by-token as a cleaned tail of the raw PTY feed
  (`src/terminal/liveTail.ts`), replaced when the next transcript revision lands. The raw
  interactive terminal (xterm.js in a WebView, quick-key bar, `interactive-terminal` writes)
  renders at the desktop's reported PTY grid; its default Mobile view resizes that PTY to the
  phone via the `interactive-terminal` grant (restored on tab close / disconnect / revoke), and
  its Desktop view mirrors the grid 1:1 with pan and zoom.
- **E2E push:** payloads are ciphertext plus a generic placeholder only; decryption happens
  on-device (iOS Notification Service Extension / Android Notifee). Every failure degrades to
  the placeholder, never to plaintext.
- **Accountless core:** pairing, transport, and capability code never depend on any Kangentic
  account or entitlement layer. The open-core split (this app is open source and self-hostable;
  a Kangentic-operated hosted relay is the paid product) depends on this separation holding.
- **CNG:** native config flows through `app.config.ts` and Expo config plugins under `plugins/`.
  `ios/` and `android/` are gitignored prebuild artifacts, never hand-edited or committed.

## Testing

Four tiers, chosen for the fastest tier that proves the behavior. Full detail:
[docs/developer-guide.md](docs/developer-guide.md).

**Always fine:**
- `npm run typecheck` - run freely at any point.
- Running tests you just added or modified, scoped to those files.

**Never run unless the user explicitly asks, or `/test` is executing:**
- An unscoped full-tier run, however invoked - shell command (`npx vitest run` with no path,
  `maestro test .maestro/` for the full suite) or MCP tool (the Maestro MCP `run` tool pointed at
  a directory or the whole suite is the same violation as `maestro test .maestro/`).

If a run would execute tests you did not add or modify, it is a full-tier run regardless of
mechanism: stop and let `/test` handle it.

**Maestro note:** `.maestro/smoke.yaml` runs against a fresh (unpaired) install; the flows under
`.maestro/paired/` need a running relay plus `node scripts/stubDesktopPeer.mjs` and a completed
pairing first (each flow's header documents the setup).

## Conventions

Enforceable standards live as focused, auto-loaded rules in `.claude/rules/`. Rules without a
`paths:` header load every session; rules with one load when you touch matching files. Each rule
names its enforcement (live now, or planned where mechanical coverage does not exist yet).

**Always-on rules:**
- `bash-single-command.md` - one command per Bash tool call; no `&&` `||` `|` `;` or redirects.
- `text-formatting.md` - no em-dashes (U+2014) or `--` as punctuation in authored text.
- `typescript-style.md` - TypeScript strict mode; no `any` types; full descriptive names.
- `no-personal-info.md` - no usernames, emails, or machine paths in committed code (repo is public).

**Path-scoped rules (load with their subsystem):**
- `protocol-types-from-package.md` - wire/crypto/capability types come only from
  `@kangentic/protocol`, never redeclared (`src/**`).
- `accountless-core.md` - pairing/transport/capability code has no account/entitlement imports
  (`src/pairing/`, `src/channel/`, `src/connection/`, `src/notifications/`).
- `e2e-notification-privacy.md` - push payloads are ciphertext plus placeholder only
  (`src/notifications/`, `plugins/`, `targets/`).
- `expo-cng.md` - no hand-edited `ios/`/`android/`; native config via config plugins; SDK-resolved
  dependency installs via `expo install` (`app.json`, `app.config.*`, `eas.json`, `plugins/`,
  `ios/`, `android/`, `package.json`, `package-lock.json`).
- `secure-storage.md` - long-lived secrets in `expo-secure-store`, never AsyncStorage
  (`src/pairing/`, `src/channel/`, `src/notifications/`, `src/state/`).
- `ui-conventions.md` - shared primitives, font floor, FlashList, testIDs (`src/screens/`,
  `src/components/`).
- `ui-copy-brevity.md` - labels name the action, context names the object; one-line
  descriptions; a11y labels exempt (`src/screens/`, `src/components/`).
- `docs-stay-in-sync.md` - update docs when changing anchor source files.

**Local overrides:** there is no per-rule local file. Put machine-specific instruction overrides
in a gitignored `CLAUDE.local.md` at the project root.

**Other conventions (workflow, not extracted to rules):**
- Prefer editing existing files over creating new ones.
- A plain **local commit** goes through `/commit`: it stages and commits on the current branch
  only, with no push and no rebase. A bare request to "commit" means `/commit`.
- **Landing changes goes through a PR by default.** The board drives it: the **Tests** column
  runs `/pull-request` (commit, conventional branch, push, create the PR, drive its CI checks to
  green), and the **Ship It** column runs `/merge-pull-request` (merge the green PR, pull back to
  local `main`). For a deliberate direct quick-push that bypasses the PR gate, use `/merge-back`.
  Only push, land, or merge when the user explicitly asks.
- `/commit`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all write conventional-commit
  messages.
- `/sync-docs` keeps `docs/` aligned with source; the doc-anchor check runs inside `/pull-request`
  (commit time) and `/merge-pull-request` (merge time), and `/merge-back` for direct pushes.

### Authoring a rule

When you codify a new convention, add it as a `.claude/rules/*.md` file following the existing
ones:

1. **One concern per file**, with a descriptive kebab-case filename.
2. **Decide loading, and keep always-on rules few.** Always-on rules (no frontmatter) load every
   session and cost context every session, so reserve them for universal, file-independent
   conventions. Everything subsystem-specific gets `paths:` frontmatter. Treat ~4 always-on as
   a soft ceiling.
3. **Mind the read-trigger gap.** A path-scoped rule loads when a matching file is read into
   context, not when Claude creates a new file in that path. So (a) any convention that must
   hold at file-creation time belongs in an always-on rule or a hook, never path-scoped-only;
   and (b) every path-scoped rule should have a backstop (a future test, or a review-time
   auditor agent) so a missed load is still caught.
4. **Structure:** a one-paragraph context (the problem / the bug it prevents), `## The rule`
   (prescriptive), `## Enforcement (self-maintaining)`, and `## Scope`.
5. **Name an enforcement, strongest available.** A hook blocks 100%; a test or lint rule runs in
   CI; a review-time auditor agent or `/code-review` is the probabilistic fallback. Flag
   explicitly where mechanical coverage is missing - the harness exists (vitest, Jest + RNTL,
   Maestro, ESLint, `tsc`, all gated in `ci.yml`), so "planned" now means not yet written, not
   impossible. Only a few conventions (shorthand names, UI copy brevity) resist mechanization
   outright and stay review-only by design.
6. **Update the index above** with a one-line pointer, and add a backlink from the enforcing
   agent or skill so the rule stays the single source of truth.
7. **Route agents deliberately.** When authoring or updating a skill, decide whether it needs a
   fresh context (a review or audit skill) or should fork the current session (continuing an
   in-flight task); never route a mutating skill to a read-only agent type.

**Linting:** live. `.github/workflows/ci.yml` runs each check as its own parallel job, and each
job name is a required status check on the protected `main`: `Lint (ESLint)`, `Type check (tsc)`,
`Unit tests (Vitest)`, `Component tests (Jest)`, `Native config (expo prebuild)`. Renaming a job
renames the required check, so main's branch protection must be updated in the same change.
Conventions with no mechanical check of their own (shorthand names, em-dashes, personal info, UI
copy brevity) remain enforced by review (`/code-review`, `crypto-pairing-auditor`,
`expo-rn-reviewer`) rather than mechanically.
