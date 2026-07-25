# Developer Guide

Setup, build system, and testing for Kangentic Mobile. The Expo scaffold, `package.json`, and
test harness landed in App Phase 1; everything below reflects the current setup.

## Prerequisites

Windows-first: this project develops without a Mac in the loop.

- **Node 22** (see `.nvmrc`). On Windows, `nvm-windows` is the simplest way to pin it.
- **JDK 17** and **Android Studio** with an Android Virtual Device (emulator) configured. The
  emulator is the daily local target.
- **`eas-cli`** (`npm install -g eas-cli`), optional. Builds run on GitHub Actions
  (`.github/workflows/build-android.yml` and `build-ios.yml`), so `eas-cli` is needed only for
  managing Apple and Google credentials and as the cloud-build fallback.
- **Maestro CLI**, installable on Windows, for E2E flows against the emulator and for the
  Maestro MCP server; see "Agent tooling (MCP servers)" below for the PATH setup and a gotcha
  worth reading before you hit it.
- No Mac, no Xcode, no local iOS Simulator. Every iOS build runs on a free GitHub-hosted macOS
  runner, including the signed ones (see "iOS without a Mac" below). Note `expo prebuild --platform
  ios` refuses to run on Windows at all, so anything that inspects the generated iOS project has to
  happen on a runner.

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

Agent sessions in this repo get MCP tools from two different mechanisms. `.mcp.json` wires three
servers: `context7` (library documentation lookup, no setup needed), `maestro` (the Maestro CLI's
built-in `maestro mcp` server), and `firebase` (the Firebase CLI's built-in `firebase mcp`
server). Separately, `.claude/settings.json`'s `enabledPlugins` turns on the official Expo plugin,
enabled in this repo only. `maestro`, `firebase`, and the Expo plugin each need one-time setup on
a fresh clone.

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
- **Firebase CLI on PATH, and logged in.** `.mcp.json` starts it with `cmd /c firebase mcp`,
  PATH-resolved for the same reason `maestro` is. Install with `npm install -g firebase-tools`,
  then `firebase login`. The server reuses the CLI's own credentials, so there is nothing extra to
  configure and nothing committed.

  It is scoped to `--only core,messaging`, because this app uses Firebase solely for FCM. The
  flag matters: `--only` silently accepts an unrecognised feature name and simply exposes no tools
  for it, so a typo looks like a working config. Valid names are `apphosting`, `apptesting`,
  `auth`, `core`, `crashlytics`, `dataconnect`, `firestore`, `functions`, `messaging`,
  `realtime_database`, `remoteconfig`, `storage`. There is no read-only mode, which is why the
  write tools are listed under `permissions.ask` and in `CLAUDE.md`'s cloud-spend section.
- **Expo plugin OAuth.** Run `/mcp` and complete the Expo login flow. Each contributor
  authenticates individually as their own personal Expo account; no credentials are committed.
- **Expo credentials exist on developer machines only, never in CI:**

  | Path | Credential | Where |
  |------|-----------|-------|
  | Local agent tooling (Expo MCP) | Personal Expo account, via `/mcp` OAuth | Developer machine only |
  | Local `eas` CLI (submit, manual cloud build) | Personal Expo account, via `eas login` | Developer machine only |
  | CI (GitHub Actions) | **None.** No `EXPO_TOKEN`, no robot user, nothing Expo-side | CI builds with Gradle directly, so it never authenticates to Expo. See CI builds |

  An earlier plan had CI authenticating with an org-scoped `EXPO_TOKEN`. That is no longer the
  design: builds run on Gradle, so the smallest possible CI credential surface is no Expo
  credential at all.

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
- **Where builds run:** on GitHub Actions, with Gradle, on free runners. See CI builds below.
  EAS cloud builds still work and still cost one of the 15 free Android builds per month, so
  they are a fallback rather than the path.
- **EAS profiles:** `development` (dev-client, for local iteration), `preview` (internal
  distribution of a dev-signed build, not a Play track), `e2e` (release-shaped APK with
  `EXPO_PUBLIC_KANGENTIC_E2E=1`, the binary the Maestro paired suite runs against),
  `production` (store release; the Play internal track is reached by this profile plus
  `submit.production.android`, and it no longer auto-increments the version, see Android release
  and Google Play Console).

  `eas.json` stays the source of truth for these even though CI builds with Gradle:
  `scripts/easProfile.mjs` resolves a profile (following `extends`) and the workflow reads the
  `env` block and `android.buildType` from it. `tests/unit/buildWorkflow.test.ts` fails if the
  workflow's profile list and `eas.json` ever drift apart.

  | Profile | Artifact | Gradle task |
  |---|---|---|
  | `development` | APK (debug, dev client) | `:app:assembleDebug` |
  | `preview` | APK (release) | `:app:assembleRelease` |
  | `e2e` | APK (release) | `:app:assembleRelease` |
  | `production` | AAB (release) | `:app:bundleRelease` |

  Convenience scripts `npm run build:dev` / `build:preview` / `build:prod` still wrap
  `eas build --profile <profile> --platform android`, which is a **cloud** build and spends
  quota. Prefer the workflow.
- **EAS Update** for JS-only OTA updates (free tier, 1,000 MAU) once the app ships.
  `expo-updates` is not installed yet, so the `channel` field on each profile is currently inert.

## CI builds (GitHub Actions)

Three workflows live in `.github/workflows/`:

| Workflow | Trigger | Runner | What it does |
|---|---|---|---|
| `ci.yml` | every PR, push to `main` | `ubuntu-latest` | lint, typecheck, sharded unit and component tiers, native config |
| `e2e.yml` | every PR, push to `main` | `ubuntu-latest` | builds the e2e APK, runs Maestro on an emulator |
| `build-android.yml` | `workflow_dispatch`, `v*` tags | `ubuntu-latest` | signed APK/AAB, optional Play submit |
| `build-ios.yml` | `workflow_dispatch` | `macos-latest` | unsigned simulator compile check, or a signed `.ipa` with an optional TestFlight upload |

**Naming convention, matching the kangentic desktop repo.** A workflow `name` is short Title Case
(`CI`, `E2E`, `Build iOS`). Every job carries a lowercase key to reference plus an explicit Title Case
`name` with a parenthetical naming the tool or target (`Lint (ESLint)`, `Device (signed .ipa)`,
`Submit (Google Play)`); a matrix job interpolates its dimension (`Build (${{ matrix.profile }})`).
Without a `name` the Actions UI shows the raw key, which reads like an internal detail.

**A stacked PR gets no CI.** `ci.yml` and `e2e.yml` both filter `pull_request` to
`branches: [main]`, so a PR whose base is another feature branch runs only the CLA check and reports
"all checks passed" having tested nothing. That is a trap, because a stacked PR is otherwise the right
shape for dependent work: it keeps the diff to just the new commits and GitHub retargets it to `main`
automatically when the parent merges. Two ways through it, and the second is better:

- Retarget to `main`. CI runs, but the diff swallows the parent branch's commits, which makes review
  harder for exactly the change that needed stacking.
- **Dispatch the gate directly at the branch:** `gh workflow run ci.yml --ref <branch>`. Both
  workflows accept `workflow_dispatch`, so this runs every job against the branch with no retargeting
  and no diff noise. Link the run from the PR so a reviewer can see the gate was actually exercised.

**A job name in `ci.yml` or `e2e.yml` is a branch-protection status-check context**, so renaming one
there silently breaks the gate on `main` until protection is updated in the same change. The build
workflows are free to rename because neither is a required check. Two further notes: the Actions
sidebar shows the workflow `name` from the **default branch**, so a rename appears stale until it
lands on `main`; and a `run` step with no `name` renders as its whole shell command, so name any step
whose script is longer than a line.

**The gate and the release are separate concerns by design.** `ci.yml` and `e2e.yml` gate every PR,
so `main` is always stable. `build-android.yml` and `build-ios.yml` are dispatch or tag triggered
only, so a release can be cut from `main` whenever wanted without waiting on E2E timing, and a
build workflow never blocks a PR. Do not add a build workflow to the required checks: it would
deadlock every PR on a check that never runs.

**Docs-only PRs skip the E2E build.** `e2e.yml`'s `changes` job classifies the diff and the
expensive jobs are conditional on it. This is deliberately not `paths-ignore` on the trigger:
`E2E tests (Maestro)` is a required check, and a workflow skipped by `paths-ignore` never reports
its checks, so branch protection would wait forever and the PR could never merge. The workflow
always runs, the costly jobs are skipped, and the gate treats a skipped suite as a pass. The
fail-safe direction is to run: anything the classifier cannot confidently call documentation
builds. Changes under `.github/` always run, because a workflow change must be exercised.

**Two known costs, not yet paid down.** `e2e.yml` has its own build job that overlaps with
`build-android.yml`. `setup-gradle` scopes its cache per workflow, so the two do not share a warm
Gradle cache and the E2E build pays a cold one. Consolidating them behind `workflow_call` would fix
it; that was deferred so a change to the E2E path could not break the release path, and the hazard
to watch when doing it is the reusable workflow's concurrency group colliding with a direct
dispatch. Separately, `profile=all` and the effect of `--build-cache` are both implemented but
unmeasured.

**The emulator uses the `default` system image, NOT `google_apis`, and that is load-bearing.**
With Play Services the smoke flow failed three runs out of four, and the failure looked exactly like
an app bug: `Assertion is false: id: home-tab is visible`, surviving even a 45-second
`extendedWaitUntil`. It was not an app bug. Diagnostics proved the app process was **alive** with
`MainActivity` both resumed and focused, no ANR, no exception from our package: it had simply not
rendered. Meanwhile `ActivityManager` was killing and restarting `settings.intelligence`, gms
services were failing to bind, and gms churn refilled a freshly cleared logcat buffer within
seconds, so the app's own launch window was never even captured.

**Play Services was starving the app.** On the `default` image the same commit renders in **7
seconds**, against 16s on a quiet gms image and never within 45s on the failing runs. App code was
byte-identical across all of them.

Two things follow. Do not "fix" a flaky Maestro run by extending timeouts before checking whether
the process is alive and what is focused: a starved emulator and a hung app produce an identical
assertion failure. And when a paired suite that exercises remote push eventually needs
`google_apis`, add it as a **separate matrix entry** rather than putting every flow back on the
image that caused this.

**E2E scope, deliberately narrow.** `e2e.yml` runs only `.maestro/smoke.yaml`, which works against
a fresh unpaired install with no relay and no pairing. The 11 flows under `.maestro/paired/` are
**not** in CI yet: each needs a completed pairing to `scripts/stubDesktopPeer.mjs` over a local
relay on `ws://`, and Android blocks cleartext in a release-shaped build. The
`usesCleartextTraffic` carve-out that fixes it is gated on `EXPO_PUBLIC_KANGENTIC_E2E` in
`app.config.ts` and has not landed on `main`, so a paired flow in CI would fail at relay connect
with code 1006. Adding them is a follow-up: `Kangentic/relay` is public so CI can check it out, and
the stub peer already lives in this repo. A required check that cannot go green blocks every merge,
so only the flows that pass are run.

**Why this is free.** The repository is public, so standard GitHub-hosted runners are unmetered
on Linux and macOS alike. The build runs `npx expo prebuild` then Gradle on the runner, so it
never touches EAS servers and spends no EAS cloud build credit. Linux also has no Windows
path-length limit, which is the thing that makes local release builds awkward.

**Triggering an Android build.** Actions -> Build Android -> Run workflow, or
`gh workflow run build-android.yml -f profile=preview`. Inputs:

| Input | Meaning |
|---|---|
| `profile` | An `eas.json` build profile, or `all` to build every profile in parallel on its own runner. Decides the artifact type, the Gradle task, and the `env` block. |
| `artifact` | `auto` follows the profile; override to force `apk` or `aab`. |
| `abis` | Comma-separated ABI override. Leave empty to use the per-profile default below. |
| `submit_track` | `none` (default) builds only. Any other value queues a Play upload behind an approval gate. Not available with `profile=all`. |

A `v*` tag build always produces a production AAB with every ABI.

The artifact lands on the run as `kangentic-<profile>-v<version>-vc<versionCode>-<sha>`, kept for
14 days. Version name, code, and the ABI set are printed in the run summary.

**Build speed: measured, and not where you would guess.** Three runs, all Android release APKs:

| Run | ABIs | Gradle cache | Gradle step | Total |
|---|---|---|---|---|
| cold, four ABIs | 4 | empty | 1665s | 29 min |
| warm, four ABIs | 4 | populated | 1011s | 19 min |
| warm, one ABI, `--parallel --build-cache` | 1 | populated | 695s | 13 min |

Two findings worth keeping, because both contradict the obvious guess:

- **The Gradle cache is worth about 11 minutes** (1665s to 1011s, a 39% cut). Native object files
  are not in `GRADLE_USER_HOME`, so it is tempting to assume the cache barely helps. Wrong: most of
  that first run was dependency resolution, the Gradle distribution, AGP artifacts, and Kotlin/Java
  compilation across the roughly 20 autolinked library modules.
- **Per-ABI native compilation is only about 105 seconds.** Dropping three of four ABIs saved 316s,
  not the 18 minutes a naive per-ABI estimate suggests. The ABI-independent portion is roughly
  590s and is the real bottleneck: JS bundling, resource processing, dexing, and module compilation.

So ABI reduction is worth having but is not the main lever, and a compiler cache (ccache) targets
the 105s rather than the 590s, which makes it much less valuable here than it first appears. The
levers that actually attack the 590s are the Gradle build cache (now enabled, effect not yet
measured on a second warm run) and potentially Gradle's configuration cache, which React Native
documents but which tends to break on AGP plus a nonstandard plugin set, so it is not enabled blind.

`scripts/androidAbis.mjs` gives each profile only the ABI its target actually runs, which is the
documented React Native approach (`-PreactNativeArchitectures`, see
https://reactnative.dev/docs/build-speed):

| Profile | Default ABIs | Why |
|---|---|---|
| `development`, `preview` | `arm64-v8a` | the maintainer's physical device |
| `e2e` | `x86_64` | the Android emulator's standard system images. An arm64-only APK will not install on it |
| `production`, `v*` tags | all four | Play serves real devices including 32-bit ARM and x86 Chromebooks, and an app bundle must carry every ABI for Play to split per device |

`.github/scripts/verify-android-abis.sh` then asserts the artifact carries exactly the ABIs that
were asked for, so neither a silently-dropped ABI nor a silently-ignored flag can pass.

Two more flags that cannot change the output, only the speed: `--parallel` (a React Native project
is many Gradle modules, one per autolinked library, so parallel project execution is a real win)
and `--build-cache` (`setup-gradle` caches `GRADLE_USER_HOME`, which includes the local build cache,
and Gradle keys entries on task inputs).

**Parallelism.** Selecting `all` fans the profiles out across runners rather than building them
back to back. A matrix over ABIs is deliberately **not** used: every parallel job would repeat the
whole ~590s ABI-independent portion, so with per-ABI cost at only ~105s it would trade a large
amount of duplicated work for very little wall clock. An app bundle must also be a single artifact
containing every ABI, so `production` could not be split that way regardless.

**Secrets.** All optional: the workflow degrades rather than failing when one is missing, so the
pipeline can be exercised before any of them exist. With no keystore it builds a debug-signed APK
smoke build and says so.

| Secret | Needed for | Source |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | a release-signed artifact | base64 of the upload keystore |
| `ANDROID_KEYSTORE_PASSWORD` | same | keystore credentials |
| `ANDROID_KEY_ALIAS` | same | `kangentic-upload` |
| `ANDROID_KEY_PASSWORD` | same | keystore credentials |
| `GOOGLE_SERVICES_JSON` | working remote push | base64 of the Firebase `google-services.json` |
| `PLAY_SERVICE_ACCOUNT_JSON` | submitting to Play | full JSON text of the `play-publisher` key |
| `IOS_DIST_CERT_BASE64` | a signed `.ipa` | base64 of the Apple Distribution `.p12` |
| `IOS_DIST_CERT_PASSWORD` | same | the `.p12` export password |
| `IOS_PROVISIONING_PROFILE_BASE64` | same | base64 of the App Store `.mobileprovision` |
| `ASC_API_KEY_BASE64` | uploading to App Store Connect | base64 of the `AuthKey_*.p8` |
| `ASC_KEY_ID` | same | the key's 10-character id |
| `ASC_ISSUER_ID` | same | the team's issuer UUID |
| `APPLE_ID` | fallback upload auth | the Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | same | generated at appleid.apple.com |

The iOS secrets are optional in the same way: with none of them, dispatch with `target=simulator`
for the unsigned check. A `device` build fails immediately and says which secret is missing, rather
than degrading, because unlike Android there is no useful half-signed iOS artifact.

Nothing about the Apple team is committed. The team id, the profile UUID, and the bundle id are all
read out of the provisioning profile on the runner. That is not only tidiness: the team name on an
individual Apple Developer account is a person's legal name, which
`.claude/rules/no-personal-info.md` forbids in a public repo, and the EAS-issued profile name embeds
a timestamp that changes every time the profile is reissued, so a literal would rot as well as leak.

There is no `EXPO_TOKEN` and no Expo robot user. CI holds no Expo credential at all.

GitHub secrets are write-only once set. Keep a copy of every value somewhere durable outside
GitHub, or losing the maintainer machine means losing them permanently.

**Submitting is gated three ways** and never happens by accident: `submit_track` defaults to
`none`; the submit job is bound to the `google-play` GitHub Environment, which requires a
reviewer's approval; and the job refuses an artifact that is not signed with the upload key.
Before it uploads, `scripts/checkPlayVersionCode.mjs` asks the Play Developer API whether the
version code is already spent and fails fast if it is.

**Signing is verified, not assumed.** After Gradle finishes, the workflow runs `apksigner verify`
(APK) or `jarsigner -verify` (AAB) and fails if the artifact carries the Android debug key or no
signature. A green build that quietly produced an unsignable artifact is the expensive failure
mode, because Play only rejects it after a human has spent the upload.

**Triggering an iOS build.** Actions -> Build iOS -> Run workflow, or
`gh workflow run build-ios.yml -f target=device -f submit=testflight`. Two inputs:

| Input | Meaning |
|---|---|
| `target` | `simulator` (default) is the unsigned compile check, needs no secrets. `device` archives, signs, and exports an `.ipa`. `both` runs the two jobs in parallel. |
| `submit` | `none` (default) keeps the `.ipa` as a run artifact. `testflight` uploads it to App Store Connect. |

The two build jobs are deliberately independent rather than one matrix. The simulator check needs no
Apple account, so it is the only iOS signal available when a certificate has expired or a profile has
been revoked, and a signing problem must not be able to take it down too.

**The upload is a third job behind an approval gate**, mirroring the Play submit path:
`submit-testflight` is bound to the `app-store-connect` GitHub Environment, which requires a
reviewer, and it re-verifies the `.ipa` it downloads rather than trusting the build job. Splitting it
also makes an Apple-side failure cheap: re-running that one job retries the upload against the
already-verified artifact, with no rebuild and no new build number.

If that environment is ever deleted, **recreate it with a required reviewer before dispatching**.
GitHub silently auto-creates a missing environment with no protection rules, which would turn the
gate into a no-op without any error.

**The signed path never touches Expo, and that is the point.** `eas submit` uploads through Expo's
own servers, so an EAS Submit outage blocks a release even when Apple is healthy. That is not
hypothetical: on 2026-07-26 this project's first iOS submission attempt failed with EAS Build
reporting operational and EAS Submit degraded. `.github/scripts/upload-ios-testflight.sh` calls
`xcrun altool` from the runner, straight to Apple's delivery endpoints.

**Two upload auth mechanisms, and the fallback is the interesting one.** An App Store Connect API
key (`.p8` plus key id and issuer id, signed as an ES256 JWT) is preferred: non-interactive,
revocable, no expiring session. But minting one requires App Store Connect's Users and Access page,
which is exactly the surface that goes down during an ASC incident. An app-specific password comes
from appleid.apple.com, a different service, so it stays available when ASC does not. The script
prefers the API key and falls back to the Apple ID automatically, and refuses to retry an
authentication failure, which never fixes itself.

**Signing is verified, not assumed** - the same rule as Android, for the same reason.
`.github/scripts/verify-ios-signature.sh` unzips the `.ipa` and fails unless all of the following
hold: `embedded.mobileprovision` is present, `codesign --verify --deep --strict` passes, the signing
authority is an **Apple Distribution** certificate, `get-task-allow` is not true, the
`application-identifier` and `Info.plist` bundle id both match, and `aps-environment` is
`production`.

That last one is not paranoia. Remote push is the reason this app has an iOS build, and an app
signed without the push entitlement installs, launches, and silently never receives a notification -
a failure a tester would report as "the app is broken" with nothing in any log. It is fatal here
rather than a warning.

**Why the archive is signed rather than exported-then-signed.** Passing manual signing settings on
the `xcodebuild` command line applies them to every target including CocoaPods ones, which is the
classic source of "target does not support provisioning profiles". The usual dodge is to archive
unsigned and let `-exportArchive` do all the signing. This workflow does not, because an unsigned
archive carries no `archived-expanded-entitlements.xcent`, and the re-sign at export can then
silently drop custom entitlements - including `aps-environment`. A loud archive failure beats a
silent one. If that error ever appears (most likely once the Notification Service Extension lands,
since an app extension needs its own profile), add the extension's bundle id to the
`provisioningProfiles` dict in `.github/scripts/export-ios-ipa.sh`. Do not fix it by archiving
unsigned.

**Build number preflight.** `scripts/checkAppStoreBuild.mjs` asks App Store Connect whether
`ios.buildNumber` is already used and fails before the archive starts, so a duplicate costs seconds
instead of a whole build followed by a rejection. It resolves the numeric app id from the bundle id
so nobody has to look it up, and it is skipped with a warning when no ASC API key is set.

**It has a blind spot, and the wording reflects that.** A build that has not registered is invisible
to the API, so the script reports what it checked ("no registered build uses this number") rather than
a verdict.

An earlier version of this section explained that absence as slow ingestion. **That was wrong, and
the correction is the most important thing in this section.** Builds 1 and 2 were not slow, they were
**rejected**: both uploaded successfully and were then refused in processing for ITMS-90683 (a missing
`NSPhotoLibraryUsageDescription`). A build Apple refuses does not appear as `INVALID` in the API; it
simply never becomes a Build resource at all. `/v1/builds` returned zero two hours later, which reads
identically to "still processing".

**So `UPLOAD SUCCEEDED` is not delivery.** There is a processing stage after the upload that can
refuse the binary, it reports only by email, and nothing in the pipeline could see it: `altool
--validate-app` passed, the upload reported success, and the submit job went green over a binary Apple
threw away. That is why `submit-testflight` now runs `checkAppStoreBuild.mjs --await-processing`, which
polls for the build and **fails when it never registers** rather than treating the silence as
patience. If a genuinely slow build ever trips it, the fix is a longer `--timeout-minutes`; the
opposite error is a green release over nothing.

**A rejected build number is spent.** Apple requires the next upload to use a higher one, exactly as
for a released build, so 1 and 2 are both gone.

The authority is the upload, not the preflight: altool rejects a duplicate and
`.github/scripts/upload-ios-testflight.sh` fails on that rejection. Which is worth stating because the
first version of that script did **not**: it treated Apple's `The bundle version must be higher`
rejection as success, alongside the "already exists" messages that genuinely do mean our binary
landed. Those two look similar and mean opposite things. The lenient branch is now gated on
`GITHUB_RUN_ATTEMPT > 1`, since only the attempt number distinguishes "our own retry" from "someone
else's binary holds that version", and `tests/unit/iosTestflightUpload.test.ts` runs the real script
against a stubbed `xcrun` to assert the exit codes.

**Signing is set on the app target, not on the xcodebuild command line.** Command-line build
settings apply to every target in the workspace, and a target that produces no signed bundle rejects
a provisioning profile outright. The first signed archive died on exactly that, on a **Swift Package**
target (`RaTeX_RaTeX`), not a CocoaPods one. Exempting offending targets by name is whack-a-mole
since the dependency graph decides how many there are, so `plugins/withIosManualSigning.ts` writes
the four properties into the app target's build settings during prebuild instead.

Two consequences worth knowing before touching that plugin:

- **Its `KANGENTIC_IOS_*` variables must be exported before `expo prebuild`**, not merely before the
  archive. A config plugin runs during prebuild and `GITHUB_ENV` only affects later steps, so
  exporting late leaves the project on automatic signing with nothing in the log to say so. Same trap
  as the `eas.json` env export on Android, and locked by the same kind of test. A
  `-showBuildSettings` step asserts the target really is on manual signing before the archive.
- **`tsc` cannot check the plugin's pbxproj call.** The `xcode` package ships no type declarations,
  so `XcodeProject` degrades to `any`. `tests/unit/iosManualSigning.test.ts` pins the argument shape
  instead, and the plugin declares a local interface for the one method it uses. There is also no way
  to run `expo prebuild --platform ios` on Windows to check it by hand.

**Measured build time: about 11 minutes**, which is faster than the Android release build, and not
where you would guess:

| Step | Time |
|---|---|
| Node + dependency cache restore | 20s |
| Certificate and profile install | 1s |
| `expo prebuild --platform ios` | 2s |
| `pod install` (cold CocoaPods cache) | 46s |
| Resolve workspace and scheme | 19s |
| **`xcodebuild archive`** | **8m 23s** |
| `-exportArchive` | 6s |
| Signature verification | 1s |
| Artifact upload (21 MB) | 2s |

So the archive is 76% of the run and everything else is noise. The CocoaPods cache was a miss on this
first run and will not be again, but at 46s it was never the lever. If iOS build time ever needs
attacking, it is the archive or nothing.

## Testing

Four tiers, chosen for the fastest tier that proves the behavior:

| Tier | Location | Runner | Scope |
|------|----------|--------|-------|
| Unit | `tests/unit/` | vitest | Pure TypeScript logic, no RN runtime |
| Component | `tests/components/` | Jest + React Native Testing Library v13+ | Screens and components, native modules mocked |
| E2E | `.maestro/` | Maestro | Full flows against a real build. `smoke.yaml` runs in CI; `paired/` is local-only for now |
| Web | `tests/web/` | Playwright via react-native-web | Cross-platform component behavior (later) |

Commands: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:components`,
`maestro test .maestro/`.

**Where each tier runs.** Unit and component run on every PR, sharded, from `ci.yml`. Android E2E
runs on every PR from `e2e.yml`: it builds a signed `e2e` APK and drives it on an emulator. Maestro
also runs natively on Windows against a local emulator, which is the right loop while implementing
a change (see the stage-ownership note in `CLAUDE.md` for why local E2E is deliberately *not* a
pre-PR gate).

**Only `.maestro/smoke.yaml` runs in CI today, 1 of 12 flows.** The 11 paired flows need a completed
pairing to `scripts/stubDesktopPeer.mjs` over a local relay on `ws://`, and Android blocks cleartext
in a release-shaped build. Do not read the green `E2E tests (Maestro)` check as full coverage: it is
a smoke gate until those land.

**iOS E2E does not exist yet, by any route.** An earlier version of this section claimed EAS
Workflows on cloud iOS simulators was "the only supported path to iOS E2E without a Mac". That was
never true in practice: there is no `.eas/workflows/` directory in this repo on any branch, so
nothing was ever wired. It is also no longer the only option. `build-ios.yml` already compiles the
app on a free `macos-latest` runner, so booting a simulator there with `xcrun simctl` and running a
Maestro flow is a working path that needs no Apple Developer account and no EAS spend. That is the
cheapest way to finally execute the WKWebView terminal on iOS, which has never run.

### Running the E2E suite (the path that actually works)

**Drive Maestro through the CLI, not the MCP server.** The MCP server starts its own
`simulator-server` alongside whatever the rig and the CLI are already doing, and when those
collide it stops responding: observed hanging for over two minutes on calls as trivial as
`cheat_sheet` and `take_screenshot`, while the same work through `maestro test` returned in
seconds. Use the MCP server for authoring help (`inspect_screen` on a quiet device) and the CLI
to run anything.

**One rig, one mode.** `dev:live` and `dev:stub` both own Metro on 8081, so starting one kills
the other's bundler out from under the device. Pick the mode for the job and stay in it.

**Testing against a DEV CLIENT costs three workarounds**, all of them consequences of the dev
client rather than of our app:

1. `adb shell pm clear` wipes the saved Metro bundle URL along with the app data, so the next
   launch lands on the dev launcher and no JS loads. Re-point it first (the rig's
   `pointDevClientAtMetro`). For the same reason `launchApp: clearState: true` - the form the
   Maestro docs otherwise recommend - is wrong here: it would undo that re-pointing.
2. The dev client's first-run sheet is a separate window covering the whole screen. While it is
   up the app's view tree is absent from the hierarchy entirely, so no `testID` of ours resolves
   however visible the screen looks. It has to be dismissed first, and its "Continue" only
   dismisses the explainer - the dev menu proper opens behind it and needs closing too.
3. Metro has to be up for any of it.

**The `e2e` build profile removes all three.** Maestro's guidance is to test the final bundled
binary, and `eas.json`'s `e2e` profile builds exactly that: release-shaped, internal
distribution, APK, with `EXPO_PUBLIC_KANGENTIC_E2E=1`. That flag is the second gate on the
`ws://10.0.2.2` carve-out in `src/pairing/qr.ts` (see `docs/security.md`), so the binary can
still reach a local rig relay even though `__DEV__` is false. No dev menu, no Metro, no bundle
URL to lose:

```
eas build --profile e2e --platform android          # or a local release build with the flag set
maestro --device <serial> test .maestro/paired
```

Use the dev client only when you need Fast Refresh while writing a flow.

**Why a run takes minutes:** every flow begins with `launchApp`, which force-stops and cold
boots, and then waits up to 60s for the channel to re-establish - roughly 70s of the runtime of
a flow whose actual assertions take seconds. `launchApp: stopApp: false` brings the backgrounded
app forward instead, keeping the channel up, at the cost of each flow having to navigate itself
to a known screen rather than relying on a fresh launch.

See `CLAUDE.md`'s Testing section for the scoped-run discipline (what to run while actively
working on a task vs. the full gate).

## iOS without a Mac

Every iOS build for this project happens on a GitHub-hosted macOS runner. There is no Mac in the
loop and no local iOS toolchain; day-to-day development happens on the Android emulator.

`.github/workflows/build-ios.yml` does both jobs (see the CI builds section for the inputs, the
secrets, and what is verified):

- `target=simulator` compiles unsigned for the simulator. No Apple Developer Program membership, no
  certificates, no secrets. The cheapest way to find out whether the iOS native tree still builds,
  and it produces nothing installable.
- `target=device` archives, signs, exports an `.ipa`, and optionally uploads it to App Store Connect.
  Needs the $99/yr Apple Developer Program and the five iOS secrets.

**Credentials were provisioned through EAS, then exported.** `eas credentials` is a genuinely good
interactive tool for the one-time work: registering the bundle identifier, creating the distribution
certificate, generating the provisioning profile, and minting the APNs key. That work was done once,
the resulting `.p12` and `.mobileprovision` were exported to `~/kangentic-secrets/apple/` and set as
GitHub secrets, and the build path is now Expo-free. Using EAS to obtain credentials is not the same
as depending on EAS to build with them.

`eas build --platform ios` still works from Windows and remains the fallback if the runner path ever
breaks. It costs one of the 15 free monthly iOS cloud builds and enters a low-priority queue that
can take hours, which is precisely why it is the fallback and not the path.

`cli.appVersionSource: "local"` is a CLI-wide setting, not an Android-only one, so `ios.buildNumber`
in `app.config.ts` is hand-bumped for the same reason `android.versionCode` is. App Store Connect
rejects a build number it has already seen, so bump it before every upload;
`scripts/checkAppStoreBuild.mjs` checks this before the archive rather than after.

## Android release and Google Play Console

Android release builds are off EAS cloud builds, so signing and versioning are handled by us
rather than by EAS. **The normal path is the `build-android.yml` workflow** (see CI builds); the
manual procedure below is the fallback for when you need a bundle without a runner.

- **`cli.appVersionSource: "local"`** in `eas.json` (not `"remote"`). `android.versionCode` in
  `app.config.ts` is a hand-bumped, code-reviewed integer, not a value EAS tracks server-side.
  Bump it before every Play upload; it must exceed whatever is currently live on the internal
  track. **Enforcement:** `tests/unit/appConfigBrand.test.ts` checks the value is a positive
  integer, and `scripts/checkPlayVersionCode.mjs` (run by the workflow's submit job) asks the Play
  Developer API whether the code is already spent and fails the submit if it is. Nothing can check
  this from a dev box offline, because the answer lives in Play Console.
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

  `-PreactNativeArchitectures=arm64-v8a` is a **Windows-only workaround**, and it is now known to
  be exactly that. An unscoped `gradlew` build compiles all four ABIs and fails on 32-bit
  `armeabi-v7a` on Windows, but the first unrestricted CI run on Linux built every ABI cleanly:
  `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, verified by inspecting `lib/` inside the artifact.
  So the failure was a symptom of the Windows path-length problem, not a real ABI constraint.

  Two consequences. Keep the flag for a local Windows build, where the failure is real. And do
  **not** ship a locally built Windows AAB past the internal track: it carries arm64-v8a code
  only, so 32-bit ARM and x86/x86_64 devices (older phones, Chromebooks, x86 emulators) cannot
  install it. A CI-built bundle has no such limitation, which is the supported path for any track
  beyond internal.

  Build from a short checkout path (something like `C:\kw`), not a deep worktree path, or the
  Windows path-length limit breaks the native build. Passing passwords inline leaks them to shell
  history; prefer a user-level `gradle.properties` outside the repo, or `ORG_GRADLE_PROJECT_*`
  environment variables, for anything beyond a one-off build.
- **Submitting.** The normal path is the `build-android.yml` workflow's `submit_track` input,
  which uploads through the Play Developer API and holds behind the `google-play` environment's
  approval gate. For a manual submit from a dev box, `eas.json`'s `submit.production.android` sets
  `track: "internal"` and `releaseStatus: "completed"` but deliberately carries no
  `serviceAccountKeyPath`, because that path is machine-specific and the key must never be
  committed. Submit a locally built bundle with `eas submit --platform android --path <local .aab>`;
  `--path` names the bundle, not the key. That route authenticates to Expo; the workflow does not.
- **First upload is manual.** The Google Play Developer API (what `eas submit` and the workflow's
  submit job both call) only works once an app has at least one release; the very first AAB for a
  new package name has to go through the Play Console UI by hand. Do that one-off before using the
  submit job, so the workflow's first real run is not also the app's first-ever release.
- **Play Console service account.** A dedicated `play-publisher` service account (no GCP IAM
  roles) is granted app-scoped **View app information** and **Manage testing track releases**
  permissions in Play Console -> API access. Permission changes there can take up to 24 hours to
  propagate.
- See [docs/privacy-policy.md](privacy-policy.md) and [docs/store-listing.md](store-listing.md)
  for the store-facing text already prepared.

## Firebase and remote push

`app.config.ts` only sets `android.googleServicesFile` when `google-services.json` exists at the
repo root. The file is gitignored, so a build without it succeeds and simply ships with remote
push inert. That is deliberate: a missing Firebase config must never break a build.

To wire it up:

1. Create (or open) the Firebase project. It can attach to the existing `kangentic-mobile` Google
   Cloud project, which is where the `play-publisher` service account already lives.
2. Add an Android app with package name **`com.kangentic.mobile`**, matching `app.config.ts`.
3. Download `google-services.json` and drop it at the repo root. It stays gitignored.
4. For CI, store it base64-encoded as the `GOOGLE_SERVICES_JSON` GitHub secret:

   ```
   base64 -w 0 google-services.json
   ```

   On Windows PowerShell:

   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json"))
   ```

Delivering a push additionally needs the FCM V1 service-account key uploaded to the Expo project's
Android push credentials, because the app sends through Expo Push rather than talking to FCM
directly (see "Expo is in the delivery path" in [docs/security.md](security.md) for why, and what
Expo can and cannot see). Generate the key from the Firebase Admin SDK service account:

```
gcloud iam service-accounts keys create <output.json> --iam-account=firebase-adminsdk-fbsvc@kangentic-b43ff.iam.gserviceaccount.com --project kangentic-b43ff
```

Then register it with Expo. Use the CLI, not the dashboard:

```
eas credentials --platform android
```

and take this exact path, which is not obvious:

1. build profile: any (`production` is fine). The credential attaches to the application
   identifier, not the profile.
2. **Google Service Account** - *not* "Push Notifications (Legacy)", which manages the deprecated
   FCM legacy API key that Google is switching off.
3. **Manage your Google Service Account Key for Push Notifications (FCM V1)** - *not* the "for
   Play Store Submissions" entry directly above it. Same key type, different purpose.
4. **Set up a Google Service Account Key for Push Notifications (FCM V1)**, then give it the
   absolute path to the JSON.

Expect `Google Service Account Key assigned to com.kangentic.mobile for FCM V1`.

**Do not use the dashboard's "New Application Identifier" wizard for this.** It is the EAS Build
credentials flow, it hard-requires uploading an Android upload keystore ("You must upload a
keystore file"), and there is no skip. We do not build on EAS, so uploading `kangentic-upload.jks`
there would put a second copy of the Play signing key in a third party for no benefit. The CLI path
above reaches the FCM slot without touching the keystore, which is why it is the documented route.

Two service accounts stay deliberately separate: `firebase-adminsdk-fbsvc@kangentic-b43ff` is the
FCM V1 key held by Expo for push, and `play-publisher@kangentic-mobile` is the narrower Play
publishing key held only as a GitHub secret, with no FCM rights. Do not consolidate them, even
though the `eas credentials` prompt mentions both uses in one sentence.

Expo Push itself is free: no per-notification charge, no paid plan requirement, and a rate limit
(around 600 notifications/second/project) far above anything this app will produce.

Until all of this exists, `build-android.yml` emits a warning on every run and the resulting
binary cannot receive remote notifications.

## Credential inventory

Every credential this project uses, where it lives, and what happens if it is lost. No values here,
by design.

**They live OUTSIDE the repo**, in `%USERPROFILE%\kangentic-secrets\` on the maintainer's machine.
Do not move them in, even gitignored. This repo is public, so a `.gitignore` slip is a published
private key; `git clean -xfd` deletes ignored files and would destroy the only copy of the
keystore; the board's per-task worktrees under `.kangentic/worktrees/` would not see repo-root
files anyway; and `eas build` uploads the project directory, so an in-repo secret would reach
Expo's servers.

| Credential | Local copy | Also held by | If lost |
|---|---|---|---|
| `kangentic-upload.jks` (+ base64, + credentials) | `~/kangentic-secrets/android/` | GitHub secrets (write-only) | **Unrecoverable.** Play support keystore-reset round trip |
| Play publishing key (`play-publisher@kangentic-mobile`) | `~/kangentic-secrets/google-play/` | GitHub secret `PLAY_SERVICE_ACCOUNT_JSON` | Regenerate in Google Cloud, re-grant in Play Console |
| FCM V1 key (`firebase-adminsdk-fbsvc@kangentic-b43ff`) | `~/kangentic-secrets/firebase/` | Expo project credentials (FCM V1) | Regenerate with `gcloud`, re-upload via `eas credentials` |
| `google-services.json` (+ base64) | `~/kangentic-secrets/firebase/`, plus repo root (gitignored) | GitHub secret `GOOGLE_SERVICES_JSON` | Re-download from Firebase console |
| Apple distribution cert `.p12` (+ base64, + password) | `~/kangentic-secrets/apple/` | GitHub secrets `IOS_DIST_CERT_*`, Expo project credentials | Revoke and reissue via `eas credentials`; the profile must be regenerated with it |
| App Store provisioning profile (+ base64) | `~/kangentic-secrets/apple/` | GitHub secret `IOS_PROVISIONING_PROFILE_BASE64` | Regenerate via `eas credentials`. Expires 2027-07-26 regardless |
| APNs key (`.p8`) | Expo project credentials only | - | Revoke in the Apple portal and mint a new one |
| App Store Connect API key (`.p8`) | `~/kangentic-secrets/apple/` once created | GitHub secrets `ASC_*` | Revoke in App Store Connect and mint a new one |

**The Apple certificate is recoverable but not free.** Reissuing the distribution certificate
invalidates the provisioning profile built against it, so both have to be regenerated together. The
provisioning profile also expires on its own, on 2027-07-26; a build after that date fails at the
archive with a signing error rather than anything that names expiry, so it is worth knowing in
advance.

**Android developer verification: already satisfied, no action pending.** Google auto-registered the
`com.kangentic.mobile` package on 2026-07-26 because it is already on Play, and confirmed it by email.
Nothing is required.

The same email carries a conditional "what you need to do" section about registering additional
signing keys and apps distributed **outside** Play, ahead of a September 2026 deadline. That is
addressed to developers shipping through other stores or by direct download. This project does not:
the only distribution channel is Play, and the `preview` and `e2e` APKs are sideloaded onto the
maintainer's own devices and CI emulators, which is self-testing rather than distribution.

Left here only so the next person reading that email does not re-derive it. If the project ever does
distribute outside Play, the upload key's fingerprint would need registering, and it is read with:

```
keytool -list -v -keystore <path to kangentic-upload.jks> -storepass <store password>
```

**Only the upload keystore is unrecoverable.** Everything else regenerates in minutes. GitHub
secrets are write-only once set, so they are not a backup: the local copy is the only readable
original. Back the keystore up off this machine (password manager or encrypted archive) - that is
the single point of failure in the whole setup.

**Two layers protect against committing one.** Filename globs in `.gitignore` (`*keystore*`,
`*service-account*.json`, `*.jks`, `secrets/`, `kangentic-secrets/`), and GitHub **secret scanning
with push protection**, which is enabled on this repo and matches on content rather than filename.
The second layer matters because the first is inherently leaky: Google Cloud names downloaded keys
`<project>-<hash>.json`, which no glob here matches. Verify a candidate filename with
`git check-ignore -v <name>` rather than assuming.

## Deployment tracks

### Android (Google Play)

The Play developer account is a **Personal** account created on 2026-07-20, which is after
Google's 13 November 2023 cutoff. That makes the closed-testing gate mandatory: **internal
testing does not count toward production access.**

| Track | Testers | Review | Status | Unlocks production? |
|---|---|---|---|---|
| Internal | up to 100, by email list | none, live in minutes | created, no release yet | **No** |
| Closed (`alpha`) | 12+ required, opted in 14 continuous days | yes | not created | **Yes**, this is the gate |
| Open (`beta`) | unlimited, publicly discoverable | yes | not created | optional |
| Production | everyone | yes | locked until the closed test passes | n/a |

The ladder, in order:

1. **Manual first upload.** A signed AAB through the Play Console UI by hand. Everything
   automated is blocked until this exists.
2. **Internal track.** Dispatch the workflow with `submit_track=internal`. Fast iteration with
   known devices.
3. **Closed track.** Requires every app-content declaration that internal testing lets you skip:
   store listing, content rating, data safety, target audience, ads, and a public privacy policy
   URL. Build in CI, not locally on Windows, so the bundle carries every ABI.
   Then recruit 12+ testers and keep them opted in for 14 **continuous** days. Testers who opt out
   and back in reset the clock; the 14 days do not accumulate across gaps.
4. **Apply for production access.** Only after step 3 has genuinely held for 14 days. Play asks
   about the testing process and production readiness as part of the application.

Treat steps 3 and 4 as their own piece of work. The 14-day clock means production is at minimum
three weeks out from the day a closed test starts, and none of the content declarations are
filled in yet.

### iOS (App Store Connect)

Shorter and less gated than Play. There is no 12-tester, 14-day equivalent, and internal TestFlight
testing needs no review at all.

| Track | Testers | Review | Status |
|---|---|---|---|
| TestFlight internal | up to 100, must be App Store Connect users on the team | none | the target |
| TestFlight external | up to 10,000, by link or email | yes, a lighter Beta App Review | not started |
| App Store | everyone | yes, full App Review | not started |

The ladder:

1. **Upload a build.** `gh workflow run build-ios.yml -f target=device -f submit=testflight`. Unlike
   Play, the first upload can be automated: there is no "the API only works after a manual release"
   rule, only the requirement that the app record exists in App Store Connect, which
   `checkAppStoreBuild.mjs` checks for and names explicitly if it does not.
2. **Internal testing.** The build appears in TestFlight after Apple finishes processing, usually 5
   to 30 minutes. Internal testers can install it immediately.
3. **External testing** needs a Beta App Review, plus a description, feedback email, and beta test
   information.
4. **App Store submission** additionally needs screenshots, the privacy questionnaire, the age
   rating, and a resolved answer on export compliance.

Two things to settle before anything leaves internal testing:

- **`ITSAppUsesNonExemptEncryption` is set to `false` and that answer is not verified.** This app
  does not merely use OS-provided TLS; it implements its own Noise KK channel (X25519,
  ChaCha20-Poly1305, BLAKE2s) via `@noble`. Those are published standard algorithms, which is the
  usual basis for treating an app as exempt, but that is a reasoned default rather than a legal
  conclusion. TestFlight internal testing does not act on the value. See the comment in
  `app.config.ts`.
- **The iOS runtime is still unproven.** The app compiles for iOS and now signs, but no iOS build has
  ever been run. The WKWebView terminal and the notification stack (Android uses Notifee; iOS needs
  the Notification Service Extension, a later phase) are untested on the platform.

## Environment Variables

Any variable prefixed `EXPO_PUBLIC_` is baked directly into the JS bundle at build time and is
**never** an appropriate place for a secret. There are no runtime secrets embedded in this app.
Push credentials (FCM service account, APNs key) live only in the maintainer's EAS account,
uploaded at build time. The Android upload keystore and the Play Console service-account key live
in a directory outside the repo on the maintainer's machine, and are mirrored into GitHub Actions
secrets for CI release builds (see CI builds for the list). None of these ever land in the repo or
the shipped binary, and a GitHub secret is write-only once set, so the machine copies remain the
only readable original.

Build-time variables come from the `env` block of the `eas.json` build profile, resolved by
`scripts/easProfile.mjs`. That is the single source of truth for both a local `eas build` and the
CI workflow.

- `EXPO_PUBLIC_KANGENTIC_E2E=1` - set by the `e2e` profile. Marks the build as the Maestro E2E
  target.

Dev-only variables:

- `EXPO_PUBLIC_KANGENTIC_MOCK=1` - enables the in-app mock desktop peer (dev builds only; the
  code path is stripped from production bundles). Set by `npm run dev:mock`, not by hand.
- `EXPO_PUBLIC_KANGENTIC_E2E=1` - set by the `e2e` EAS profile, never by hand. It is the second
  build-time gate (alongside `__DEV__`) on accepting the Android emulator's `ws://10.0.2.2`
  host-loopback alias as a relay address, so a release-shaped Maestro build can pair with a
  local rig relay. It widens NOTHING else, and like every `EXPO_PUBLIC_*` value it is inlined at
  build time, so a `production` bundle has no such branch. See `docs/security.md`'s relay-scheme
  paragraph before touching it.
- `KANGENTIC_RELAY_REPO` - where `scripts/dev.mjs` finds the relay checkout; never read by
  the app bundle.

## Conventions

See `CLAUDE.md`'s Conventions section for the rules index (`.claude/rules/`).

## Documentation Maintenance

`/sync-docs` keeps `docs/` aligned with source once source exists; its targeted anchor check
also runs inside `/pull-request`. See `.claude/skills/sync-docs/SKILL.md`.
