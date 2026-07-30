#!/usr/bin/env bash
# Fail unless the string-referenced web assets survived R8 resource shrinking.
#
# THE HAZARD. src/terminal/xterm.html is the raw terminal mirror, and it reaches
# the app through `require('../../terminal/xterm.html')` in
# src/components/terminal/TerminalPane.tsx. Metro files every non-drawable asset
# under res/raw, and the name is resolved from the JS BUNDLE at runtime - which
# the resource shrinker never scans. So nothing anchors it. It survives today
# only because aapt2's safe mode is conservative about res/raw, which is a
# heuristic, not a guarantee.
#
# WHY IT HAS TO BE MECHANICAL. If it were ever dropped, the Terminal pane - the
# DEFAULT view of the session screen - would render its React Native chrome
# around an empty WebView, and every check would stay green: no Maestro flow
# asserts WebView CONTENT (.maestro/paired/session-mode-toggle.yaml says so in
# its own header). A silent blank default screen is exactly the failure the rest
# of this directory exists to make loud.
#
# WHY IT MATCHES ON SIZE AND NOT ON PATH. `optimizeReleaseResources` renames
# resource files, so the shipped entry is NOT res/raw/xterm.html. A path check
# would therefore go RED ON A CORRECT BUILD, which is worse than no check.
#
# And the two artifact formats do not even agree on the path. MEASURED against
# real artifacts, both carrying byte for byte the 956707 of the source:
#
#   APK (run 30506459459)   res/JU.html                           renamed
#   AAB (run 30466715863)   base/res/raw/src_terminal_xterm.html  not renamed
#
# The AAB keeps the name because Play does the resource optimization at split
# time rather than at bundle time, and `src_terminal_xterm` is Metro's mangling
# of the source path. One size matches both; no single path does.
#
# Reading the expected size from the source file rather than hardcoding it means
# this tracks `node scripts/buildXtermHtml.mjs` regenerating the page.
#
# Deliberately "at least one", not "exactly one": asserting the COUNT would fail
# the day an unrelated HTML asset is added, which is the same brittleness as the
# path check wearing a different hat. The hazard is xterm.html going missing.
#
# Usage: verify-android-assets.sh <path-to-apk-or-aab>
set -euo pipefail

artifact_path="$1"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_asset="$repository_root/src/terminal/xterm.html"

if [ ! -f "$artifact_path" ]; then
  echo "::error::No artifact at $artifact_path"
  exit 1
fi

if [ ! -f "$source_asset" ]; then
  echo "::error::No $source_asset to compare against. Regenerate it with: node scripts/buildXtermHtml.mjs"
  exit 1
fi

# `wc -c` rather than `stat`, whose flags differ between GNU and BSD.
expected_bytes="$(wc -c < "$source_asset" | tr -d '[:space:]')"

# unzip -l prints "Length Date Time Name"; Length is the UNCOMPRESSED size, which
# is what survives the artifact being deflated.
html_entries="$(unzip -l "$artifact_path" | awk 'NF >= 4 && $NF ~ /\.html$/ { print $1 "\t" $NF }')"

if [ -z "$html_entries" ]; then
  echo "::error::The artifact carries NO .html resource at all. xterm.html was shrunk away, and the Terminal pane - the default session view - would render blank with every other check green. Fix with res/raw/keep.xml (a config plugin) or by turning enableShrinkResourcesInReleaseBuilds off in app.config.ts."
  exit 1
fi

echo "Expecting an html resource of $expected_bytes bytes (src/terminal/xterm.html)."
echo "html resources in the artifact:"
printf '%s\n' "$html_entries" | sed 's/^/  /'

# NO PIPE INTO `grep -q` HERE, and that is not a style preference.
# verify-android-signature.sh's header records the identical shape failing a
# correctly signed production AAB TWICE: `grep -q` exits the instant it matches,
# the writer upstream takes SIGPIPE while still pushing, and `set -o pipefail`
# turns a genuine match into exit 141. It survives a small local test because the
# write finishes before grep exits, which is exactly how it reached production.
# A while-read over a here-string has no writer to kill and no subshell, so
# `matched_entry_name` is still set when the loop ends.
#
# (The `unzip -l | awk` above is a different case and is fine: awk consumes its
# input to EOF, so there is no early close and nothing to receive SIGPIPE.)
matched_entry_name=""
while IFS="$(printf '\t')" read -r entry_bytes entry_name; do
  if [ "$entry_bytes" = "$expected_bytes" ]; then
    matched_entry_name="$entry_name"
  fi
done <<< "$html_entries"

if [ -n "$matched_entry_name" ]; then
  echo "xterm.html survived minification and resource shrinking (as $matched_entry_name)."
  exit 0
fi

echo "::error::The artifact carries html resources, but none is the $expected_bytes bytes of src/terminal/xterm.html. Either it was shrunk away and something else remains, or the page was regenerated without this artifact being rebuilt."
exit 1
