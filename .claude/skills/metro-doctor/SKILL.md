---
description: Diagnose and recover a broken Metro / dev-client loop (red screens, UnableToResolveError, stuck "Loading from ...", stale bundles) without guessing on-device
allowed-tools: Bash(curl:*), Bash(node:*), Bash(npm:*), Bash(npx:*), Bash(adb:*), PowerShell(Get-NetTCPConnection:*), PowerShell(Get-Process:*)
argument-hint: [symptom, e.g. "red screen UnableToResolveError" or "stuck loading"]
---

# Metro Doctor

Field-tested recovery for the Metro + Expo dev-client loop on this project. The core insight:
never diagnose a bundler problem by squinting at the phone. Metro speaks HTTP; ask it directly.

## Diagnose (always start here)

1. **Is Metro alive?** `curl -s http://localhost:8081/status` - healthy prints
   `packager-status:running`. Nothing listening: start the rig (step R1). Something else on the
   port: the rig will refuse and name it.
2. **Can it actually build the bundle?** Request what the phone requests:
   `curl -s -o <scratchpad>/bundle-probe.txt -w "%{http_code} %{size_download}" "http://localhost:8081/index.bundle?platform=android&dev=true&minify=false"`
   - `200` with multi-MB size: the bundle is fine; the problem is on the device side (step D1).
   - `500`: the probe file is a JSON error with `type` and `message`. Read it with a small
     node script (it contains ANSI escapes; strip them). This gives the exact failing module
     and import chain - far better than the device's truncated red screen.
3. **Interpret the classic failures:**
   - `UnableToResolveError` for a package that IS in `node_modules` (verify with
     `node -e "console.log(require('fs').readdirSync('node_modules/<pkg>/dist').length)"`):
     Metro's file map is stale. This is guaranteed when a package was installed while Metro
     was running - the Windows watcher drops bulk node_modules additions. Fix: restart Metro
     (step R1). No amount of on-device reloading fixes a stale file map.
   - `UnableToResolveError` for a project file: usually a real bad import; fix the code.
   - Babel/syntax errors name the file directly; fix the code.

## Recover

- **R1 - restart Metro through the rig, never by hand-killing PIDs.** Run the dev rig mode
  that matches the current workflow (`npm run dev:mock`, `dev:live`, `dev:pair`, `dev:stub`)
  as a background task. Its `freeStaleMetro()` verifies the port-8081 holder is a stray
  node/Metro before taskkilling it, re-applies the adb reverses (8081 inspect 8791), and
  relaunches the app. Do not `Stop-Process` a PID you merely found on a port.
- **R2 - budget for the first bundle.** After installing a large dependency, the first bundle
  can take 2-3 minutes with no visible progress on the device ("Loading from ...:8081"). Poll
  step 2's curl rather than staring at screenshots; when curl returns 200 the device reload
  will be fast.
- **D1 - device-side recovery.** If the bundle is healthy but the app shows the dev-client
  launcher (crash fallback): screenshot via `node scripts/mobileInspect.mjs screenshot`, tap
  the dev-server row via `node scripts/mobileInspect.mjs tap <x> <y>`. If the app is
  foregrounded but stale, reload via Metro (press `r` in an interactive rig terminal) or
  relaunch: `adb shell monkey -p com.kangentic.mobile -c android.intent.category.LAUNCHER 1`.

## Restart-required changes (Fast Refresh will NOT pick these up)

- A newly installed npm package (stale file map, above).
- `EXPO_PUBLIC_*` env flags (inlined at bundle time): switching mock/inspect flags needs a
  Metro restart **with `--clear`** - the rig handles this when modes change.
- `src/terminal/xterm.html` regeneration (`node scripts/buildXtermHtml.mjs`): the WebView
  asset is require()'d; do a full app reload, not Fast Refresh, and re-open the terminal.
- Native deps / config plugins: full `npx expo run:android` rebuild (see the preview skill).

## Boundaries

The `/preview` skill owns bringing the environment up from cold (emulator boot, dev-client
install, port checks). This skill owns "it was working and now it is not". Both share the
rule: identify before you kill, and prefer the rig's own recovery over manual process surgery.
