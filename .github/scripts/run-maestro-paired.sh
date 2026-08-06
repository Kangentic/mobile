#!/usr/bin/env bash
# Pair the app to scripts/stubDesktopPeer.mjs over a freshly built local relay,
# then run the paired Maestro suite. Runs inside
# reactivecircus/android-emulator-runner's `script:`, so an emulator is up and
# adb is connected by the time this starts.
#
# Deliberately mirrors the locally-proven `dev:stub --pair` sequence
# (scripts/dev.mjs, .claude/skills/e2e/SKILL.md): that rig runs these same 11
# flows green today, so every place CI could plausibly "improve" on it is a
# variable to subtract later when something goes red, not a place to get
# clever now.
#
# Usage: run-maestro-paired.sh <apk-path> <relay-repo-dir> <paired-flows-dir>
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./maestro-lib.sh
source "$script_dir/maestro-lib.sh"

apk_path="$1"
relay_repo_dir="$2"
paired_flows_dir="$3"

if [ ! -f "$apk_path" ]; then
  echo "::error::No APK at $apk_path"
  exit 1
fi
if [ ! -f "$relay_repo_dir/dist/index.js" ]; then
  echo "::error::Relay not built at $relay_repo_dir (expected dist/index.js - run npm ci && npm run build there first)"
  exit 1
fi

relay_log="$RUNNER_TEMP/relay.log"
stub_log="$RUNNER_TEMP/stub.log"
relay_pid=""
stub_pid=""

# Only ever stop pids THIS script recorded starting, never a scan by name,
# port, or command line: .claude/rules/e2e-maestro-runs.md exists because a
# pattern-match kill once took down a running Kangentic desktop instead.
cleanup() {
  if [ -n "$stub_pid" ] && kill -0 "$stub_pid" 2>/dev/null; then
    kill "$stub_pid" 2>/dev/null || true
  fi
  if [ -n "$relay_pid" ] && kill -0 "$relay_pid" 2>/dev/null; then
    kill "$relay_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for_emulator_boot
install_apk "$apk_path"
disable_animations
# NB: the logcat clear happens later, just before the suite runs, not here.
# Relay start, stub start, and the pairing ceremony all sit between the two
# points, and on an 11-flow suite the buffer is the scarce resource - clearing
# it here would leave the suite's own window competing with the whole setup
# phase for buffer space.

# adb reverse tcp:8080 tcp:8080 + ws://127.0.0.1:8080 is the same route the
# local rig uses (scripts/dev.mjs's ensureAdbReverse). 127.0.0.1 is accepted
# unconditionally by src/pairing/qr.ts's LOOPBACK_WS_HOSTS, so this route
# depends on no build-time flag beyond the usesCleartextTraffic carve-out the
# e2e profile already sets. The ws://10.0.2.2 NAT alias (no adb reverse
# needed) is the split scripts/stubDesktopPeer.mjs's --advertise-relay
# documents as CI's alternative, but it additionally depends on the
# EXPO_PUBLIC_KANGENTIC_E2E relay-address gate in qr.ts, so it stays available
# but is not the route used here.
echo "Setting up adb reverse tcp:8080 tcp:8080..."
adb reverse tcp:8080 tcp:8080

# Start the relay with exactly the local rig's env and nothing else
# (scripts/dev.mjs's ensureRelay): only SLOT_ID_PATTERN. Both slots are 32 hex
# characters as of protocol 0.12.0, which derives the pairing slot rather than
# dialing the 64-hex token verbatim; the 64-hex alternative is retained only to
# tolerate an older relay checkout. Keep this identical to dev.mjs's
# RELAY_SLOT_PATTERN.
# Do NOT raise MAX_CONNECTIONS_PER_SLOT, MAX_CONNECTIONS_PER_IP, or the rate
# limits here - the local rig runs these same 11 launchApp cycles against the
# relay's defaults on this same one-IP loopback topology and passes. If a run
# ever shows a slot_busy close, the mechanism is SlotConnectionCaps.tryReserve
# at cap 2 with a not-yet-released connection; find out why the old socket
# did not close before touching the cap.
echo "Starting the relay from $relay_repo_dir..."
(
  cd "$relay_repo_dir"
  SLOT_ID_PATTERN='^([0-9a-f]{32}|[0-9a-f]{64})$' exec node dist/index.js
) > "$relay_log" 2>&1 &
relay_pid=$!

# Check the process we started is still alive BEFORE trusting /healthz, not
# just that something answers on 8080. A relay that dies at startup (the
# classic being EADDRINUSE against an already-running one) otherwise costs a
# full 30s spin and reports a timeout, and on a host that does have another
# relay on 8080 the health probe would pass against the wrong process
# entirely. Same liveness guard the stub gets below.
echo "Waiting for the relay to become healthy..."
relay_ready=""
for _ in $(seq 1 30); do
  if ! kill -0 "$relay_pid" 2>/dev/null; then
    echo "::error::The relay exited during startup. Relay log:"
    cat "$relay_log" || true
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:8080/healthz" > /dev/null 2>&1; then
    relay_ready=1
    break
  fi
  sleep 1
done
if [ -z "$relay_ready" ]; then
  echo "::error::Relay did not become healthy within 30s. Relay log:"
  cat "$relay_log" || true
  exit 1
fi
echo "Relay is healthy."

# Mint the pairing URI as late as possible, immediately before it is consumed
# below. scripts/stubDesktopPeer.mjs gives it a 10-minute expiry
# (PAIRING_WAIT_MS): starting the stub any earlier "to parallelize" with the
# emulator boot is the optimization to resist, because an expired token fails
# as "sas-accept is not visible" on the bootstrap flow, which reads as a
# broken pairing screen rather than the stale input it actually is.
#
# --yes: CI has no stdin for the interactive SAS confirmation (the SAS still
# prints to the log for a manual eyeball check, same as the local rig). No
# --phone-key (a fresh runner has no prior pairing to resume) and no
# --identity-file (the default temp path is unused on a clean runner, so a
# fresh identity is minted every run, which is what we want).
echo "Starting the stub desktop peer..."
node scripts/stubDesktopPeer.mjs --relay ws://127.0.0.1:8080 --yes \
  > "$stub_log" 2>&1 &
stub_pid=$!

echo "Waiting for the stub to mint a pairing URI..."
pairing_uri=""
for _ in $(seq 1 30); do
  if ! kill -0 "$stub_pid" 2>/dev/null; then
    echo "::error::The stub exited before minting a pairing URI. Stub log:"
    cat "$stub_log" || true
    exit 1
  fi
  candidate="$(grep -oE 'kangentic-pair://[^[:space:]]+' "$stub_log" | head -n 1 || true)"
  if [ -n "$candidate" ]; then
    pairing_uri="$candidate"
    break
  fi
  sleep 1
done
if [ -z "$pairing_uri" ]; then
  echo "::error::No pairing URI printed within 30s. Stub log:"
  cat "$stub_log" || true
  exit 1
fi
echo "Pairing URI captured."

# A freshly installed APK is already unpaired, but clear state defensively.
# .maestro/setup/pairing-bootstrap.yaml's own header explains why the flow
# itself does NOT do `launchApp: clearState: true`: against a dev client that
# would also wipe the saved Metro bundle URL. An `e2e` build carries its own
# bundle, so pm clear here is safe and the flow's own launchApp is enough.
adb shell pm clear com.kangentic.mobile

# The bootstrap gets its OWN debug dir. Both runs pass
# --flatten-debug-output, which deliberately drops the per-run timestamped
# subfolder, so pointing both at one directory lets the suite's artifacts land
# on top of the ceremony's - same class of mistake as uploading
# --test-output-dir and not --debug-output, one layer up: the evidence is
# present but you cannot tell which run produced it.
mkdir -p "$RUNNER_TEMP/maestro-output" "$RUNNER_TEMP/maestro-debug" "$RUNNER_TEMP/maestro-debug-bootstrap"

# Unlike scripts/dev.mjs's runPairingBootstrap (fire-and-forget, only warns
# on failure), this MUST fail the job: a green bootstrap is the only proof
# pairing genuinely completed end to end (its final assertion is the stub's
# session row landing on the Agents feed), and running the paired suite
# against a phone that never paired would fail every flow for one reason
# with eleven confusing symptoms.
echo "Running the pairing bootstrap..."
if ! maestro test \
  -e "PAIRING_URI=$pairing_uri" \
  --debug-output "$RUNNER_TEMP/maestro-debug-bootstrap" \
  --flatten-debug-output \
  .maestro/setup/pairing-bootstrap.yaml; then
  echo "::error::Pairing bootstrap failed. Capturing diagnostics."
  dump_failure_diagnostics "$RUNNER_TEMP/maestro-debug-bootstrap"
  echo "--- relay log ---"
  cat "$relay_log" || true
  echo "--- stub log ---"
  cat "$stub_log" || true
  exit 1
fi
echo "Paired. Running the suite..."

# Clear the buffer HERE rather than before the setup phase, so a failure dump
# 20 minutes into the suite still contains the suite's own lines. The setup
# phase (relay, stub, pairing ceremony) is already covered by the relay and
# stub logs, which are uploaded separately.
reset_logcat

# No pm clear between the bootstrap and the suite below - that would unpair
# the app that was just paired.
exit_code=0
suite_log="$RUNNER_TEMP/maestro-suite.log"
# Through `tee` so the run still streams live (this job is 9 to 15 minutes; a
# buffered redirect would show nothing until the end) while leaving a copy to
# summarise from. `set -o pipefail` above is what keeps $? as maestro's status
# rather than tee's.
maestro test \
  --format JUNIT \
  --output "$RUNNER_TEMP/maestro-report.xml" \
  --test-output-dir "$RUNNER_TEMP/maestro-output" \
  --debug-output "$RUNNER_TEMP/maestro-debug" \
  --flatten-debug-output \
  "$paired_flows_dir" 2>&1 | tee "$suite_log" || exit_code=$?

# PER-FLOW DURATIONS INTO THE RUN SUMMARY.
#
# This suite has a known bursty stall: one flow occasionally takes ~6m35s while
# every other flow in the same run finishes in 17 to 40s. Diagnosed from
# commands.json as a hung `launchApp` blocking on host-side adb, twice on two
# DIFFERENT flows, with the emulator provably alive throughout - see
# .claude/rules/e2e-maestro-runs.md. Both times the suite still PASSED, so
# nothing failed and nothing said anything: the only evidence was a job that took
# 15 minutes instead of 9, and recovering the detail meant downloading an
# artifact and reading timestamps.
#
# Printing the table makes the anomaly visible at a glance, run over run,
# which is what turns "the suite feels slow lately" into a measurement. It is
# also the number to watch before promoting this job to a required check.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Paired suite, per flow"
    echo ""
    echo "| Result | Flow | Duration |"
    echo "|---|---|---|"
    grep -oE '\[(Passed|Failed)\] [^ ]+ \([^)]*\)' "$suite_log" \
      | sed -E 's/\[(Passed|Failed)\] ([^ ]+) \((.*)\)/| \1 | `\2` | \3 |/' || true
    echo ""
    echo "Normal is 17 to 40s per flow. A single flow far outside that, with the rest normal,"
    echo "is the known runner-side stall rather than a regression in that flow."
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$exit_code" -ne 0 ]; then
  echo "Maestro failed (exit $exit_code). Capturing diagnostics."
  dump_failure_diagnostics "$RUNNER_TEMP/maestro-debug"
  echo "--- relay log ---"
  cat "$relay_log" || true
  echo "--- stub log ---"
  cat "$stub_log" || true
fi

exit "$exit_code"
