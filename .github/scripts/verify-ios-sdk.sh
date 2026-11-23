#!/usr/bin/env bash
#
# Fails a built iOS app whose SDK is older than App Store Connect accepts.
#
# Usage: verify-ios-sdk.sh <path to .app>
#
# Run from the repository root, like smoke-ios-simulator.sh: it calls
# `node scripts/checkIosSdk.mjs`.
#
# Why this exists: ITMS-90725. Builds 25 and 26 were built with the iOS 26.5 SDK,
# and from April 2027 App Store Connect refuses an upload that was not built with
# the iOS 27 SDK or later. The only signal Apple gives is an email after the
# upload. build-ios.yml now compiles on the `xcode-27` runner label with the point
# release pinned by IOS_XCODE_VERSION, and this proves what the toolchain actually
# stamped into the app, so a later edit that goes back to an older runner fails
# here instead.
#
# This half only READS. Xcode writes DTSDKName, DTPlatformVersion and DTXcode into
# every built app's Info.plist, which is binary and needs plutil, which only macOS
# has. scripts/checkIosSdk.mjs makes the decision, and has the unit test.
#
# Called from two places:
#   - the simulator job, on the built .app. The weekly cron is the only regular
#     iOS run, so it is the earliest catch.
#   - verify-ios-signature.sh, on the app inside the exported .ipa. That script
#     runs in the device job after the export AND in submit-testflight on the
#     downloaded .ipa, so the floor is re-checked right before altool.

set -euo pipefail

app_path="${1:?usage: verify-ios-sdk.sh <path to .app>}"
info_plist="$app_path/Info.plist"

if [ ! -f "$info_plist" ]; then
  echo "::error::No Info.plist at $info_plist, so the SDK this app was built with cannot be read."
  exit 1
fi

# A missing key reads as EMPTY, with plutil's own message dropped:
# checkIosSdk.mjs then fails naming the missing key, which plutil's message
# would not.
read_toolchain_stamp() {
  plutil -extract "$1" raw -o - "$info_plist" 2>/dev/null || true
}

node scripts/checkIosSdk.mjs \
  --sdk-name "$(read_toolchain_stamp DTSDKName)" \
  --platform-version "$(read_toolchain_stamp DTPlatformVersion)" \
  --xcode "$(read_toolchain_stamp DTXcode)"
