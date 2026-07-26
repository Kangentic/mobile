# Developer Guide

Setup, build system, and testing for Kangentic Mobile. The Expo scaffold, `package.json`, and
test harness landed in App Phase 1; everything below reflects the current setup.

## Prerequisites

Windows-first: this project develops without a Mac in the loop.

- **Node 22** (see `.nvmrc`). On Windows, `nvm-windows` is the simplest way to pin it.
- **JDK 17** and **Android Studio** with an Android Virtual Device (emulator) configured. The
  emulator is the daily local target.
- **`eas-cli`** (`npm install -g eas-cli`), for cloud builds, including all iOS builds.
- **Maestro CLI**, installable on Windows, for E2E flows against the emulator and for the
  Maestro MCP server; see "Agent tooling (MCP servers)" below for the PATH setup and a gotcha
  worth reading before you hit it.
- No Mac, no Xcode, no local iOS Simulator: iOS builds and iOS E2E both happen in the cloud via
  EAS (see "iOS without a Mac" below).

## Quick Start

```
npm install
npx expo start --android
```

Requires a development build already installed on the emulator; see `/preview`'s notes on
building one with `eas build --profile development --platform android` or `npx expo run:android`.

For anything beyond a bare Metro session, use the dev rig below.

## Local Dev Rig

`scripts/dev.mjs` is one command that wires up everything a preview needs - emulator boot,
`adb reverse`, a local relay, optionally the stub desktop peer, and Metro:

| Command | What you get |
|---|---|
| `npm run dev:mock` | The app against an **in-app fake desktop** (real channel stack over an in-process loopback). No relay, no pairing, nothing touches a real board. UI/UX iteration and full-feature demos. |
| `npm run dev:live` | The app connected to **your real running Kangentic desktop dev instance** through a local relay. The rig prints the one-time desktop checklist (enable the mobile bridge, relay URL `ws://127.0.0.1:8080`, pair once, grant verbs). |
| `npm run dev:pair` | Resets the app to unpaired (`pm clear`) so you can exercise the QR/paste + SAS **pairing ceremony**. Add `-- --stub` to pair against the stub peer instead of the live desktop. |
| `npm run dev:stub` | Relay + `scripts/stubDesktopPeer.mjs` - the Maestro E2E rig. Reuses the saved phone key for a session-only reconnect when it can (`-- --fresh` forces a re-pair). |
| `npm run dev:doctor` | Read-only preflight: adb/emulator/AVD, the `hw.keyboard=yes` typing check, relay repo and port states, dev-client install, Node version. |
| `npm run dev:emu` | Emulator hygiene: kill + reboot on host GPU, restore the adb reverses, relaunch the app foreground-verified. The cure for progressive emulator lag (a long-lived qemu process degrades under sustained WebGL load). |
| `npm run dev:adb` | adb-server wedge recovery: force-kill adb, fresh server, reverses, relaunch. The cure when the phone reconnect-loops while the relay and desktop are healthy (forwarding silently stops moving data). |

Details worth knowing:

- **Live-mode quick pair (dev-only hot path):** `dev:live` skips the in-app QR/SAS ceremony
  entirely. The desktop dev instance (bridge enabled, dev build) publishes its static public key
  and relay URL to its repo's gitignored `.kangentic/mobile-dev-pairing/desktop.json`; the rig
  answers with a persistent dev phone public key (`phone.json`) that the desktop adopts into its
  signed roster with all verbs granted, and hands the matching identity to the app via
  `EXPO_PUBLIC_KANGENTIC_DEV_PAIRING`. Only public keys cross the file boundary; both sides
  compile the path out of production builds; the ceremony remains the only pairing path for real
  devices (and `dev:pair` still exercises it). The kangentic repo resolves like the relay repo:
  `--kangentic-repo`, `KANGENTIC_REPO`, `kangenticRepoPath` in the state file, or the
  `../kangentic` sibling default. If the handshake file never appears (bridge disabled, or the
  desktop build predates dev-quick-pair), the rig falls back to the manual checklist.
- **Relay checkout:** the rig expects the `kangentic-relay` repo as a sibling directory
  (`../kangentic-relay`), overridable via `--relay-repo`, the `KANGENTIC_RELAY_REPO` env var, or
  `relayRepoPath` in the state file. It starts the relay's `npm run dev` with
  `SLOT_ID_PATTERN='^([0-9a-f]{32}|[0-9a-f]{64})$'` (the 32-hex ongoing-session slot plus the
  64-hex pairing slot); when it adopts an already-running relay it probes for 32-hex acceptance
  and warns with the exact restart command if the pattern is too narrow (symptom: pairing works,
  every session 400s at upgrade).
- **`.devrig.local.json`** (repo root, gitignored, safe to delete): `relayRepoPath`,
  `stubPhoneKey` (captured automatically from the stub's output after a pairing), `avdName`.
- **`adb reverse tcp:8080 tcp:8080`** is required for any relay connectivity - the app only
  accepts `ws://` for loopback hosts - and is wiped on every emulator reboot. The rig re-applies
  it on every run.
- **Lifecycle:** stub/Metro run as supervised children (Ctrl-C stops them; the emulator stays
  up). The **relay is spawned detached** and deliberately outlives the rig (its logs land in
  the OS temp dir as `kangentic-relay-dev.log`): the desktop's bridge and the phone both hold
  sessions through it, and a dev-loop restart must not sever them. Healthy already-running
  pieces are adopted, not restarted. Metro's interactive keys (`r`, `j`) pass through.
- **Stale stub pairing:** if `dev:stub` shows no `[session] established` within ~20s, the saved
  phone key or the stub identity (in the OS temp dir) is stale - `npm run dev:pair -- --stub`
  re-pairs fresh and re-captures the key.
- **Mock flag caveat:** `EXPO_PUBLIC_KANGENTIC_MOCK` is inlined at bundle time, so switching
  mock on or off needs a Metro restart with `--clear`.

## Mobile inspect loop

`scripts/mobileInspect.mjs` is the see-poke-interrogate CLI for the app on the attached
emulator/device, built so an agent (or a human) can verify UI changes in a tight loop:

```
node scripts/mobileInspect.mjs screenshot [--out <path>]   # adb screencap -> file, prints the path
node scripts/mobileInspect.mjs tap <x> <y>                 # adb input tap
node scripts/mobileInspect.mjs text "<string>"             # adb input text (spaces handled)
node scripts/mobileInspect.mjs key <ANDROID_KEYCODE>       # adb input keyevent
node scripts/mobileInspect.mjs logcat [--lines n] [--tag t]  # dumped ReactNativeJS log tail
node scripts/mobileInspect.mjs state <connection|stores|subscriptions|feed-stats|route>
node scripts/mobileInspect.mjs serve                       # long-lived server, logs app hellos
node scripts/mobileInspect.mjs relaunch                    # force-stop + launch, VERIFIED foregrounded
```

`relaunch` is the recovery command for a wedged app state: a dead Fast Refresh socket (edits
stop applying), a stale bundle, or a launch that raced onto the home screen. It force-stops,
fires the launcher intent, polls window focus, and RETRIES the launch until the app actually
holds the foreground - the blind `am force-stop` + `monkey` pair loses that race routinely.

`screenshot`/`tap`/`text`/`key`/`logcat` are plain adb and work even when the JS bundle is
broken. `state` interrogates the app's **dev-only inspect bridge**
(`src/devsupport/inspectBridge.ts`): the app dials out to `ws://127.0.0.1:8791` (the rig sets
`EXPO_PUBLIC_KANGENTIC_INSPECT=1` and the `adb reverse` in every mode) and answers with store
SUMMARIES - connection state, per-session activity/transcript-window/diff status, the
subscription manager's desired vs active sets, terminal ring stats, and the current route.
Production bundles never contain the bridge: the boot site is `__DEV__`-and-env gated and the
module loads via dynamic import, the same stripping arrangement as the mock desktop. Wire
shapes live in `src/devsupport/inspectProtocol.ts`; the script mirrors them by hand.

When the TERMINAL looks wrong but every RN-side probe says the state is fine, go one layer
deeper: `node scripts/webviewEval.mjs "<expression>"` evaluates JavaScript inside the terminal
WebView itself over the Chrome DevTools Protocol (the dev build exposes a
`webview_devtools_remote` socket; the script discovers and forwards it). Measuring
`.xterm-screen` geometry against the on-screen pixels this way is how the GPU
`MAX_TEXTURE_SIZE` canvas clamp was diagnosed - the layout was correct and only the painted
scale was wrong, which no RN-side probe could see.

## Agent tooling (MCP servers)

Agent sessions in this repo get MCP tools from two different mechanisms. `.mcp.json` wires two
servers: `context7` (library documentation lookup, no setup needed) and `maestro` (the Maestro
CLI's built-in `maestro mcp` server). Separately, `.claude/settings.json`'s `enabledPlugins`
turns on the official Expo plugin, enabled in this repo only. `maestro` and the Expo plugin each
need one-time setup on a fresh clone.

- **Maestro CLI on PATH.** `.mcp.json` starts the server with `cmd /c maestro mcp`, resolved via
  PATH deliberately rather than an absolute path (an absolute path would violate
  `.claude/rules/no-personal-info.md`, which forbids machine-specific paths in committed files).
  Install the Maestro CLI, add its `bin` directory to PATH, and verify with `maestro --version`.
- **The gotcha that costs an evening.** Claude Code sessions inherit the environment of the
  desktop app (or terminal) that spawned them. After changing PATH, restart the **host app**, not
  just the Claude Code session, or the MCP server keeps failing even though the CLI is installed
  and `maestro --version` works in a fresh terminal. Symptom: `/mcp` shows `maestro` failed to
  connect, or a session-local `maestro`/PATH lookup fails while a brand-new terminal succeeds.
- **Never use `setx PATH "%PATH%;..."` on Windows to fix this.** `setx` truncates at 1024
  characters and silently overwrites the entire user `PATH`, not just appends to it - this has
  wiped a user PATH before. Snapshot the current value first, then use
  `[Environment]::SetEnvironmentVariable("Path", "<existing>;<new-entry>", "User")` in PowerShell.
- **Expo plugin OAuth.** Run `/mcp` and complete the Expo login flow. Each contributor
  authenticates individually as their own personal Expo account; no credentials are committed.
- **Two Expo auth paths, deliberately distinct - do not mix them up:**

  | Path | Credential | Where |
  |------|-----------|-------|
  | Local agent tooling (Expo MCP) | Personal Expo account, via `/mcp` OAuth | Developer machine only |
  | CI (GitHub Actions) | Org-scoped `EXPO_TOKEN` secret | GitHub Actions only. The personal login is never used in CI |

- **Cost and public-write guard.** The Expo MCP's `build_run`/`build_submit`/`workflow_run` spend
  EAS cloud build credits, and its store-review-reply tools post publicly and irreversibly; the
  Maestro MCP's `run_on_cloud` bills Maestro Cloud minutes. See `CLAUDE.md`'s "Cloud-spend and
  public-write MCP tools" section for the full list; it is backed by `permissions.ask` in
  `.claude/settings.json`, which prompts for confirmation on every call in every normal
  permission mode (a bypass mode skips the prompt, so the written policy is the real guard).
- **Optional:** set `MAESTRO_CLI_NO_ANALYTICS=1` to opt out of Maestro's anonymous CLI analytics.

## Developing @kangentic/protocol

`@kangentic/protocol` (the wire format, Noise handshakes, capability verbs, and event types) is
the one dependency shared by this app, the desktop `kangentic` app, and `kangentic-relay`
(see `.claude/rules/protocol-types-from-package.md`). Its source of truth is the **kangentic
monorepo** at `packages/protocol`; it is published to npm only at release milestones, not on
every change.

- **Committed dependency.** This app's `package.json` pins `@kangentic/protocol` to a published
  semver range (e.g. `^0.4.0`). That is what a fresh `npm install`, CI, and EAS cloud builds
  resolve, so the pinned version must be published before a cloud build that needs it.
- **Local iteration (no publish).** The dev rig builds the sibling monorepo's `packages/protocol`
  and links its packed output into this app's `node_modules` on every run (the rig's
  `ensureLocalProtocol`), so Metro and `tsc` track your local protocol checkout without an npm
  publish. It only touches `node_modules`, never the committed `package.json`; a change to the
  protocol source is detected by a content hash and forces a clean Metro cache. Pass
  `--no-protocol-link` to skip it (to test against exactly the installed package), and it skips
  itself gracefully when the sibling `../kangentic` checkout is absent.

Workflow for a protocol change:

1. Edit `packages/protocol/src` in the kangentic monorepo and bump its `package.json` version
   (minor for an additive, backward-compatible change; see wire compatibility below).
2. Open a PR against the monorepo and merge it to `main` - `main` is the protocol's source of
   truth, decoupled from npm publishing.
3. Locally, just re-run the dev rig (`npm run dev:live` / `dev:mock` / ...): it rebuilds and
   relinks the protocol automatically. The desktop app consumes `packages/protocol` as an
   in-repo workspace, so it only needs `npm run build --workspace packages/protocol` plus a
   desktop restart (its mobile-bridge runs in the Electron main process, which does not
   hot-reload).
4. Bump this app's pinned `^x.y.z` and publish `@kangentic/protocol@x.y.z` to npm only when the
   protocol is firmed up for a release, or a cloud build needs it.

**Wire compatibility.** Additive, backward-compatible changes keep `PROTOCOL_VERSION` the same,
so peers on different minor versions still interoperate (an older phone ignores unknown fields; a
newer desktop tolerates their absence). A breaking wire change bumps `PROTOCOL_VERSION`, which is
bound into the Noise prologue and forces all peers to upgrade in lockstep.

## Project Structure

```
app.config.ts                # Expo config; CNG - config plugins only, no checked-in native projects
eas.json                     # EAS Build/Submit/Workflows profiles
plugins/                     # Local Expo config plugins (NSE injection, keychain access group, notifee) - later phase
targets/nse/                 # iOS Notification Service Extension source, injected via plugin - later phase
app/                          # expo-router route wrappers (thin - render the src/screens/ implementation)
  task/[taskId].tsx           # full-screen task view; file-diff.tsx hosts the per-file diff
src/
  screens/        # TriageHome, Board, task/ (TaskScreen + Conversation/Terminal/Changes tabs),
                  #   FileDiff, Pairing (Scan/Confirm), Settings, Devices
  components/     # Design system + conversation/ cells and prompt cards, terminal/ xterm pane +
                  #   quick keys, board/ sheets, composer/, diff/ line cells
  pairing/        # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/        # Relay WebSocket transport, KK session manager (responder), slot derivation,
                  #   capability client, typed verb client, feed router, subscription manager
  connection/     # Lifecycle composer: connect/dispose, bootstrap, store feed glue, actions API,
                  #   dev-only mockDesktop peer (EXPO_PUBLIC_KANGENTIC_MOCK)
  conversation/   # Pure transcript-cell flattener, prompt keystrokes, pending-prompt summary
  devsupport/     # Loopback transport, protocol-faithful stub peer classes, wire fixtures -
                  #   shared by tests/unit and the mock desktop
  terminal/       # Pure liveTail cleaner, key sequences, WebView bridge, generated xterm.html
  diff/           # Pure unified-diff lines (jsdiff) + path display
  notifications/  # Push registration, E2E blob decrypt, category prefs, presence suppression - later phase
  state/          # Zustand stores + the non-Zustand terminalFeed PTY ring buffers
  voice/          # Dictation hook over the OS speech engines
  lib/            # Shared pure utilities (crypto polyfills)
tests/unit/       # vitest
tests/components/ # Jest + RNTL
tests/web/        # Playwright via react-native-web (later)
.maestro/         # Maestro E2E flows (smoke unpaired; paired/ needs scripts/stubDesktopPeer.mjs)
scripts/          # bash-guard.js, dev.mjs, stubDesktopPeer.mjs, buildXtermHtml.mjs + repo scripts
```

See `CLAUDE.md`'s Project Structure section; the tree there and this one move together.

## Build System

- **Continuous Native Generation (CNG):** native configuration flows through `app.config.ts` and
  Expo config plugins under `plugins/`. `ios/` and `android/` are prebuild artifacts, gitignored,
  and regenerated by `npx expo prebuild`; see `.claude/rules/expo-cng.md`.
- **Development builds** (`expo-dev-client`) from day one: Expo Go cannot run this app, since
  `expo-secure-store`, `expo-camera`, and (later) Notifee are all custom native modules.
- **EAS profiles:** `development` (dev-client, for local iteration), `preview` (internal
  distribution of a dev-signed build, not a Play track), `production` (store release; the Play
  internal track is reached by this profile plus `submit.production.android`, and it no longer
  auto-increments the version, see Android release and Google Play Console). Convenience scripts:
  `npm run build:dev` / `build:preview` / `build:prod` wrap
  `eas build --profile <profile> --platform android` for each.
- **EAS Update** for JS-only OTA updates (free tier, 1,000 MAU) once the app ships.

## Testing

Four tiers, chosen for the fastest tier that proves the behavior:

| Tier | Location | Runner | Scope |
|------|----------|--------|-------|
| Unit | `tests/unit/` | vitest | Pure TypeScript logic, no RN runtime |
| Component | `tests/components/` | Jest + React Native Testing Library v13+ | Screens and components, native modules mocked |
| E2E | `.maestro/` | Maestro | Full flows against a real dev build |
| Web | `tests/web/` | Playwright via react-native-web | Cross-platform component behavior (later) |

Commands: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:components`,
`maestro test .maestro/`.

**Maestro on Windows:** Maestro runs natively on Windows against the Android emulator for local
E2E. **EAS Workflows runs Maestro on cloud iOS simulators** for iOS E2E; this is the only
supported path to iOS E2E without a Mac.

See `CLAUDE.md`'s Testing section for the scoped-run discipline (what to run while actively
working on a task vs. the full gate).

## iOS without a Mac

`eas build --platform ios` compiles and signs in the cloud from Windows. TestFlight submission
happens via `npx testflight` (or `eas submit`). Local day-to-day development happens on the
Android emulator; an iOS build is validated via TestFlight or a cloud EAS Workflow run.

`cli.appVersionSource: "local"` is a CLI-wide setting, not an Android-only one, so `ios.buildNumber`
in `app.config.ts` is hand-bumped for the same reason `android.versionCode` is. App Store Connect
rejects a build number it has already seen, so bump it before every TestFlight submission. No iOS
build has been produced yet, which is why both start at 1.

## Android release and Google Play Console

Android release builds are moving off EAS cloud builds (board task #5), so signing and versioning
are handled locally rather than by EAS. Everything below is a manual, run-it-yourself procedure:
nothing here is wired into CI yet, and moving it onto a GitHub Actions runner (via
`eas build --local`) is task #5's job, not something you can do from a Windows dev box today.

- **`cli.appVersionSource: "local"`** in `eas.json` (not `"remote"`). `android.versionCode` in
  `app.config.ts` is a hand-bumped, code-reviewed integer, not a value EAS tracks server-side.
  Bump it before every Play upload; it must exceed whatever is currently live on the internal
  track. **Enforcement: none.** No test or CI check guards this, and none can locally, since the
  correct value depends on Play Console state. The guard is this checklist plus code review, until
  task #5 can query the Play Developer API for the live version codes.
- **Upload keystore.** A dedicated `kangentic-upload.jks` keystore (PKCS12 format) lives in a directory outside
  the repo (never committed - `.gitignore` also backstops `secrets/` and `*service-account*.json`
  in case a download lands in the wrong place). Treat `secrets/` as the real backstop and always
  move a freshly downloaded credential into it: Google Cloud names service-account keys
  `<project>-<hash>.json`, which the `*service-account*.json` glob does not match unless you
  rename the file. Losing the keystore means a Play support keystore-reset
  round-trip, so back it up outside the repo too. It is intentionally separate from any
  EAS-managed Android credentials: the `development` and `preview` dev-client builds are signed
  differently, so a device with one of those installed must uninstall it before installing a
  Play-internal-track build, or the install fails with a signature mismatch.
- **Building a signed release bundle.** `android/` is a gitignored CNG artifact; never hand-edit
  `android/app/build.gradle` to reference the keystore, and never patch the generated tree to get
  a failing build to pass. Fix `app.config.ts` or a config plugin and regenerate instead.
  Regenerate first, because a stale `android/` ships whatever `versionCode` it was generated with,
  not the one you just bumped:

  ```
  npx expo prebuild --platform android
  ```

  Then pass signing details as injected Gradle properties, which override the generated project
  without touching it (run from `android/`, where the generated `gradlew` wrapper lives):

  ```
  cd android
  gradlew :app:bundleRelease -PreactNativeArchitectures=arm64-v8a -Pandroid.injected.signing.store.file=<path to kangentic-upload.jks> -Pandroid.injected.signing.store.password=<password> -Pandroid.injected.signing.key.alias=kangentic-upload -Pandroid.injected.signing.key.password=<password>
  ```

  `-PreactNativeArchitectures=arm64-v8a` is needed today: an unscoped `gradlew` build compiles
  all four ABIs and has failed on 32-bit `armeabi-v7a`. The cause has not been pinned down, so
  treat the restriction as a workaround, not a settled fact. Be deliberate about
  keeping it for a release bundle: the resulting AAB carries arm64-v8a native code only, so
  32-bit ARM and x86/x86_64 devices (older phones, Chromebooks, x86 emulators) cannot install it.
  That is acceptable for the internal track, where the test devices are known, and must be
  revisited (diagnose the all-ABI build, or ship all ABIs and let Play App Signing split them)
  before promoting past internal. Build from a short
  checkout path (something like `C:\kw`), not a deep worktree path, or the Windows path-length
  limit breaks the native build. Passing passwords inline
  leaks them to shell history; prefer a user-level `gradle.properties` outside the repo, or
  `ORG_GRADLE_PROJECT_*` environment variables, for anything beyond a one-off build.
- **Submitting.** `eas.json`'s `submit.production.android` sets `track: "internal"` and
  `releaseStatus: "completed"`, but deliberately does not carry a `serviceAccountKeyPath`, because
  that path is machine-specific and the key must never be committed. The key is uploaded once to
  the project's Android credentials on the EAS dashboard, or supplied at submit time. Submit a
  locally built bundle with `eas submit --platform android --path <local .aab>`; `--path` names
  the bundle, not the key.
- **First upload is manual.** The Google Play Developer API (what `eas submit` and any future CI
  step use) only works once an app has at least one release; the very first AAB for a new package
  name has to go through the Play Console UI by hand.
- **Play Console service account.** A dedicated `play-publisher` service account (no GCP IAM
  roles) is granted app-scoped **View app information** and **Manage testing track releases**
  permissions in Play Console -> API access. Permission changes there can take up to 24 hours to
  propagate.
- **Internal testing track only, for now.** Kangentic's Play Console account is a Personal
  account; production access needs a closed test with 12 testers opted in for 14 continuous days,
  which internal testing does not count toward. Store listing, content rating, data safety, and
  the other app-content declarations are not required for internal testing but are required
  before any closed/open/production track. None of them are filled in yet, so treat promoting
  past internal as its own piece of work, not a one-click step.
- See [docs/privacy-policy.md](privacy-policy.md) and [docs/store-listing.md](store-listing.md)
  for the store-facing text already prepared.

## Environment Variables

Any variable prefixed `EXPO_PUBLIC_` is baked directly into the JS bundle at build time and is
**never** an appropriate place for a secret. There are no runtime secrets embedded in this app.
Push credentials (FCM service account, APNs key) live only in the maintainer's EAS account,
uploaded at build time. The Android upload keystore and the Play Console service-account key live
in a directory outside the repo on the maintainer's machine only; they will be mirrored into
GitHub Actions secrets when board task #5 wires up CI release builds, which has not happened yet.
None of these ever land in the repo or the shipped binary.

Dev-only variables:

- `EXPO_PUBLIC_KANGENTIC_MOCK=1` - enables the in-app mock desktop peer (dev builds only; the
  code path is stripped from production bundles). Set by `npm run dev:mock`, not by hand.
- `KANGENTIC_RELAY_REPO` - where `scripts/dev.mjs` finds the relay checkout; never read by
  the app bundle.

## Conventions

See `CLAUDE.md`'s Conventions section for the rules index (`.claude/rules/`).

## Documentation Maintenance

`/sync-docs` keeps `docs/` aligned with source once source exists; its targeted anchor check
also runs inside `/pull-request`. See `.claude/skills/sync-docs/SKILL.md`.
