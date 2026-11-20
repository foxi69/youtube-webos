#!/usr/bin/env bash
# Prints the release notes for one version: .github/release-notes.md with
# @VERSION@ filled in, and that version's CHANGELOG.md section in place of
# @CHANGELOG@. The section's opening paragraph becomes a quote, and every
# heading goes one level down and gets an icon. When the template has
# @SUMMARY@, that opening paragraph takes its place instead, as plain text
# (each paragraph a line), and @CHANGELOG@ starts at the first heading:
# GitHub's feed shows the first text of the notes, and the summary is what
# tells this release apart. A line holding @SUMMARY@ goes when there is none.
#
# Used by the Draft release workflow, and by hand to redo the notes of a
# published release:
#   bash tools/release-notes.sh 0.8.7 > notes.md
#   gh release edit v0.8.7 --notes-file notes.md
#
# Usage: tools/release-notes.sh <version> [commit]
set -euo pipefail

version="${1:?usage: tools/release-notes.sh <version> [commit]}"
commit="${2:-}"
cd "$(dirname "$0")/.."

changes="$(mktemp)"
summary="$(mktemp)"
trap 'rm -f "$changes" "$summary"' EXIT

# awk reads the file itself: it stops at the end of the section, and a pipe
# feeding it would then fail with "Broken pipe" under pipefail.
awk -v v="$version" -v sf="$summary" '
  { sub(/\r$/, "") }
  index($0, "## [" v "]") == 1 { on = 1; next }
  on && /^## \[/ { exit }
  !on { next }
  /^#+ / {
    if (!heading && started) print ""
    heading = 1
    $0 = "#" $0
    if ($0 ~ /^### (Added|New Features)$/) sub(/^### /, "### ✨ ")
    else if ($0 ~ /^### Fix/) sub(/^### /, "### 🐛 ")
    else if ($0 ~ /^### Chang/) sub(/^### /, "### 🔧 ")
    else if ($0 ~ /^### Perf/) sub(/^### /, "### ⚡ ")
    else if ($0 ~ /^### Known/) sub(/^### /, "### ⚠️ ")
    else if ($0 ~ /^### Tests/) sub(/^### /, "### 🧪 ")
    else if ($0 ~ /^### /) sub(/^### /, "### 📌 ")
    print; next
  }
  # The summary above the first heading, as a quote; also to its own file,
  # a paragraph a line, for @SUMMARY@.
  !heading {
    if ($0 == "") { if (started) gap = 1; next }
    if (gap) { print ">"; printf "\n" > sf } else if (started) printf " " > sf
    gap = 0; started = 1; print "> " $0; printf "%s", $0 > sf; next
  }
  { print }
' CHANGELOG.md > "$changes"

# A draft of the next version can come before its changelog section.
if [ ! -s "$changes" ]; then
  echo "CHANGELOG.md has no section for $version" >&2
  echo "_No CHANGELOG.md section for $version yet._" > "$changes"
fi

# With @SUMMARY@ in the template, the quote and the empty line after it leave the section.
if grep -q '@SUMMARY@' .github/release-notes.md; then
  awk 'lead && /^>/ { next } lead && /^$/ { lead = 0; next } { lead = 0; print }' lead=1 "$changes" > "$changes.cut"
  mv "$changes.cut" "$changes"
fi

tr -d '\r' < .github/release-notes.md | sed "s/@VERSION@/$version/g" |
  awk -v f="$changes" -v sf="$summary" '
    BEGIN { while ((getline l < sf) > 0) text = text (n++ ? "\n\n" : "") l }
    $0 == "@CHANGELOG@" { while ((getline l < f) > 0) print l; next }
    # By position, not sub(): an "&" in the summary stays an "&".
    /@SUMMARY@/ { if (text == "") next; i = index($0, "@SUMMARY@"); $0 = substr($0, 1, i - 1) text substr($0, i + 9) }
    { print }'

# A refreshed pre-release keeps its version: the commit tells its builds
# apart, and the settings panel heading shows the same one.
if [ -n "$commit" ]; then
  echo
  echo "**Build:** \`$commit\` (the settings panel heading shows it too: \"YouTube Foxtended $version ($commit)\")"
fi
