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
  # An AAB is a jar, but jarsigner's exit code is unusable in BOTH directions
  # here, which cost a good production build once:
  #
  #  - It exits NON-zero on entirely benign warnings, even without -strict: a
  #    self-signed upload certificate ("certificate chain is invalid",
  #    "signer certificate is self-signed"), the absence of a timestamp, and a
  #    "signed in JarFile but is not signed in JarInputStream" note that AGP
  #    always produces for the BUNDLE-METADATA debug-symbol entries. A correctly
  #    signed release bundle trips all of those.
  #  - It exits ZERO on a completely unsigned jar.
  #
  # So the exit code is captured and deliberately ignored, and the verdict comes
  # from the output plus an explicit check on the signer identity.
  set +e
  verify_report="$(jarsigner -verify -verbose:summary -certs "$artifact_path" 2>&1)"
  set -e
  echo "$verify_report"

  if printf '%s' "$verify_report" | grep -qi 'jar is unsigned'; then
    echo "::error::Bundle is unsigned."
    exit 1
  fi
  if ! printf '%s' "$verify_report" | grep -qi 'jar verified'; then
    echo "::error::jarsigner did not report the bundle as verified."
    exit 1
  fi
  # The real assertion: signed by OUR key, not merely signed by something.
  if ! printf '%s' "$verify_report" | grep -q 'CN=Kangentic'; then
    echo "::error::Bundle is signed, but not by the Kangentic upload key."
    exit 1
  fi
  echo "Bundle signature verified, signed by the Kangentic upload key."
fi
