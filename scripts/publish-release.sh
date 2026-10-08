#!/bin/sh
# Sends only runtime assets and distribution files to the public repository.
# The release job supplies a deploy key for that repository through GIT_SSH_COMMAND.
set -eu
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
version=${1:?Usage: publish-release.sh version commit assets-directory}
commit=${2:?A source commit is required}
assets=${3:?An assets directory is required}
printf '%s\n' "$version" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'
printf '%s\n' "$commit" | grep -qE '^[0-9a-f]{40,64}$'
assets=$(CDPATH='' cd -- "$assets" && pwd)
[ "$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$assets/release.json")" = "$version" ]
[ "$(sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' "$assets/release.json")" = "$commit" ]
destination=${MAJHI_DISTRIBUTION_GIT_URL:-git@github.com:${MAJHI_DISTRIBUTION_REPO:?A distribution repository is required}.git}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
git -c core.hooksPath=/dev/null clone --quiet "$destination" "$stage/public"
cd "$stage/public"
git config user.name 'majhi releases'
git config user.email 'releases@majhi.invalid'
git config core.hooksPath /dev/null
git config commit.gpgsign false
# Repeated publishing is safe, and a version can never be reused for another source commit.
if git rev-parse --quiet --verify "refs/tags/$version" >/dev/null; then
  recorded=$(git show "$version:runtime/release.json" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')
  [ "$recorded" = "$commit" ] || { echo "$version already names another source commit" >&2; exit 1; }
  echo "$version is already published to the distribution repository"
  exit 0
fi
mkdir -p runtime .github/workflows
cp "$assets/majhi-runtime.tar.gz" "$assets/majhi-runtime.tar.gz.sha256" "$assets/release.json" runtime/
cp "$repo/install.sh" "$repo/LICENSE" ./
cp "$repo/distribution/README.md" README.md
cp "$repo/distribution/release.yml" .github/workflows/release.yml
git add -- runtime install.sh LICENSE README.md .github/workflows/release.yml
git commit --quiet -m "release: $version"
git -c tag.gpgsign=false tag "$version"
# Both refs move together, so the tag's workflow has the installer and runtime package.
git push --atomic origin HEAD:main "refs/tags/$version"
