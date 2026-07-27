---
name: e2e
description: >-
  Run the paired Maestro suite correctly end to end - verify the APK matches
  HEAD, rebuild it if not, bring up the stub rig, pair, run, and route every
  failure to the e2e-flow-doctor agent. Use whenever asked to run E2E tests,
  re-run the suite, or check whether a change broke the flows. It exists
  because the setup has an exact order and getting it wrong wastes a full run
  without saying so.
---

# Run the E2E suite

Six steps in a fixed order. Five of them are cheap; the one that is not
(rebuilding the APK) is the one people skip, and skipping it silently tests
code that is not the code under review.

Read `.claude/rules/e2e-maestro-runs.md` first. Every constraint in it fails
as a full-timeout hang rather than an error.

This is the LOCAL recipe. `.github/scripts/run-maestro-paired.sh` runs the same
sequence unattended in CI (relay checkout instead of a sibling clone, `--yes`
instead of an interactive SAS confirm, a fresh identity every run instead of
`--fresh`) - see `e2e.yml`'s `maestro-paired` job. That CI job is advisory, not
a substitute for running this locally while iterating on a flow or the app.

## Step 0 - Is the binary the code?

**The single most wasteful mistake in this suite's history.** A suite run
against a stale APK is not a weaker signal, it is a WRONG one: it reports on
code nobody is asking about, and reads as a real result.

```
adb -s <serial> shell dumpsys package com.kangentic.mobile | grep versionName
git rev-parse --short HEAD
```

Those do not compare directly, so track it explicitly: only a rebuild since
the last source change proves the match. When in doubt, rebuild.

**Only `.maestro/**` YAML is read at run time.** Anything under `src/`,
including a testID or a timing constant, needs a rebuild. Decide which of the
two you changed BEFORE spending fifteen minutes proving nothing.

## Step 1 - Rebuild if needed (~3 min)

Never from `.kangentic/worktrees/` - CMake's 250-char object-path cap kills it
at every variant, and a directory junction does not help because Node
realpaths `node_modules`.

```
git -C C:\kw fetch --all
git -C C:\kw checkout --detach <sha>
```
then from `C:\kw`: `npm install`, `npx expo prebuild --platform android --no-install`,
and from `C:\kw\android`:
```
.\gradlew.bat app:assembleRelease -x lint -x test -PreactNativeArchitectures=x86_64 --console=plain
```
with `EXPO_PUBLIC_KANGENTIC_E2E=1` set for BOTH prebuild and gradle - it is
inlined at bundle time, not read at runtime. `x86_64` alone for the emulator;
add `arm64-v8a` only when the target is a physical device.

Install with `adb -s <serial> install -r <apk>`.

## Step 2 - One rig mode, and it is stub

`npm run dev:stop` first: `dev:live` and `dev:stub` both own Metro on 8081,
and starting one tears the other's bundler out from under the device. **If a
physical device is being used for something else, say so and stop** - the
suite takes the machine.

```
node scripts/dev.mjs stub --serial <serial> --no-metro --fresh
```

`--no-metro` because an `e2e` APK carries its own bundle. `--fresh` forces a
new pairing, which is what a cleared app needs.

If Maestro later reports "Android driver did not start up in time", the
emulator has degraded - `node scripts/dev.mjs emu --serial <serial>` reboots
it and restores the reverses. That is a cure, not a retry.

## Step 3 - Pair, with the URI

```
adb -s <serial> shell pm clear com.kangentic.mobile
maestro --device <serial> test -e PAIRING_URI="<uri>" .maestro/setup/pairing-bootstrap.yaml
```

**The `-e PAIRING_URI` is mandatory** and its absence does not look like a
missing variable: the flow types the literal `${PAIRING_URI}`, the app rejects
it, and the failure surfaces as "sas-accept is not visible", which reads like
a broken pairing screen. Take the URI from the stub's own output - `--fresh`
mints a new one, so a URI from an earlier run is stale and fails identically.

## Step 4 - Run

```
maestro --device <serial> test .maestro/paired
```

Roughly 15-20 minutes for eleven flows. **Never edit `src/` while it runs** -
against a dev client Fast Refresh pushes every save into the app mid-flow,
which presents as most flows failing on unrelated selectors.

**Validating NEW Maestro syntax? Try it on ONE flow first.** An invalid
command is a parse error that aborts the entire suite before a single flow
executes - it looks catastrophic and means nothing.

## Step 5 - Triage every failure through the agent

Do not diagnose by reading the flow. Spawn `e2e-flow-doctor` per failure (or
once with the set), handing it the flow name, the failing step, and the
artifact path under `~/.maestro/tests/<timestamp>/<flow>/`.

It reads the screenshot before forming a hypothesis, checks whether the
request reached the stub, and puts timing LAST - which is the order that
matters, because raising a timeout is the reflex that turns a real bug into an
intermittent one.

## Reporting

Give the tally and name each failure's verdict: app bug, flow bug, or
unresolved. **Never call a partial run green**, and never present a warm
re-run's pass as proof when the failing flow's fix was not in the binary. If a
fix is unverified, say which run would verify it.
