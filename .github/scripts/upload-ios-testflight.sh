#!/usr/bin/env bash
#
# Uploads a signed .ipa to App Store Connect, from where it appears in
# TestFlight.
#
# Usage: upload-ios-testflight.sh <path to .ipa>
#
# This talks to Apple directly with `xcrun altool`. Nothing here goes through
# Expo, which is the point: `eas submit` uploads via Expo's own servers, so an
# EAS Submit outage blocks a release even when Apple is healthy. On 2026-07-26
# that happened (EAS Build operational, EAS Submit degraded) and this path is
# the workaround.
#
# Two auth mechanisms, tried in order:
#
#   1. App Store Connect API key. A .p8 plus key id and issuer id, signed as a
#      JWT. Non-interactive, no expiry surprises, revocable. Preferred.
#   2. Apple ID plus an app-specific password. The fallback that matters during
#      an incident: minting an ASC API key needs App Store Connect's Users and
#      Access page, which is the surface that goes down, while an app-specific
#      password comes from appleid.apple.com, a different service.
#
# ---------------------------------------------------------------------------
# LOGGING NOTE: this repository is public. altool can echo the username on
# failure. APPLE_ID is a registered secret, so Actions masks its value in the
# log, but that masking is a literal string match. Prefer the API key path.
# ---------------------------------------------------------------------------

set -euo pipefail

ipa_path="${1:?usage: upload-ios-testflight.sh <path to .ipa>}"

work_dir="${RUNNER_TEMP:-/tmp}"

contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

[ -f "$ipa_path" ] || {
  echo "::error::No .ipa at $ipa_path."
  exit 1
}

# --- Pick an auth mechanism ------------------------------------------------
auth_arguments=()
auth_description=""

if [ -n "${ASC_API_KEY_BASE64:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  # altool does not take a path to the key. It searches ./private_keys,
  # ~/private_keys, ~/.private_keys and ~/.appstoreconnect/private_keys for a
  # file named exactly AuthKey_<key id>.p8, so the name is not cosmetic.
  mkdir -p "$HOME/private_keys"
  printf '%s' "$ASC_API_KEY_BASE64" | base64 --decode > "$HOME/private_keys/AuthKey_$ASC_KEY_ID.p8"
  chmod 600 "$HOME/private_keys/AuthKey_$ASC_KEY_ID.p8"
  auth_arguments=(--apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID")
  auth_description="App Store Connect API key $ASC_KEY_ID"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  auth_arguments=(--username "$APPLE_ID" --password "@env:APPLE_APP_SPECIFIC_PASSWORD")
  auth_description="Apple ID with an app-specific password"
else
  echo "::error::No App Store Connect credentials. Set either:"
  echo "::error::  ASC_API_KEY_BASE64 + ASC_KEY_ID + ASC_ISSUER_ID  (preferred), or"
  echo "::error::  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD           (fallback)"
  echo "::error::See the credential inventory in docs/developer-guide.md."
  exit 1
fi

echo "Authenticating with: $auth_description"

# --- Validate before uploading ---------------------------------------------
#
# Cheap, and it catches the whole class of rejections (missing icons, bad
# Info.plist keys, a duplicate build number) in under a minute instead of after
# a full upload. Not fatal on its own: validation has its own outages, and a
# validation failure that is really an Apple-side error should not stop a
# release. The upload rejects anything genuinely wrong anyway.
echo "Validating the .ipa..."
if xcrun altool --validate-app \
  --type ios \
  --file "$ipa_path" \
  "${auth_arguments[@]}" > "$work_dir/altool-validate.log" 2>&1; then
  echo "Validation passed."
else
  echo "::warning::Validation did not pass. Continuing to the upload, which is the authoritative check."
  cat "$work_dir/altool-validate.log"
fi

# --- Upload ----------------------------------------------------------------
#
# Retried, because Apple's delivery endpoints fail intermittently and this
# script exists precisely for days when they are unhealthy. A retry after a
# partially-succeeded upload reports the build as already present, which is
# treated as success below rather than as an error.
attempt=1
max_attempts=3
while [ "$attempt" -le "$max_attempts" ]; do
  echo "Upload attempt $attempt of $max_attempts..."
  if xcrun altool --upload-app \
    --type ios \
    --file "$ipa_path" \
    "${auth_arguments[@]}" > "$work_dir/altool-upload.log" 2>&1; then
    cat "$work_dir/altool-upload.log"
    echo "Uploaded. The build appears in TestFlight once Apple finishes processing, usually 5 to 30 minutes."
    exit 0
  fi

  upload_output="$(cat "$work_dir/altool-upload.log")"

  # An upload that reached Apple and was rejected as a duplicate means the build
  # is already there. That is the goal state, not a failure.
  if contains "$upload_output" "already exists" \
    || contains "$upload_output" "redundant" \
    || contains "$upload_output" "The bundle version must be higher"; then
    echo "$upload_output"
    echo "::warning::App Store Connect already has this build. Treating as success."
    echo "::warning::Bump ios.buildNumber in app.config.ts before the next upload."
    exit 0
  fi

  echo "$upload_output"

  # Authentication and validation failures are deterministic; retrying just
  # burns runner minutes and muddies the log.
  if contains "$upload_output" "Unable to authenticate" \
    || contains "$upload_output" "authentication failed" \
    || contains "$upload_output" "Invalid Credentials"; then
    echo "::error::Authentication failed, which will not fix itself on a retry."
    echo "::error::If App Store Connect is having an incident (check https://developer.apple.com/system-status/),"
    echo "::error::the API key path can fail while an app-specific password still works. Try the other one."
    exit 1
  fi

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "::error::Upload failed after $max_attempts attempts."
    echo "::error::The verified .ipa is attached to this run as an artifact, so a retry needs no rebuild."
    exit 1
  fi

  # Apple-side incidents last minutes, not seconds.
  echo "Retrying in 60 seconds..."
  sleep 60
  attempt=$((attempt + 1))
done
