#!/usr/bin/env bash
# Install the APK on the already-booted emulator and run the given Maestro flows.
#
# Runs inside reactivecircus/android-emulator-runner's `script:`, so an emulator
# is up and adb is connected by the time this starts.
#
# Usage: run-maestro.sh <apk-path> <flow-or-directory> [more flows...]
set -euo pipefail

apk_path="$1"
shift

if [ ! -f "$apk_path" ]; then
  echo "::error::No APK at $apk_path"
  exit 1
fi

echo "Waiting for the emulator to finish booting..."
adb wait-for-device
# sys.boot_completed goes 1 well before the launcher is actually usable, and
# installing too early produces spurious INSTALL_FAILED errors.
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 2
done
adb shell input keyevent 82 || true

echo "Emulator ABI: $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"

# -r replaces an existing install. A signature mismatch against a previously
# installed build is the classic failure here, but a CI emulator is always fresh.
echo "Installing $apk_path"
adb install -r "$apk_path"

# Disable animations: Maestro's waits are already explicit, but animations make
# assertions racier for no benefit.
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0

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
  # A failed assertion says what was not visible, never why. Logcat is where a JS
  # exception, a native crash, or a failed bundle load shows up, and it is the
  # difference between "slow cold start" and "the app is broken".
  echo "Maestro failed (exit $exit_code). Capturing diagnostics."
  adb logcat -d -t 2000 > "$RUNNER_TEMP/maestro-debug/logcat.txt" || true
  adb exec-out screencap -p > "$RUNNER_TEMP/maestro-debug/final-screen.png" || true
  echo "--- ReactNativeJS / crash lines from logcat ---"
  grep -E 'ReactNativeJS|FATAL|AndroidRuntime|Exception' "$RUNNER_TEMP/maestro-debug/logcat.txt" | tail -n 80 || true
fi

exit "$exit_code"
