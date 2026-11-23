#!/usr/bin/env bash
#
# Runs .github/scripts/verify-ios-sdk.sh against a stubbed `plutil`, so the shell
# half of the SDK floor (reading the three stamps and handing each to the right
# flag of scripts/checkIosSdk.mjs) is executed rather than grepped. plutil exists
# only on macOS.
#
# The stub answers `plutil -extract <key> raw -o - <file>` from the environment
# variable STUB_<key> (STUB_DTSDKName, STUB_DTPlatformVersion, STUB_DTXcode). An
# unset one behaves like plutil on a missing key: no output, exit 1.
#
# Usage: runSdkCheckWithStubbedPlutil.sh
# Prints the script's output; exits with the script's exit code.
#
# Driven by tests/unit/checkIosSdk.test.ts.

set -uo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT

mkdir -p "$sandbox/bin" "$sandbox/Kangentic.app"
# Only has to exist; the stub never reads it.
printf 'not a real plist' > "$sandbox/Kangentic.app/Info.plist"

cat > "$sandbox/bin/plutil" <<'STUB'
#!/usr/bin/env bash
if ! value="$(printenv "STUB_$2")"; then
  echo "Could not extract value" >&2
  exit 1
fi
printf '%s\n' "$value"
STUB
chmod +x "$sandbox/bin/plutil"

# The script calls `node scripts/checkIosSdk.mjs`, relative to the repository
# root, as it is run in the workflow.
cd "$repository_root" || exit 1
PATH="$sandbox/bin:$PATH" \
  GITHUB_STEP_SUMMARY="" \
  bash .github/scripts/verify-ios-sdk.sh "$sandbox/Kangentic.app"
