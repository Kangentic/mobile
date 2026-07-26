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

# Clear the log buffer so a failure dump covers exactly this run. Taking the last
# N lines instead does not work on a CI emulator: Play Services floods the buffer
# during boot and pushes the app's own launch lines straight off it, which is how
# the first failure dump came back as pure gms noise with nothing about our app.
adb logcat -c || true

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
  # A failed assertion says what was not visible, never why. These answer the
  # question the assertion cannot: did the app start, is it still alive, what is
  # actually on screen, and did anything crash.
  echo "Maestro failed (exit $exit_code). Capturing diagnostics."
  debug_dir="$RUNNER_TEMP/maestro-debug"

  # Whole buffer, not a tail: it was cleared just before the run.
  adb logcat -d -v time > "$debug_dir/logcat-full.txt" || true
  adb exec-out screencap -p > "$debug_dir/final-screen.png" || true

  # Is the process even alive? A dead app and a hung splash screen produce the
  # same failed assertion but are completely different bugs.
  app_pid="$(adb shell pidof com.kangentic.mobile 2>/dev/null | tr -d '\r' || true)"
  if [ -n "$app_pid" ]; then
    echo "App process IS alive (pid $app_pid) - the app started and did not render, rather than dying."
  else
    echo "App process is NOT running - it either crashed or never started."
  fi

  # What the window manager thinks is focused, which distinguishes "our app is up
  # but blank" from "we are looking at the launcher".
  echo "--- focused activity ---"
  adb shell dumpsys activity activities > "$debug_dir/activities.txt" 2>/dev/null || true
  grep -E 'mFocusedApp|mResumedActivity|topResumedActivity' "$debug_dir/activities.txt" || true

  # ActivityManager logs process start, death, and ANRs; ReactNativeJS and
  # AndroidRuntime carry JS and native crashes. Filtering by these plus our
  # package is what makes the dump readable.
  echo "--- app, ActivityManager and crash lines ---"
  grep -E 'com\.kangentic\.mobile|ReactNativeJS|AndroidRuntime|ActivityManager|FATAL|ANR |Hermes|SoLoader' \
    "$debug_dir/logcat-full.txt" | tail -n 120 || true
fi

exit "$exit_code"
