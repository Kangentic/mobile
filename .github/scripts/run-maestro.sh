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
maestro test --format junit --output "$RUNNER_TEMP/maestro-report.xml" "$@"
