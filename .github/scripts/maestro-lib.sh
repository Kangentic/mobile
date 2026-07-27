#!/usr/bin/env bash
# Shared preliminaries for the Maestro CI scripts (run-maestro.sh, the smoke
# suite, and run-maestro-paired.sh, the paired suite). Sourced, not executed:
# every function assumes `set -euo pipefail` is already in effect in the
# caller and that adb is already connected to a booted-or-booting emulator.

# Waits for the emulator to actually be usable, not just for
# sys.boot_completed=1 (which goes true well before the launcher is usable;
# installing too early produces spurious INSTALL_FAILED errors), then reports
# the ABI so a mismatched APK fails with a readable message instead of a
# cryptic install error.
wait_for_emulator_boot() {
  echo "Waiting for the emulator to finish booting..."
  adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2
  done
  adb shell input keyevent 82 || true
  echo "Emulator ABI: $(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
}

# -r replaces an existing install. A signature mismatch against a previously
# installed build is the classic failure here, but a CI emulator is always
# fresh.
install_apk() {
  local apk_path="$1"
  echo "Installing $apk_path"
  adb install -r "$apk_path"
}

# Maestro's waits are already explicit, but animations make assertions
# racier for no benefit.
disable_animations() {
  adb shell settings put global window_animation_scale 0
  adb shell settings put global transition_animation_scale 0
  adb shell settings put global animator_duration_scale 0
}

# Clear the log buffer so a failure dump covers exactly this run. Taking the
# last N lines instead does not work on a CI emulator: Play Services floods
# the buffer during boot and pushes the app's own launch lines straight off
# it, which is how the first failure dump came back as pure gms noise with
# nothing about our app.
reset_logcat() {
  adb logcat -c || true
}

# A failed assertion says what was not visible, never why. These answer the
# question the assertion cannot: did the app start, is it still alive, what
# is actually on screen, and did anything crash. Writes into $1 (already
# created by the caller).
dump_failure_diagnostics() {
  local debug_dir="$1"

  # Whole buffer, not a tail: it was cleared just before the run.
  adb logcat -d -v time > "$debug_dir/logcat-full.txt" || true
  adb exec-out screencap -p > "$debug_dir/final-screen.png" || true

  # Is the process even alive? A dead app and a hung splash screen produce
  # the same failed assertion but are completely different bugs.
  local app_pid
  app_pid="$(adb shell pidof com.kangentic.mobile 2>/dev/null | tr -d '\r' || true)"
  if [ -n "$app_pid" ]; then
    echo "App process IS alive (pid $app_pid) - the app started and did not render, rather than dying."
  else
    echo "App process is NOT running - it either crashed or never started."
  fi

  # What the window manager thinks is focused, which distinguishes "our app
  # is up but blank" from "we are looking at the launcher".
  echo "--- focused activity ---"
  adb shell dumpsys activity activities > "$debug_dir/activities.txt" 2>/dev/null || true
  grep -E 'mFocusedApp|mResumedActivity|topResumedActivity' "$debug_dir/activities.txt" || true

  # ActivityManager logs process start, death, and ANRs; ReactNativeJS and
  # AndroidRuntime carry JS and native crashes. Filtering by these plus our
  # package is what makes the dump readable.
  echo "--- app, ActivityManager and crash lines ---"
  grep -E 'com\.kangentic\.mobile|ReactNativeJS|AndroidRuntime|ActivityManager|FATAL|ANR |Hermes|SoLoader' \
    "$debug_dir/logcat-full.txt" | tail -n 120 || true
}
