#!/usr/bin/env bash
#
# Exports a signed .ipa from the archive that the Archive step produced, and
# writes ipa-path= to $GITHUB_OUTPUT.
#
# Reads SCHEME, TEAM_ID, PROFILE_UUID and BUNDLE_ID from the environment; the
# workflow supplies them from the provisioning profile rather than from literals,
# because the team id must not be committed (.claude/rules/no-personal-info.md)
# and the EAS-issued profile name embeds a timestamp that changes on every
# reissue.
#
# NSE_BUNDLE_ID and NSE_PROFILE_UUID are optional and cover the Notification
# Service Extension. EVERY embedded bundle needs its own entry in
# provisioningProfiles: -exportArchive re-signs the whole app, and an extension
# missing from the dict fails the export with a profile error naming only the
# bundle id. This is the case build-ios.yml's archive step predicted would need
# closing when the extension landed.

set -euo pipefail

: "${SCHEME:?SCHEME is required}"
: "${TEAM_ID:?TEAM_ID is required}"
: "${PROFILE_UUID:?PROFILE_UUID is required}"
: "${BUNDLE_ID:?BUNDLE_ID is required}"
# The certificate's SHA-1 rather than its name. Apple issues two valid App Store
# certificate types ("Apple Distribution" and the older iOS-only "iPhone
# Distribution", which is what eas credentials issues), so a name here would have
# to match either one; signingCertificate accepts a hash and sidesteps that.
: "${SIGNING_IDENTITY:?SIGNING_IDENTITY is required}"

work_dir="${RUNNER_TEMP:-/tmp}"
archive_path="$work_dir/$SCHEME.xcarchive"
export_path="$work_dir/export"
options_path="$work_dir/ExportOptions.plist"

nse_bundle_id="${NSE_BUNDLE_ID:-}"
nse_profile_uuid="${NSE_PROFILE_UUID:-}"

# Emitted as an extra <key>/<string> pair inside provisioningProfiles, or as
# nothing at all when the extension is not being signed.
nse_profile_entry=""
if [ -n "$nse_bundle_id" ] && [ -n "$nse_profile_uuid" ]; then
  nse_profile_entry="    <key>$nse_bundle_id</key>
    <string>$nse_profile_uuid</string>"
else
  echo "::warning::No extension profile supplied to the export. If the archive contains an .appex, this will fail."
fi

write_export_options() {
  local method="$1"
  cat > "$options_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>$method</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>signingCertificate</key>
  <string>$SIGNING_IDENTITY</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$BUNDLE_ID</key>
    <string>$PROFILE_UUID</string>
$nse_profile_entry
  </dict>
  <key>uploadSymbols</key>
  <true/>
  <key>stripSwiftSymbols</key>
  <true/>
</dict>
</plist>
PLIST
}

run_export() {
  # No -allowProvisioningUpdates: signing is fully manual and the profile is
  # already on disk, so needing to reach Apple here would mean something is
  # wrong. Better to fail than to silently mint a new profile.
  xcodebuild -exportArchive \
    -archivePath "$archive_path" \
    -exportPath "$export_path" \
    -exportOptionsPlist "$options_path"
}

# Xcode 15.3 renamed the App Store export method from "app-store" to
# "app-store-connect" and kept the old name working. Which name a given runner
# image accepts is not worth a 30 minute run to discover, so try the current one
# and fall back once.
write_export_options app-store-connect
if ! run_export; then
  echo "::warning::Export with method=app-store-connect failed. Retrying with the pre-Xcode-15.3 name."
  write_export_options app-store
  run_export
fi

ipa_path="$(find "$export_path" -maxdepth 1 -name '*.ipa' | head -n 1)"
if [ -z "$ipa_path" ]; then
  echo "::error::Export reported success but produced no .ipa."
  ls -R "$export_path" || true
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "ipa-path=$ipa_path" >> "$GITHUB_OUTPUT"
fi

echo "Exported $(basename "$ipa_path") ($(du -h "$ipa_path" | cut -f1))."
