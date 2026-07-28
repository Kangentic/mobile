#!/usr/bin/env bash
#
# Captures App Store listing screenshots on a 6.9-inch iPhone simulator.
#
# Usage: capture-ios-screenshots.sh <path to .app> <bundle id> <output directory>
#
# THIS IS A PROBE, not a finished pipeline. It captures at the right size, but
# it does NOT yet capture the right CONTENT. Two runs have narrowed why, and
# both findings are recorded here so nobody pays for them twice.
#
# The problem: `isMockDesktopEnabled()` is `__DEV__ && EXPO_PUBLIC_KANGENTIC_MOCK
# === '1'` (src/connection/mockDesktop.ts). Without mock content the app has an
# empty feed and there is nothing worth screenshotting.
#
#   Attempt 1 - Release build with FORCE_BUNDLING=1 and DEV=true.
#   FAILED. React Native's bundling script derives --dev from $CONFIGURATION and
#   OVERWRITES any inherited DEV, so it bundled `--dev false` (visible in the
#   build log's export:embed line) and __DEV__ stayed false. Captured a
#   correctly-sized "No desktop paired" screen.
#
#   Attempt 2 - Debug build, keeping FORCE_BUNDLING=1.
#   The bundle is now a dev bundle, but expo-dev-client's LAUNCHER takes over
#   startup and shows "Searching for development servers...", so the embedded
#   bundle is never loaded and the app never renders. Captured the launcher.
#
#   Attempt 3 - Debug build, Metro on the runner, launcher pointed at it by
#   `simctl openurl`. BLOCKED ON A SYSTEM DIALOG. iOS asks
#   "Open in "Kangentic"?" (Cancel / Open) for a scheme opened from outside the
#   app, and nothing on the runner taps it. The capture is that dialog, and
#   Metro's log confirms it: the server came up and was never asked for a
#   bundle. `simctl` has no tap primitive, so this needs a UI driver.
#
# What is left to try, in order:
#   1. Maestro's iOS driver, to tap "Open" and then walk the same waypoints the
#      Android flow does. The workflow already has an opt-in `maestro` input
#      that installs idb-companion, and whether it works on this runner is
#      itself unverified - see the EXPERIMENTAL note on that job step and
#      upstream mobile-dev-inc/Maestro#2906. If it works, the whole
#      .maestro/screenshots flow becomes reusable for iOS.
#   2. Pre-seeding the dev launcher's saved server URL so no deep link, and so
#      no dialog, is needed at all.
#   3. Widening the mock gate in source so a release-shaped build can show mock
#      content. This weakens a deliberate guard and needs an explicit decision,
#      not a convenience - do not reach for it to save a CI cycle.
#
# Note this is NOT on the critical path for an App Store submission: that shelf
# is also blocked on the privacy questionnaire, the age rating and export
# compliance (see .claude/skills/release/SKILL.md).
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

# Hand the dev client its server as a LAUNCH ARGUMENT, not a deep link.
#
# expo-dev-launcher checks `--initialUrl` out of its own process arguments
# (EXDevLauncherController's initialUrlFromProcessInfo) BEFORE it shows any
# launcher UI, so the app goes straight to the bundle. The simulator reaches the
# runner's loopback directly, so no tunnel or LAN address is involved.
#
# The obvious alternative - `simctl openurl` with the
# exp+mobile://expo-development-client/?url=... link - does reach the device, and
# then iOS puts up an "Open in "Kangentic"?" confirmation that nothing on a
# runner can tap. simctl has no tap primitive, so that route needs a UI driver
# and this one does not. Metro's log was the tell: server up, never asked for a
# bundle.
# Silence expo-dev-menu through the ARGUMENT DOMAIN.
#
# All three of these are UserDefaults, and every one of them defaults AGAINST a
# clean capture on iOS: EXDevMenuShowsAtLaunch is true, so the menu opens by
# itself; EXDevMenuIsOnboardingFinished is false, so the "This is the developer
# menu" explainer covers the app; and EXDevMenuShowFloatingActionButton is true,
# so the dev-tools FAB sits over the UI - the same overlay that spoiled every
# Android capture until it was turned off there.
#
# Passing them as `-Key Value` launch arguments puts them in NSArgumentDomain,
# which outranks the registration defaults the module sets. That beats writing
# them with `defaults write`: nothing is left behind on the simulator, and there
# is no question about which container the write landed in.
DEV_MENU_ARGS=(
  -EXDevMenuShowsAtLaunch NO
  -EXDevMenuIsOnboardingFinished YES
  -EXDevMenuShowFloatingActionButton NO
)

echo "Launching $bundle_id"
if [ -n "${METRO_URL:-}" ]; then
  echo "  pointing the dev client at $METRO_URL"
  xcrun simctl launch "$device_id" "$bundle_id" --initialUrl "$METRO_URL" "${DEV_MENU_ARGS[@]}"

  # Wait for Metro to actually SERVE the bundle rather than sleeping a guess.
  # A cold bundle is slow enough that a fixed wait either races it (capturing a
  # loading screen) or wastes minutes, and "the server was never asked" is
  # precisely the failure the previous attempt hit - so it is worth detecting
  # rather than hoping. The line looks like "iOS Bundled 41441ms index.js".
  if [ -n "${METRO_LOG:-}" ]; then
    echo "Waiting for Metro to serve the bundle..."
    served=0
    for _attempt in $(seq 1 60); do
      if grep -q "Bundled" "$METRO_LOG" 2>/dev/null; then
        served=1
        echo "  Metro served the bundle."
        break
      fi
      sleep 5
    done
    if [ "$served" -ne 1 ]; then
      echo "::error::Metro never served a bundle, so the app never loaded. The dev client was not reached."
      tail -n 40 "$METRO_LOG" || true
      exit 1
    fi
  fi

  echo "Letting the first render settle..."
  sleep 20
else
  xcrun simctl launch "$device_id" "$bundle_id" "${DEV_MENU_ARGS[@]}"
fi

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
