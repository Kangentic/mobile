#!/usr/bin/env bash
# Fail unless the artifact contains exactly the ABIs the build asked for.
#
# This is the guard for the trap that motivated per-profile ABI defaults in the
# first place: an APK missing the ABI its target runs still builds green, uploads
# fine, and only fails at `adb install` with an unhelpful error. An arm64-only
# APK will not install on a standard x86_64 emulator, and an AAB missing 32-bit
# ARM cannot be promoted past the internal track.
#
# It also catches the quieter direction: if -PreactNativeArchitectures ever stops
# being honoured, the artifact would silently carry all four ABIs and take four
# times as long, which nothing else would notice.
#
# Usage: verify-android-abis.sh <path> <apk|aab> <comma-separated-expected-abis>
set -euo pipefail

artifact_path="$1"
extension="$2"
expected_csv="$3"

if [ ! -f "$artifact_path" ]; then
  echo "::error::No artifact at $artifact_path"
  exit 1
fi

# An APK stores native libraries under lib/<abi>/, an app bundle under
# base/lib/<abi>/.
if [ "$extension" = "aab" ]; then
  lib_prefix="base/lib/"
else
  lib_prefix="lib/"
fi

entries="$(unzip -Z1 "$artifact_path")"
found="$(printf '%s\n' "$entries" | { grep "^${lib_prefix}" || true; } | sed "s|^${lib_prefix}||" | cut -d/ -f1 | { grep -v '^$' || true; } | sort -u | paste -sd, -)"
expected="$(printf '%s\n' "$expected_csv" | tr ',' '\n' | { grep -v '^$' || true; } | sort -u | paste -sd, -)"

if [ -z "$found" ]; then
  echo "::error::The artifact contains no native libraries under ${lib_prefix}. Expected [$expected]."
  exit 1
fi

echo "Expected ABIs: $expected"
echo "Found ABIs:    $found"

if [ "$found" != "$expected" ]; then
  echo "::error::ABI mismatch. Expected [$expected] but the artifact carries [$found]."
  exit 1
fi

echo "ABI set verified."
