#!/usr/bin/env bash
#
# Proves an exported .ipa is actually distribution signed.
#
# Usage: verify-ios-signature.sh <path to .ipa> <expected bundle id>
#
# Why this exists: `xcodebuild` exits 0 for plenty of outcomes that are not the
# one we want, and the Android side of this repository has already been bitten
# twice by trusting a tool's exit code over its output (see
# .github/scripts/verify-android-signature.sh). An .ipa that is unsigned, or
# signed with a development certificate, looks identical from the outside and is
# only rejected once a human has spent an upload on it.
#
# ---------------------------------------------------------------------------
# LOGGING RULE, load bearing: this repository is public, so every Actions log
# is public. `codesign -dvv` prints Authority lines containing the certificate
# common name, which on an individual Apple Developer account is a person's
# legal name. Capture that output, match against it, and print only a verdict.
# Never cat it. See .claude/rules/no-personal-info.md.
# ---------------------------------------------------------------------------

set -euo pipefail

ipa_path="${1:?usage: verify-ios-signature.sh <path to .ipa> <expected bundle id>}"
expected_bundle_id="${2:?missing expected bundle id}"

work_dir="${RUNNER_TEMP:-/tmp}/ios-signature-check"

contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

fail() {
  echo "::error::$1"
  exit 1
}

[ -f "$ipa_path" ] || fail "No .ipa at $ipa_path."

rm -rf "$work_dir"
mkdir -p "$work_dir"
unzip -q "$ipa_path" -d "$work_dir"

app_path="$(find "$work_dir/Payload" -maxdepth 1 -name '*.app' -type d | head -n 1)"
[ -n "$app_path" ] || fail "The .ipa contains no Payload/*.app bundle."

# 1. An App Store build always carries the profile it was signed against. Its
#    absence means the export produced an unsigned or ad-hoc-signed payload.
[ -f "$app_path/embedded.mobileprovision" ] \
  || fail "No embedded.mobileprovision in the app bundle, so it was exported unsigned."

# 2. The signature has to actually verify. --deep reaches the embedded
#    frameworks and app extensions, which is where a partial re-sign shows up.
if ! codesign --verify --deep --strict "$app_path" > "$work_dir/verify.log" 2>&1; then
  fail "codesign --verify failed. The payload is not validly signed."
fi

# 3. The signing authority must be a distribution certificate. This is the
#    check that catches a development certificate, which signs and verifies
#    perfectly and is still rejected by App Store Connect.
signing_info="$(codesign -dvv "$app_path" 2>&1 || true)"
if ! contains "$signing_info" "Apple Distribution"; then
  fail "The app is not signed by an Apple Distribution certificate. App Store Connect will reject it."
fi

# 4. get-task-allow true means debuggable, which means a development profile.
#    Read from the signed binary rather than from the profile: this is the value
#    that actually shipped, after any re-sign at export time.
if codesign -d --entitlements :- "$app_path" > "$work_dir/entitlements.plist" 2>"$work_dir/entitlements.err"; then
  # Normalize first: the raw output format has changed across Xcode versions.
  plutil -convert xml1 "$work_dir/entitlements.plist" -o "$work_dir/entitlements.xml" 2>/dev/null || true
  entitlements_file="$work_dir/entitlements.xml"
  [ -f "$entitlements_file" ] || entitlements_file="$work_dir/entitlements.plist"

  task_allow="$(plutil -extract get-task-allow raw -o - "$entitlements_file" 2>/dev/null || echo absent)"
  if [ "$task_allow" = "true" ]; then
    fail "The signed app has get-task-allow=true, so it was signed for development, not distribution."
  fi

  entitlement_bundle_id="$(plutil -extract application-identifier raw -o - "$entitlements_file" 2>/dev/null || echo unknown)"
  if [ "$entitlement_bundle_id" != "unknown" ] && ! contains "$entitlement_bundle_id" "$expected_bundle_id"; then
    fail "Signed for $entitlement_bundle_id but expected $expected_bundle_id."
  fi

  # Remote push is the reason this app has an iOS build at all, and a re-sign
  # that drops the entitlement produces an app that installs, launches, and
  # silently never receives a notification. Fatal rather than a warning: a
  # TestFlight build that cannot register for push is not worth a tester's time.
  aps_environment="$(plutil -extract aps-environment raw -o - "$entitlements_file" 2>/dev/null || echo absent)"
  if [ "$aps_environment" != "production" ]; then
    fail "Signed entitlements have aps-environment=$aps_environment, expected production. This build could not receive push."
  fi

  echo "Entitlements: get-task-allow=$task_allow, aps-environment=$aps_environment, application-identifier matches $expected_bundle_id."
else
  # codesign's entitlements output format has changed more than once across
  # Xcode versions, so falling back to the profile that shipped inside the
  # bundle keeps the push check alive rather than downgrading it to a warning.
  echo "::warning::Could not read entitlements from the signed binary. Falling back to embedded.mobileprovision."
  cat "$work_dir/entitlements.err"

  security cms -D -i "$app_path/embedded.mobileprovision" > "$work_dir/embedded-profile.plist"

  embedded_task_allow="$(plutil -extract Entitlements.get-task-allow raw -o - "$work_dir/embedded-profile.plist" 2>/dev/null || echo absent)"
  if [ "$embedded_task_allow" = "true" ]; then
    fail "The embedded profile has get-task-allow=true, so this is a development build."
  fi

  embedded_aps="$(plutil -extract Entitlements.aps-environment raw -o - "$work_dir/embedded-profile.plist" 2>/dev/null || echo absent)"
  if [ "$embedded_aps" != "production" ]; then
    fail "The embedded profile has aps-environment=$embedded_aps, expected production. This build could not receive push."
  fi

  echo "Embedded profile: get-task-allow=$embedded_task_allow, aps-environment=$embedded_aps."
fi

# 5. The bundle id in Info.plist, independent of the signature.
info_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app_path/Info.plist")"
[ "$info_bundle_id" = "$expected_bundle_id" ] \
  || fail "Info.plist bundle id is $info_bundle_id but expected $expected_bundle_id."

build_number="$(plutil -extract CFBundleVersion raw -o - "$app_path/Info.plist")"
short_version="$(plutil -extract CFBundleShortVersionString raw -o - "$app_path/Info.plist")"

echo "Verified a distribution-signed .ipa:"
echo "  bundle id     $info_bundle_id"
echo "  version       $short_version (build $build_number)"
echo "  size          $(du -h "$ipa_path" | cut -f1)"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "build-number=$build_number"
    echo "short-version=$short_version"
  } >> "$GITHUB_OUTPUT"
fi
