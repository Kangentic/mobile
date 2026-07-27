#!/usr/bin/env bash
# Install the APK on the already-booted emulator and run the given Maestro flows.
#
# Runs inside reactivecircus/android-emulator-runner's `script:`, so an emulator
# is up and adb is connected by the time this starts.
#
# Usage: run-maestro.sh <apk-path> <flow-or-directory> [more flows...]
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./maestro-lib.sh
source "$script_dir/maestro-lib.sh"

apk_path="$1"
shift

if [ ! -f "$apk_path" ]; then
  echo "::error::No APK at $apk_path"
  exit 1
fi

wait_for_emulator_boot
install_apk "$apk_path"
disable_animations
reset_logcat

echo "Running Maestro flows: $*"
# --format takes an uppercase enum (JUNIT, HTML, HTML-DETAILED, NOOP).
#
# --debug-output is the flag that matters on a failure: it is where Maestro writes
# the failure screenshot, the command log, and the view hierarchy.
# --test-output-dir is a different thing (manifest/commands/logs) and does NOT
# contain the screenshot, which is how the first failing run produced a 367-byte
# artifact with nothing diagnostic in it. --flatten-debug-output is documented to
# pair with --debug-output and drops the per-run timestamped subfolder, so the
# upload step has a stable path.
mkdir -p "$RUNNER_TEMP/maestro-output" "$RUNNER_TEMP/maestro-debug"

exit_code=0
maestro test \
  --format JUNIT \
  --output "$RUNNER_TEMP/maestro-report.xml" \
  --test-output-dir "$RUNNER_TEMP/maestro-output" \
  --debug-output "$RUNNER_TEMP/maestro-debug" \
  --flatten-debug-output \
  "$@" || exit_code=$?

if [ "$exit_code" -ne 0 ]; then
  echo "Maestro failed (exit $exit_code). Capturing diagnostics."
  dump_failure_diagnostics "$RUNNER_TEMP/maestro-debug"
fi

exit "$exit_code"
