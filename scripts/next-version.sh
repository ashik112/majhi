#!/bin/sh
# The next majhi release, from the conventional commits since the last one (docs/DECISIONS.md,
# "Automated releases"): a breaking change (`type!:` or a `BREAKING CHANGE:` footer) bumps the
# major, `feat` the minor, `fix` or `perf` the patch. Other types alone (docs, chore, test, ci,
# refactor, style, build) release nothing. Merge commits are skipped: the commits they bring count.
# The release workflow runs it on every push to main.
#
#   sh scripts/next-version.sh          prints vX.Y.Z, or nothing when nothing calls for a release
#   sh scripts/next-version.sh notes    prints the release notes, in markdown
set -eu

TYPE='^[a-z]+(\([^)]*\))?'
BREAKING="$TYPE!: "
FEAT='^feat(\([^)]*\))?: '
FIX='^(fix|perf)(\([^)]*\))?: '
FOOTER='^BREAKING[ -]CHANGE: '

# The last release: the highest vX.Y.Z tag this commit contains. None before the first release.
last=$(git tag --merged HEAD --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
range=${last:+$last..}HEAD

subjects() {
  git log --no-merges --format='%s' "$range"
}

# Commits whose message has a BREAKING CHANGE footer, as `subject (hash)`.
footers() {
  git log --no-merges -E --grep="$FOOTER" --format='%s (%h)' "$range"
}

next_version() {
  if subjects | grep -qE "$BREAKING" || [ -n "$(footers)" ]; then
    bump=major
  elif subjects | grep -qE "$FEAT"; then
    bump=minor
  elif subjects | grep -qE "$FIX"; then
    bump=patch
  else
    return 0
  fi
  rest=${last:-v0.0.0}
  rest=${rest#v}
  major=${rest%%.*}
  rest=${rest#*.}
  minor=${rest%%.*}
  patch=${rest#*.}
  case $bump in
    major) echo "v$((major + 1)).0.0" ;;
    minor) echo "v$major.$((minor + 1)).0" ;;
    patch) echo "v$major.$minor.$((patch + 1))" ;;
  esac
}

# `type(scope)!: summary (hash)` lines as `- scope: summary (hash)`.
tidy() {
  # Unscoped first: once a scope is in front, it would look like a type.
  sed -E 's/^[a-z]+!?: //; s/^[a-z]+\(([^)]*)\)!?: /\1: /; s/^/- /'
}

# Heading $1 over the commits in the range whose subject matches $2. Nothing when none does.
section() {
  lines=$(git log --no-merges --format='%s (%h)' "$range" | grep -E "$2" | tidy || true)
  if [ -n "$lines" ]; then printf '### %s\n\n%s\n\n' "$1" "$lines"; fi
}

notes() {
  if [ -z "$last" ]; then
    echo "The first release of majhi."
    return 0
  fi
  section "Breaking changes" "$BREAKING"
  # A breaking change named only in the message's footer, not with `!` in the subject.
  footer_lines=$(footers | grep -vE "$BREAKING" | tidy || true)
  if [ -n "$footer_lines" ]; then printf '### Breaking changes (in the commit message)\n\n%s\n\n' "$footer_lines"; fi
  section "Features" "$FEAT"
  section "Fixes" "$FIX"
}

case "${1:-version}" in
  version) next_version ;;
  notes) notes ;;
  *)
    echo "Usage: sh scripts/next-version.sh [notes]" >&2
    exit 2
    ;;
esac
