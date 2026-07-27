#!/usr/bin/env bash
#
# Resolves the CocoaPods workspace and the app scheme inside it, and writes
# workspace= and scheme= to $GITHUB_OUTPUT.
#
# Shared by both jobs in .github/workflows/build-ios.yml so the simulator and
# device paths can never disagree about what they are building.
#
# Why this is not a one-liner: the first version of the iOS workflow took
# schemes[0] from `xcodebuild -list -json`. That list is alphabetical and full of
# CocoaPods schemes, so it picked EXApplication (a dependency of
# expo-application) and "succeeded" in three minutes without compiling a single
# line of app code. An xcodebuild exit code proves that something built, not
# that the right thing built.

set -euo pipefail

workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' | head -n 1)"
if [ -z "$workspace" ]; then
  echo "::error::No .xcworkspace under ios/. Did pod install run?"
  exit 1
fi

# expo prebuild names the Xcode project after the app, and CocoaPods names the
# workspace after the project, so the app scheme is the workspace basename.
scheme="$(basename "$workspace" .xcworkspace)"

xcodebuild -list -json -workspace "$workspace" > "${RUNNER_TEMP:-/tmp}/schemes.json"
scheme_present="$(node -e "
  const workspaceInfo = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(workspaceInfo.workspace.schemes.includes(process.argv[2]) ? 'yes' : 'no');
" "${RUNNER_TEMP:-/tmp}/schemes.json" "$scheme")"

if [ "$scheme_present" != "yes" ]; then
  echo "::error::Scheme \"$scheme\" is not in $workspace. Available schemes follow."
  cat "${RUNNER_TEMP:-/tmp}/schemes.json"
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "workspace=$workspace"
    echo "scheme=$scheme"
  } >> "$GITHUB_OUTPUT"
fi

echo "Building app scheme \"$scheme\" from $workspace."
