#!/usr/bin/env bash
#
# Boots a simulator, installs the freshly built .app, launches it, and proves it
# is still alive a few seconds later. Writes a screenshot for a human to look at.
#
# Usage: smoke-ios-simulator.sh <path to .app> <bundle id> <screenshot output path>
#
# Why this exists: until now the iOS pipeline proved the app COMPILES and SIGNS,
# and nothing more. The app had never been launched on any iOS device or simulator,
# ever, so the WKWebView terminal and the whole native module graph were unverified
# at runtime. A compile check cannot catch a missing Info.plist key, a native
# module that throws in its constructor, a font that fails to load, or a JS bundle
# that red-screens on the first render. All of those are launch-time failures.
#
# Deliberately narrow: this asserts the process survives launch. It is not an E2E
# test and does not assert any UI. `.maestro/` owns behaviour, and there is no iOS
# Maestro suite yet. "It starts and stays started" is the floor, and the floor was
# missing.

set -euo pipefail

app_path="${1:?usage: smoke-ios-simulator.sh <path to .app> <bundle id> <screenshot path>}"
bundle_id="${2:?missing bundle id}"
screenshot_path="${3:?missing screenshot output path}"

[ -d "$app_path" ] || {
  echo "::error::No app bundle at $app_path."
  exit 1
}

# Pick an available iPhone simulator from the runner image rather than naming a
# device or an iOS version. Both change with every Xcode bump, and a hardcoded
# "iPhone 16" turns a routine image update into a red build for no reason.
devices_json="${RUNNER_TEMP:-/tmp}/simulator-devices.json"
xcrun simctl list devices available --json > "$devices_json"

# A script rather than an inline `node -e`. The first version of this was inline
# and used a top-level `return`, which `node -e` rejects as a syntax error, so the
# picker died and took the launch step with it. It is also parsing Apple's JSON
# shape, which changes with Xcode, so it has a unit test.
device_id="$(node scripts/pickIosSimulator.mjs "$devices_json" || true)"

if [ -z "$device_id" ]; then
  echo "::error::No available iPhone simulator on this runner."
  cat "$devices_json"
  exit 1
fi

# Published so a follow-on step (the Maestro flow) can drive the same booted
# simulator instead of provisioning a second one.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "device-id=$device_id" >> "$GITHUB_OUTPUT"
fi

echo "Booting simulator $device_id"
# Already-booted is success, not failure: the runner image may have one running.
xcrun simctl boot "$device_id" || true
xcrun simctl bootstatus "$device_id" -b

echo "Installing $(basename "$app_path")"
xcrun simctl install "$device_id" "$app_path"

echo "Launching $bundle_id"
launch_output="$(xcrun simctl launch "$device_id" "$bundle_id")"
echo "$launch_output"

# Output looks like "com.kangentic.mobile: 54321".
process_id="${launch_output##*: }"
if ! [ "$process_id" -gt 0 ] 2>/dev/null; then
  echo "::error::Could not read a process id from simctl launch. The app did not start."
  exit 1
fi

# A crash on the first render takes a few seconds to happen. Launching and
# immediately declaring success is the failure mode this whole script exists to
# avoid, so give it time to fall over.
echo "Waiting for the app to settle..."
sleep 15

# The authoritative check: is the process still there? A JS red screen keeps the
# process alive, but a native crash does not.
#
# Capture the listing THEN match it. Do not pipe into `grep -q`: that exits at
# the first match and closes the pipe, `launchctl list` dies of SIGPIPE (141),
# and `set -o pipefail` on line 20 makes 141 the pipeline's status - so the
# check reported "no longer running" precisely BECAUSE it found the app. It is a
# race on how much output is still unwritten when grep exits, which is why it
# passed seven consecutive runs before failing. Observed on run 30461104088:
# "Child process terminated with signal 13: Broken pipe", an empty crash-report
# group, and a screenshot of a fully rendered, healthy app.
process_list="$(xcrun simctl spawn "$device_id" launchctl list)"
if grep -q "$bundle_id" <<< "$process_list"; then
  echo "Process for $bundle_id is still running after 15 seconds."
else
  echo "::error::$bundle_id is no longer running. It launched and then died."
  echo "::group::Crash reports"
  find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -newermt '-5 minutes' -print -exec cat {} \; 2>/dev/null || echo "(none found)"
  echo "::endgroup::"
  xcrun simctl io "$device_id" screenshot "$screenshot_path" || true
  exit 1
fi

# A crash report can exist even when a relaunch left something running, so check
# for one independently rather than trusting the process check alone.
recent_crashes="$(find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -name "*.ips" -newermt '-5 minutes' 2>/dev/null || true)"
if [ -n "$recent_crashes" ]; then
  matching="$(grep -l "$bundle_id" $recent_crashes 2>/dev/null || true)"
  if [ -n "$matching" ]; then
    echo "::error::A crash report for $bundle_id was written during this run."
    echo "::group::Crash report"
    cat $matching
    echo "::endgroup::"
    exit 1
  fi
fi

# Visual proof, and the only artifact that shows whether the app rendered its UI
# or sat on a blank screen. A process can be alive and showing nothing.
xcrun simctl io "$device_id" screenshot "$screenshot_path"
echo "Wrote a screenshot to $screenshot_path"

# Left booted when a Maestro flow is going to drive this same simulator next.
# Booting one takes over a minute, so tearing it down here only to boot another
# would be pure waste.
if [ -n "${KEEP_SIMULATOR_BOOTED:-}" ]; then
  echo "Leaving the simulator booted for the next step."
else
  xcrun simctl shutdown "$device_id" || true
fi
