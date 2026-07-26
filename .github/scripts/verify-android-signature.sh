#!/usr/bin/env bash
# Fail unless the artifact is signed with the upload key.
#
# A build that goes green while producing an unsigned or debug-signed artifact is
# the expensive failure mode: Play rejects it, but only after a human has spent
# the upload. Neither verifier's exit code is sufficient on its own, so this
# reads their output.
#
# Usage: verify-android-signature.sh <path> <apk|aab>
set -euo pipefail

artifact_path="$1"
extension="$2"

if [ ! -f "$artifact_path" ]; then
  echo "::error::No artifact at $artifact_path"
  exit 1
fi

if [ "$extension" = "apk" ]; then
  build_tools_dir="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)"
  signer_report="$("$build_tools_dir/apksigner" verify --print-certs "$artifact_path")"
  echo "$signer_report"
  if printf '%s' "$signer_report" | grep -qi 'CN=Android Debug'; then
    echo "::error::Artifact is signed with the Android debug key, not the upload key."
    exit 1
  fi
  if ! printf '%s' "$signer_report" | grep -qi 'CN=Kangentic'; then
    echo "::error::Artifact is not signed by the Kangentic upload key."
    exit 1
  fi
  echo "APK signature verified."
else
  # An AAB is a jar. -strict is deliberately omitted: a self-signed upload
  # certificate always raises a chain warning and would make -strict exit
  # non-zero on a perfectly good bundle. jarsigner also exits 0 on a completely
  # unsigned jar, so the exit code proves nothing and the output must be read
  # both ways.
  verify_report="$(jarsigner -verify -verbose:summary "$artifact_path")"
  echo "$verify_report"
  if printf '%s' "$verify_report" | grep -qi 'jar is unsigned'; then
    echo "::error::Bundle is unsigned."
    exit 1
  fi
  if ! printf '%s' "$verify_report" | grep -qi 'jar verified'; then
    echo "::error::Could not confirm the bundle signature."
    exit 1
  fi
  echo "Bundle signature verified."
fi
