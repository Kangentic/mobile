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

  # Whole buffer, not a tail: it was cleared just before the run. Know its
  # limit though - on a suite that runs for minutes the emulator's buffer
  # rolls over, so this can easily begin AFTER the interesting event. Run
  # 30308333829 crashed at 22:01:54 and this file started at 22:07:47.
  adb logcat -d -v time > "$debug_dir/logcat-full.txt" || true
  adb exec-out screencap -p > "$debug_dir/final-screen.png" || true

  # Maestro writes a per-flow crash-report.txt (the bionic tombstone) beside
  # that flow's logs whenever the app process dies mid-flow, and it is the
  # ONLY crash evidence that survives the buffer rollover above. Echo it
  # first, because everything below is a point-in-time reading taken after
  # the run and none of it can tell you a flow crashed. In run 30308333829
  # this file existed, was never echoed, and the job instead reported a live
  # pid - so a hard SIGSEGV 838ms into the first flow's launchApp read as a
  # silent render failure.
  local crash_report
  local flow_name
  local found_crash=""
  for crash_report in "$debug_dir"/*/logs/crash-report.txt; do
    [ -f "$crash_report" ] || continue
    found_crash=1
    flow_name="$(basename "$(dirname "$(dirname "$crash_report")")")"
    echo "::error::The app process crashed during flow: $flow_name"
    echo "--- native crash report ($flow_name) ---"
    cat "$crash_report" || true
  done
  if [ -z "$found_crash" ]; then
    echo "--- no per-flow crash-report.txt: no flow's app process died mid-flow ---"
  fi

  # Is the process alive RIGHT NOW? This runs once, after the whole run has
  # finished, so it describes the end state and nothing else. It must not be
  # read as "the app never died": a flow that crashes early is followed by
  # later flows whose own launchApp starts a fresh process, and that healthy
  # pid is exactly what disguised the crash above. The tombstones are the
  # authority on whether anything died; this line is not.
  local app_pid
  app_pid="$(adb shell pidof com.kangentic.mobile 2>/dev/null | tr -d '\r' || true)"
  if [ -n "$app_pid" ]; then
    echo "App process is alive (pid $app_pid) as of this dump, taken AFTER the run finished."
  else
    echo "App process is not running as of this dump, taken AFTER the run finished."
  fi

  # What the window manager thinks is focused, which distinguishes "our app
  # is up but blank" from "we are looking at the launcher".
  echo "--- focused activity ---"
  adb shell dumpsys activity activities > "$debug_dir/activities.txt" 2>/dev/null || true
  grep -E 'mFocusedApp|mResumedActivity|topResumedActivity' "$debug_dir/activities.txt" || true

  # ActivityManager logs process start, death, and ANRs; ReactNativeJS and
  # AndroidRuntime carry JS crashes. Filtering by these plus our package is
  # what makes the dump readable. The bionic tombstone terms are here because
  # a NATIVE crash matches none of the others: the fatal line is logged as
  # `F/libc` by the dying process and the backtrace as `F/DEBUG` by the
  # crash_dump helper, neither line carries our package name (logcat -v time
  # prints a tag and a pid, not a package), and the header reads "Fatal
  # signal", which the uppercase FATAL above does not match.
  echo "--- app, ActivityManager and crash lines ---"
  grep -E 'com\.kangentic\.mobile|ReactNativeJS|AndroidRuntime|ActivityManager|FATAL|ANR |Hermes|SoLoader|F/libc|F/DEBUG|beginning of crash|Fatal signal|SIGSEGV|SIGABRT|tombstone' \
    "$debug_dir/logcat-full.txt" | tail -n 120 || true
}
