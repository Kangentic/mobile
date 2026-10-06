#!/usr/bin/env bash
# Fail unless R8 actually ran with OPTIMIZATION on for this release build.
#
# WHY A BUILD-OUTPUT CHECK. plugins/withAndroidR8Optimization.ts swaps the
# template's `proguard-android.txt` preset (which carries `-dontoptimize`) for
# `proguard-android-optimize.txt`, and ci.yml proves that swap reached the
# generated build.gradle. That is not the same as optimization being ON:
# ProGuard options are global, so a single `-dontoptimize` in ANY rule file -
# a library's consumer rules included - turns optimization off for the whole
# app. Play Console would then keep reporting "Optimization isn't enabled" on a
# build every other check called fine.
#
# WHAT IT READS. AGP writes the merged R8 configuration to
# android/app/build/outputs/mapping/release/configuration.txt, one section per
# input file, each introduced by a
#   # The proguard configuration file for the following section is <path>
# header. In AGP 8.12, R8Task.getProguardConfigurationOutput() is an
# @OutputFile of a @CacheableTask (read from the AGP jar), so the file is
# restored on a build-cache hit too: this cannot go red because R8 ran
# FROM-CACHE.
#
# THREE FAILURES, each its own message:
#   1. the file is missing (never pass having examined nothing);
#   2. no section comes from proguard-android-optimize.txt (the preset swap did
#      not reach R8);
#   3. any rule line is `-dontoptimize`, from any file. Comment lines such as
#      `# -dontoptimize` do not count - a real build carries one of those, in a
#      library's commented-out rules - so the match is anchored at the start of
#      the line, ignoring only leading whitespace.
#
# NO PIPE INTO `grep -q`, for the reason verify-android-assets.sh records: it
# exits on the first match, the writer takes SIGPIPE, and `set -o pipefail`
# turns a genuine match into exit 141. awk reads the file itself, to EOF.
#
# Usage: verify-r8-optimization.sh <path-to-configuration.txt>
set -euo pipefail

configuration_path="$1"

if [ ! -f "$configuration_path" ]; then
  echo "::error::No R8 configuration at $configuration_path. A minified release build always writes one next to mapping.txt; its absence means R8 never ran, or the path moved."
  exit 1
fi

optimize_sections="$(awk '
  /^# The proguard configuration file for the following section is .*proguard-android-optimize\.txt/ { count++ }
  END { print count + 0 }
' "$configuration_path")"

if [ "$optimize_sections" = "0" ]; then
  echo "::error::R8's merged configuration has no section from proguard-android-optimize.txt, so the release block still uses the -dontoptimize preset. Check plugins/withAndroidR8Optimization.ts is registered in app.config.ts and that prebuild ran."
  exit 1
fi

header_prefix="# The proguard configuration file for the following section is "
dontoptimize_sources="$(awk -v prefix="$header_prefix" '
  index($0, prefix) == 1 { section = substr($0, length(prefix) + 1); next }
  /^[[:space:]]*-dontoptimize([[:space:]]|$)/ { print "  line " NR ": " section }
' "$configuration_path")"

if [ -n "$dontoptimize_sources" ]; then
  echo "::error::A rule file still carries -dontoptimize, which turns R8 optimization off app-wide whatever the preset says:"
  printf '%s\n' "$dontoptimize_sources"
  exit 1
fi

echo "R8 optimization is on: the optimize preset reached R8 and no rule file carries -dontoptimize."
