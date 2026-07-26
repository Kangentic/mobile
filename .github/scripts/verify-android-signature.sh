#!/usr/bin/env bash
# Fail unless the artifact is signed with the upload key.
#
# A build that goes green while producing an unsigned or debug-signed artifact is
# the expensive failure mode: Play rejects it, but only after a human has spent
# the upload.
#
# NO PIPES IN HERE, DELIBERATELY. An earlier version tested the verifier output
# with `printf '%s' "$report" | grep -q ...`, which failed a correctly signed
# production AAB twice. `grep -q` exits the moment it matches, the writer gets
# SIGPIPE while still pushing a multi-thousand-line report, and under
# `set -o pipefail` the pipeline reports 141. It passed against a small local test
# jar because the write finished before grep exited, so the bug only appeared on a
# real bundle. Bash pattern matching has no writer, no subshell and no exit-code
# semantics to get wrong, so it is used throughout.
#
# Usage: verify-android-signature.sh <path> <apk|aab>
set -euo pipefail

artifact_path="$1"
extension="$2"

if [ ! -f "$artifact_path" ]; then
  echo "::error::No artifact at $artifact_path"
  exit 1
fi

contains() {
  # contains <haystack> <needle>
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$extension" = "apk" ]; then
  # An APK must be judged by apksigner, not jarsigner: modern AGP signs APKs with
  # the v2/v3 schemes and no v1 jar signature, so jarsigner reports a perfectly
  # valid APK as "jar is unsigned".
  build_tools_dir="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)"
  set +e
  signer_report="$("$build_tools_dir/apksigner" verify --print-certs "$artifact_path" 2>&1)"
  set -e
  echo "$signer_report"

  if contains "$signer_report" 'CN=Android Debug'; then
    echo "::error::Artifact is signed with the Android debug key, not the upload key."
    exit 1
  fi
  if ! contains "$signer_report" 'CN=Kangentic'; then
    echo "::error::Artifact is not signed by the Kangentic upload key."
    exit 1
  fi
  echo "APK signature verified, signed by the Kangentic upload key."
else
  # An AAB is jar-signed, so jarsigner is right here. Its exit code, however, is
  # unusable in BOTH directions and is deliberately ignored:
  #
  #  - NON-zero on entirely benign warnings, even without -strict: a self-signed
  #    upload certificate, no timestamp, POSIX permission attributes, and a
  #    "signed in JarFile but is not signed in JarInputStream" note that AGP
  #    always produces for the BUNDLE-METADATA debug-symbol entries. A correct
  #    release bundle trips all of those.
  #  - ZERO on a completely unsigned jar.
  set +e
  verify_report="$(jarsigner -verify -verbose:summary -certs "$artifact_path" 2>&1)"
  set -e

  # Only the verdict lines, not the full per-entry listing: the whole report is
  # thousands of lines and drowns the log.
  echo "--- jarsigner verdict ---"
  case "$verify_report" in
    *"jar verified."*) echo "jar verified." ;;
    *"jar is unsigned."*) echo "jar is unsigned." ;;
    *) echo "(no recognisable verdict line)" ;;
  esac

  if contains "$verify_report" 'jar is unsigned'; then
    echo "::error::Bundle is unsigned."
    exit 1
  fi
  if ! contains "$verify_report" 'jar verified'; then
    echo "::error::jarsigner did not report the bundle as verified."
    exit 1
  fi
  # The real assertion: signed by OUR key, not merely signed by something.
  if ! contains "$verify_report" 'CN=Kangentic'; then
    echo "::error::Bundle is signed, but not by the Kangentic upload key."
    exit 1
  fi
  echo "Bundle signature verified, signed by the Kangentic upload key."
fi
