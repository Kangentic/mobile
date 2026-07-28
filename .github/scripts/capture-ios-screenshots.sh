#!/usr/bin/env bash
#
# Captures App Store listing screenshots on a 6.9-inch iPhone simulator.
#
# Usage: capture-ios-screenshots.sh <path to .app> <bundle id> <output directory>
#
# THIS IS A PROBE, not a finished pipeline. The open question it answers is
# whether the mock desktop can be made to appear in a simulator build at all.
#
# The problem: `isMockDesktopEnabled()` is `__DEV__ && EXPO_PUBLIC_KANGENTIC_MOCK
# === '1'` (src/connection/mockDesktop.ts), and the simulator job builds
# `-configuration Release`, so __DEV__ is false and the app comes up on the
# unpaired "Connecting to your desktop..." screen. Without mock content there is
# nothing worth screenshotting.
#
# The approach: the workflow builds with FORCE_BUNDLING=1 and DEV=true, which
# should embed a DEV javascript bundle (__DEV__ true) into the Release-configured
# app - no Metro server at runtime, and the __DEV__ guard in source untouched.
# Whether Expo's bundling phase honours those variables is exactly what this run
# finds out, and the artifact is the answer: populated feed = it worked, an
# unpaired empty state = it did not.
#
# Apple requires 1320x2868 for the 6.9-inch shelf and rejects anything else at
# upload, so the size is ASSERTED here rather than assumed from the device name.

set -euo pipefail

app_path="${1:?usage: capture-ios-screenshots.sh <path to .app> <bundle id> <output dir>}"
bundle_id="${2:?missing bundle id}"
output_directory="${3:?missing output directory}"

# The 6.9-inch shelf. Both models render 440x956pt at @3x = 1320x2868.
REQUIRED_WIDTH=1320
REQUIRED_HEIGHT=2868

[ -d "$app_path" ] || {
  echo "::error::No app bundle at $app_path."
  exit 1
}
mkdir -p "$output_directory"

devices_json="${RUNNER_TEMP:-/tmp}/simulator-devices.json"
xcrun simctl list devices available --json > "$devices_json"

device_id="$(node scripts/pickIosSimulator.mjs "$devices_json" \
  --prefer 'iPhone 17 Pro Max' \
  --prefer 'iPhone 16 Pro Max' || true)"

if [ -z "$device_id" ]; then
  echo "::error::No available iPhone simulator on this runner."
  cat "$devices_json"
  exit 1
fi

echo "Booting simulator $device_id"
xcrun simctl boot "$device_id" || true
xcrun simctl bootstatus "$device_id" -b

echo "Installing $(basename "$app_path")"
xcrun simctl install "$device_id" "$app_path"

echo "Launching $bundle_id"
xcrun simctl launch "$device_id" "$bundle_id"

# The mock's agent-life simulator raises its permission prompt at tick 20, and
# the ticker only starts once a read-stream subscription attaches. Waiting past
# that means the landing feed has something in it rather than being mid-connect.
echo "Letting the mock desktop stream for 45s..."
sleep 45

if ! xcrun simctl spawn "$device_id" launchctl list | grep -q "$bundle_id"; then
  echo "::error::$bundle_id is no longer running. It launched and then died."
  exit 1
fi

capture_path="$output_directory/01-agents.png"
xcrun simctl io "$device_id" screenshot "$capture_path"

# Assert the size rather than trusting the device name. A wrong-sized upload is
# rejected by App Store Connect long after this runner is gone, and the file
# looks perfectly fine until then.
dimensions="$(sips -g pixelWidth -g pixelHeight "$capture_path")"
width="$(echo "$dimensions" | awk '/pixelWidth/ {print $2}')"
height="$(echo "$dimensions" | awk '/pixelHeight/ {print $2}')"
echo "Captured ${width}x${height}"

if [ "$width" != "$REQUIRED_WIDTH" ] || [ "$height" != "$REQUIRED_HEIGHT" ]; then
  echo "::error::Capture is ${width}x${height}, but the App Store 6.9-inch shelf requires ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}. The runner image may not carry a Pro Max simulator."
  exit 1
fi

echo "Wrote $capture_path at the required 6.9-inch size."
xcrun simctl shutdown "$device_id" || true
