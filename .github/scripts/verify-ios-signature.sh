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
#
#    Both valid App Store certificate types are accepted: the newer unified
#    "Apple Distribution" and the older iOS-only "iPhone Distribution", which is
#    what `eas credentials` issues. Matching only the newer name rejects a good
#    build, which is how this check first failed.
signing_info="$(codesign -dvv "$app_path" 2>&1 || true)"
if ! contains "$signing_info" "Apple Distribution" && ! contains "$signing_info" "iPhone Distribution"; then
  fail "The app is not signed by an App Store distribution certificate. App Store Connect will reject it."
fi

# And a development certificate must not be what signed it. Checked separately
# because "iPhone Developer" contains neither string above, but a bundle could
# in principle carry several authorities.
if contains "$signing_info" "iPhone Developer" || contains "$signing_info" "Apple Development"; then
  fail "The app is signed by a development certificate, not a distribution one."
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

# 5. The Notification Service Extension.
#
#    --deep above validates the extension's SIGNATURE but reads entitlements
#    only from the top-level app bundle, so nothing so far would notice an
#    extension signed with the wrong profile or missing the shared Keychain
#    group. That matters more here than for most entitlements, because the
#    failure is silent at runtime: the extension runs, the Keychain read finds
#    nothing, and every notification shows the generic placeholder, which is
#    exactly what an uninstalled extension looks like.
#
#    Absence is fatal. Once this app ships an extension, an .ipa without one is
#    a build that lost it, not a build that never had it.
expected_nse_bundle_id="$expected_bundle_id.nse"
nse_path="$(find "$app_path/PlugIns" -maxdepth 1 -name '*.appex' -type d 2>/dev/null | head -n 1)"
[ -n "$nse_path" ] \
  || fail "No .appex in PlugIns. The Notification Service Extension did not make it into the .ipa, so every iOS notification would show the placeholder."

nse_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$nse_path/Info.plist")"
[ "$nse_bundle_id" = "$expected_nse_bundle_id" ] \
  || fail "The extension's bundle id is $nse_bundle_id but expected $expected_nse_bundle_id."

# App Store Connect rejects an extension whose version pair disagrees with its
# host app, and that rejection lands at upload, long after every gate is green.
nse_build_number="$(plutil -extract CFBundleVersion raw -o - "$nse_path/Info.plist")"
nse_short_version="$(plutil -extract CFBundleShortVersionString raw -o - "$nse_path/Info.plist")"

nse_signing_info="$(codesign -dvv "$nse_path" 2>&1 || true)"
if ! contains "$nse_signing_info" "Apple Distribution" && ! contains "$nse_signing_info" "iPhone Distribution"; then
  fail "The extension is not signed by an App Store distribution certificate."
fi
if contains "$nse_signing_info" "iPhone Developer" || contains "$nse_signing_info" "Apple Development"; then
  fail "The extension is signed by a development certificate, not a distribution one."
fi

if codesign -d --entitlements :- "$nse_path" > "$work_dir/nse-entitlements.plist" 2>/dev/null; then
  plutil -convert xml1 "$work_dir/nse-entitlements.plist" -o "$work_dir/nse-entitlements.xml" 2>/dev/null || true
  nse_entitlements_file="$work_dir/nse-entitlements.xml"
  [ -f "$nse_entitlements_file" ] || nse_entitlements_file="$work_dir/nse-entitlements.plist"

  nse_keychain_groups="$(plutil -extract keychain-access-groups json -o - "$nse_entitlements_file" 2>/dev/null || echo '[]')"
  if ! contains "$nse_keychain_groups" "$expected_bundle_id.shared"; then
    fail "The extension's signed entitlements do not carry the $expected_bundle_id.shared Keychain group, so it could not read the push key and every notification would show the placeholder."
  fi
  echo "Extension entitlements carry the shared Keychain group."
else
  echo "::warning::Could not read entitlements from the signed extension; the Keychain group could not be verified."
fi

# The app half of the same pair. Without it the app writes the push key into its
# own private group and the extension, however correctly entitled, finds nothing.
#
# Gated on the entitlements read having SUCCEEDED, not on the file existing. The
# `>` redirection at step 4 creates entitlements.plist before codesign runs, so
# the file is there even on the fallback path - testing for it would run this
# block against an empty plist, extract nothing, and fail with a wrong reason
# exactly when the deliberate embedded.mobileprovision fallback had kicked in.
if [ -n "${entitlements_file:-}" ]; then
  app_keychain_groups="$(plutil -extract keychain-access-groups json -o - "$entitlements_file" 2>/dev/null || echo '[]')"
  if ! contains "$app_keychain_groups" "$expected_bundle_id.shared"; then
    fail "The app's signed entitlements do not carry the $expected_bundle_id.shared Keychain group, so the extension could never read the push key."
  fi
  echo "App entitlements carry the shared Keychain group."
else
  # The embedded profile grants the group to the App ID; it does not prove the
  # binary was signed with it. A warning rather than a fail, matching how step 4
  # already degrades on this path.
  echo "::warning::Could not read the app's signed entitlements; the shared Keychain group could not be verified."
fi

# 6. The RUNTIME half of the shared Keychain group.
#
#    Checks 5 above prove both bundles are ENTITLED to the group. They say
#    nothing about whether the app actually writes there, which depends on
#    EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP being set before Metro bundles and
#    inlined into the JS. That is a separate step in a separate part of the
#    workflow, and if it is missed the app writes the push key into its own
#    private group, the correctly-entitled extension finds nothing, and every
#    notification shows the placeholder with every gate green.
#
#    Grepping the shipped bundle is the only check that covers the whole chain
#    from the provisioning profile's team id to the string the app runs with.
#    -a because the bundle is not guaranteed to be valid text throughout.
bundle_js="$(find "$app_path" -maxdepth 1 -name 'main.jsbundle' | head -n 1)"
if [ -n "$bundle_js" ]; then
  if grep -qa "$expected_bundle_id.shared" "$bundle_js"; then
    echo "The JS bundle carries the shared Keychain group, so the app will write where the extension reads."
  else
    fail "The JS bundle does not carry the $expected_bundle_id.shared Keychain group. EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP was not set before bundling, so the app would write the push key where the extension cannot read it and every notification would show the placeholder."
  fi
else
  echo "::warning::No main.jsbundle in the app bundle; could not verify the runtime Keychain group."
fi

# 7. The bundle id in Info.plist, independent of the signature.
info_bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app_path/Info.plist")"
[ "$info_bundle_id" = "$expected_bundle_id" ] \
  || fail "Info.plist bundle id is $info_bundle_id but expected $expected_bundle_id."

build_number="$(plutil -extract CFBundleVersion raw -o - "$app_path/Info.plist")"
short_version="$(plutil -extract CFBundleShortVersionString raw -o - "$app_path/Info.plist")"

if [ "$nse_short_version" != "$short_version" ] || [ "$nse_build_number" != "$build_number" ]; then
  fail "The extension is $nse_short_version ($nse_build_number) but the app is $short_version ($build_number). App Store Connect rejects a mismatched pair at upload."
fi

echo "Verified a distribution-signed .ipa:"
echo "  bundle id     $info_bundle_id"
echo "  version       $short_version (build $build_number)"
echo "  extension     $nse_bundle_id $nse_short_version (build $nse_build_number)"
echo "  size          $(du -h "$ipa_path" | cut -f1)"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "build-number=$build_number"
    echo "short-version=$short_version"
  } >> "$GITHUB_OUTPUT"
fi
