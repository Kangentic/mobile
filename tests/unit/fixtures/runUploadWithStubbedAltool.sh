#!/usr/bin/env bash
#
# Runs .github/scripts/upload-ios-testflight.sh against a stubbed `xcrun` so its
# success/failure decisions can be asserted for real, rather than by grepping the
# script's source.
#
# That distinction earned its keep: the first version of the upload script treated
# "The bundle version must be higher" as success, which would have reported a
# rejected upload as a completed release. A text assertion would not have caught
# it, because the string was present and in the right file.
#
# Usage: runUploadWithStubbedAltool.sh <altool stdout text> <altool exit code>
# Prints the script's output; exits with the script's exit code.
#
# Driven by tests/unit/iosTestflightUpload.test.ts.

set -uo pipefail

altool_output="${1:?usage: runUploadWithStubbedAltool.sh <output> <exit code>}"
altool_exit="${2:?missing altool exit code}"

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT

# The stub stands in for the real `xcrun`. --validate-app always succeeds so a
# test exercises only the upload branch; --upload-app replays the fixture.
mkdir -p "$sandbox/bin"
cat > "$sandbox/bin/xcrun" <<STUB
#!/usr/bin/env bash
for argument in "\$@"; do
  if [ "\$argument" = "--validate-app" ]; then
    echo "stub: validation passed"
    exit 0
  fi
done
printf '%s\n' "\$ALTOOL_OUTPUT"
exit "\$ALTOOL_EXIT"
STUB
chmod +x "$sandbox/bin/xcrun"

# A file only has to exist; the stub never reads it.
printf 'not a real ipa' > "$sandbox/Kangentic.ipa"

# Credentials are supplied unless a test explicitly asks for the no-credentials
# path. Set rather than defaulted, so a test clearing APPLE_ID cannot be silently
# overridden back to a working value and pass for the wrong reason.
stub_apple_id="tester@example.com"
stub_apple_password="stub-password"
if [ -n "${KANGENTIC_TEST_WITHOUT_CREDENTIALS:-}" ]; then
  stub_apple_id=""
  stub_apple_password=""
fi

PATH="$sandbox/bin:$PATH" \
  ALTOOL_OUTPUT="$altool_output" \
  ALTOOL_EXIT="$altool_exit" \
  RUNNER_TEMP="$sandbox" \
  HOME="$sandbox" \
  GITHUB_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}" \
  UPLOAD_RETRY_DELAY_SECONDS=0 \
  ASC_API_KEY_BASE64="" \
  ASC_KEY_ID="" \
  ASC_ISSUER_ID="" \
  APPLE_ID="$stub_apple_id" \
  APPLE_APP_SPECIFIC_PASSWORD="$stub_apple_password" \
  bash "$repository_root/.github/scripts/upload-ios-testflight.sh" "$sandbox/Kangentic.ipa"
