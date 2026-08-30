#!/usr/bin/env bash
#
# Installs the iOS distribution certificate and provisioning profile onto a
# macOS runner, then reports the profile's metadata so nothing about the Apple
# team has to be committed.
#
# Usage: install-ios-signing.sh <cert.p12> <cert-password> <profile.mobileprovision>
#                               [<nse-profile.mobileprovision>]
#
# The fourth argument is the Notification Service Extension's own profile. An
# app extension is a separate bundle id and needs its own; without it the
# archive fails on the extension target rather than producing an app that
# merely lacks the feature.
#
# Writes to $GITHUB_OUTPUT when set: keychain-path, profile-uuid, profile-name,
# team-id, bundle-id, keychain-access-group, and nse-profile-uuid / nse-bundle-id
# when a fourth argument is given.
#
# ---------------------------------------------------------------------------
# LOGGING RULE, load bearing: this repository is public, so every Actions log
# is public. `security find-identity` and `codesign -dvv` both print the
# certificate's common name, which for an individual Apple Developer account is
# a person's legal name. Never echo their raw output. Test the text with a
# `case` match and print only a verdict. See .claude/rules/no-personal-info.md.
# ---------------------------------------------------------------------------

set -euo pipefail

certificate_path="${1:?usage: install-ios-signing.sh <cert.p12> <cert-password> <profile.mobileprovision>}"
certificate_password="${2:?missing certificate password}"
profile_path="${3:?missing provisioning profile path}"
nse_profile_path="${4:-}"

work_dir="${RUNNER_TEMP:-/tmp}"

contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Certificate into a throwaway keychain ---------------------------------
#
# A dedicated keychain rather than the login one: it is deleted with the runner,
# it needs no interactive unlock, and it cannot pick up a stale identity from a
# cached image.
keychain_path="$work_dir/kangentic-signing.keychain-db"
keychain_password="$(openssl rand -hex 24)"

security create-keychain -p "$keychain_password" "$keychain_path"
# -lut 3600: no auto-lock on idle for an hour. A keychain that relocks
# mid-archive fails with "User interaction is not allowed", which reads like a
# certificate problem and is not one.
security set-keychain-settings -lut 3600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"

security import "$certificate_path" \
  -k "$keychain_path" \
  -P "$certificate_password" \
  -A \
  -t cert \
  -f pkcs12

# Grants codesign non-interactive access to the private key. Redundant with -A
# above on current macOS, kept because its absence is the single most common
# cause of "User interaction is not allowed" in CI and it costs nothing.
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$keychain_password" \
  "$keychain_path" > /dev/null

# Prepend rather than replace: dropping the login keychain from the search list
# breaks unrelated tooling that expects the system roots to be reachable.
existing_keychains="$(security list-keychains -d user | tr -d '"' | tr -d ' ')"
# shellcheck disable=SC2086
security list-keychains -d user -s "$keychain_path" $existing_keychains

# Guard: the wrong certificate type is a silent failure until export. A
# development certificate cannot sign for the App Store, and the error it
# eventually produces does not name the cause.
#
# There are two valid App Store certificate types and Apple has never retired
# either: the newer unified "Apple Distribution" and the older iOS-only "iPhone
# Distribution". `eas credentials` issues the latter, so matching only on the
# newer name rejects a perfectly good certificate. Both are accepted here;
# anything containing Development or Developer ID is not.
#
# Written to a file and grepped without a pipe on purpose. `grep -m1` or `grep
# -q` reading from a pipe exits as soon as it matches, the writer takes SIGPIPE,
# and under `set -o pipefail` the whole pipeline reports 141. That bug already
# cost this repository two rounds in verify-android-signature.sh, and it hides
# behind small inputs: it only fires once the writer is slow enough to still be
# writing when the reader leaves.
identities_path="$work_dir/codesigning-identities.txt"
security find-identity -v -p codesigning "$keychain_path" > "$identities_path"
identity_line="$(grep -m1 -E '"(Apple|iPhone) Distribution: ' "$identities_path" || true)"

signing_identity=""
certificate_type=""
# Each line looks like:   1) <40 hex SHA-1> "iPhone Distribution: Name (TEAMID)"
if [[ "$identity_line" =~ ([0-9A-F]{40})[[:space:]]+\"([^:]+): ]]; then
  signing_identity="${BASH_REMATCH[1]}"
  certificate_type="${BASH_REMATCH[2]}"
fi

if [ -z "$signing_identity" ]; then
  echo "::error::No App Store distribution identity in the imported certificate."
  echo "::error::Expected an \"Apple Distribution\" or \"iPhone Distribution\" certificate."
  echo "::error::IOS_DIST_CERT_BASE64 is probably a development certificate."
  # Deliberately reporting only the count. Every identity line carries the
  # certificate common name, which is a personal name on an individual account,
  # and this log is public.
  echo "Imported codesigning identities: $(grep -c ')' "$identities_path" || true)"
  exit 1
fi

# Downstream steps sign against the SHA-1 rather than the certificate name.
# It is unambiguous, it works for either certificate type without matching on a
# name, and unlike the name it contains no personal information.
echo "Imported a \"$certificate_type\" codesigning identity."

# --- Provisioning profile --------------------------------------------------
#
# Decoded first so its metadata can be read. Everything downstream is derived
# from the profile rather than hardcoded: the team id and team name must not be
# committed (no-personal-info.md), and the profile name embeds a regenerating
# timestamp, so a literal would break every time EAS reissues it.
profile_plist="$work_dir/profile.plist"
security cms -D -i "$profile_path" > "$profile_plist"

read_profile_field() {
  plutil -extract "$1" raw -o - "$profile_plist"
}

read_field_from() {
  plutil -extract "$2" raw -o - "$1"
}

# --- Shared Keychain group guard -------------------------------------------
#
# The app writes the push decrypt key into a shared Keychain access group and
# the Notification Service Extension reads it back out. BOTH profiles have to
# authorise that group, and a profile minted before the group was added to the
# App ID does not.
#
# This is checked rather than assumed because the runtime failure is silent:
# the extension launches, the Keychain query returns errSecItemNotFound, and
# every notification falls back to the generic placeholder - which is
# indistinguishable from an extension that was never installed at all. There is
# no crash, no log, and no failing gate anywhere downstream.
profile_authorises_shared_group() {
  groups_json="$(plutil -extract Entitlements.keychain-access-groups json -o - "$1" 2>/dev/null || echo '[]')"
  # An exact grant, or the "<team id>.*" wildcard a wildcard App ID carries.
  if contains "$groups_json" "$2"; then
    return 0
  fi
  if contains "$groups_json" "$3.*"; then
    return 0
  fi
  return 1
}

profile_uuid="$(read_profile_field UUID)"
profile_name="$(read_profile_field Name)"
team_id="$(read_profile_field TeamIdentifier.0)"
application_identifier="$(read_profile_field Entitlements.application-identifier)"
# The entitlement is "<team id>.<bundle id>".
bundle_id="${application_identifier#"$team_id".}"

# Guard: a development profile would archive and export, then be rejected on
# upload. get-task-allow true is what distinguishes one.
task_allow="$(read_profile_field Entitlements.get-task-allow 2>/dev/null || echo absent)"
if [ "$task_allow" = "true" ]; then
  echo "::error::This provisioning profile has get-task-allow=true, so it is a development profile."
  echo "::error::App Store distribution needs a distribution profile. Re-export IOS_PROVISIONING_PROFILE_BASE64."
  exit 1
fi

# Xcode 16 moved the directory it reads profiles from, and which one is
# authoritative varies by version. Writing both is a two-line insurance policy
# against a whole failed run, and a stray copy on an ephemeral runner costs
# nothing.
for profiles_dir in \
  "$HOME/Library/MobileDevice/Provisioning Profiles" \
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
  mkdir -p "$profiles_dir"
  # Xcode locates a profile by filename, which must be "<UUID>.mobileprovision".
  cp "$profile_path" "$profiles_dir/$profile_uuid.mobileprovision"
done

shared_keychain_group="$team_id.$bundle_id.shared"

if ! profile_authorises_shared_group "$profile_plist" "$shared_keychain_group" "$team_id"; then
  echo "::error::The app provisioning profile does not authorise the shared Keychain group $shared_keychain_group."
  echo "::error::Add the Keychain Sharing group \"$bundle_id.shared\" to the $bundle_id App ID, regenerate the"
  echo "::error::distribution profile, and update IOS_PROVISIONING_PROFILE_BASE64."
  echo "::error::Without it the app cannot write the push key where the Notification Service Extension can read it,"
  echo "::error::and every iOS notification silently shows the generic placeholder."
  exit 1
fi
echo "The app profile authorises the shared Keychain group."

# --- Notification Service Extension profile --------------------------------
#
# Optional argument, but not optional in practice for a device build: the
# extension is its own bundle id, and withIosManualSigning leaves its target on
# automatic signing without this, which fails the archive.
nse_profile_uuid=""
nse_bundle_id=""
if [ -n "$nse_profile_path" ]; then
  nse_profile_plist="$work_dir/nse-profile.plist"
  security cms -D -i "$nse_profile_path" > "$nse_profile_plist"

  nse_profile_uuid="$(read_field_from "$nse_profile_plist" UUID)"
  nse_team_id="$(read_field_from "$nse_profile_plist" TeamIdentifier.0)"
  nse_application_identifier="$(read_field_from "$nse_profile_plist" Entitlements.application-identifier)"
  nse_bundle_id="${nse_application_identifier#"$nse_team_id".}"

  if [ "$nse_team_id" != "$team_id" ]; then
    echo "::error::The extension profile belongs to team $nse_team_id but the app profile belongs to $team_id."
    echo "::error::A shared Keychain group only works within one team."
    exit 1
  fi

  # Guard against the two profiles being swapped, which would otherwise archive
  # and then fail at export with a confusing bundle-id mismatch.
  if [ "$nse_bundle_id" != "$bundle_id.nse" ]; then
    echo "::error::Expected the extension profile to be for $bundle_id.nse but it is for $nse_bundle_id."
    echo "::error::IOS_NSE_PROVISIONING_PROFILE_BASE64 is probably the app profile, or the wrong App ID."
    exit 1
  fi

  nse_task_allow="$(read_field_from "$nse_profile_plist" Entitlements.get-task-allow 2>/dev/null || echo absent)"
  if [ "$nse_task_allow" = "true" ]; then
    echo "::error::The extension provisioning profile has get-task-allow=true, so it is a development profile."
    exit 1
  fi

  if ! profile_authorises_shared_group "$nse_profile_plist" "$shared_keychain_group" "$team_id"; then
    echo "::error::The extension provisioning profile does not authorise the shared Keychain group $shared_keychain_group."
    echo "::error::Add the Keychain Sharing group \"$bundle_id.shared\" to the $nse_bundle_id App ID and regenerate it."
    exit 1
  fi

  for profiles_dir in \
    "$HOME/Library/MobileDevice/Provisioning Profiles" \
    "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
    mkdir -p "$profiles_dir"
    cp "$nse_profile_path" "$profiles_dir/$nse_profile_uuid.mobileprovision"
  done

  echo "Installed extension profile $nse_profile_uuid for $nse_bundle_id."
else
  echo "::warning::No Notification Service Extension profile was supplied. The archive will fail on the extension target."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "keychain-path=$keychain_path"
    echo "signing-identity=$signing_identity"
    echo "certificate-type=$certificate_type"
    echo "profile-uuid=$profile_uuid"
    echo "profile-name=$profile_name"
    echo "team-id=$team_id"
    echo "bundle-id=$bundle_id"
    echo "keychain-access-group=$shared_keychain_group"
    echo "nse-profile-uuid=$nse_profile_uuid"
    echo "nse-bundle-id=$nse_bundle_id"
  } >> "$GITHUB_OUTPUT"
fi

# Team id and bundle id are public identifiers that ship inside the app's own
# entitlements, so they are fine to log. TeamName is not, and is never read.
echo "Installed profile $profile_uuid for $bundle_id (team $team_id)."

# Expiry warning. A provisioning profile expires on its own schedule, and the
# archive failure it eventually causes is a generic signing error that names
# neither expiry nor the profile. Better to see it coming for a month than to
# debug it under release pressure. Not fatal: an expired profile fails the archive
# anyway, and failing early on a still-valid one would be worse than the warning.
expiration_date="$(read_profile_field ExpirationDate)"
echo "Profile expires $expiration_date."

expires_at_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$expiration_date" '+%s' 2>/dev/null || echo '')"
if [ -n "$expires_at_epoch" ]; then
  days_remaining=$(( (expires_at_epoch - $(date '+%s')) / 86400 ))
  echo "Days until the profile expires: $days_remaining"
  if [ "$days_remaining" -lt 30 ]; then
    echo "::warning::The provisioning profile expires in $days_remaining days. Regenerate it with \`eas credentials\` and update IOS_PROVISIONING_PROFILE_BASE64 before it lapses."
  fi
fi
