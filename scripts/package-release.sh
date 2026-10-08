#!/bin/sh
# Builds the runtime-only archive uploaded with a release. No app sources or Git metadata.
set -eu
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
version=${1:?Usage: package-release.sh vX.Y.Z commit output-directory}
commit=${2:?A commit is required}
out=${3:?An output directory is required}
printf '%s\n' "$version" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$' || exit 1
printf '%s\n' "$commit" | grep -qE '^[0-9a-f]{40,64}$' || exit 1
mkdir -p "$out"
out=$(CDPATH='' cd -- "$out" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/docker" "$stage/scripts"
cp "$repo/docker/release/Dockerfile" "$stage/Dockerfile"
cp "$repo/docker/release/laya.Dockerfile" "$stage/docker/laya.Dockerfile"
cp "$repo/docker/owner.sh" "$stage/docker/owner.sh"
cp "$repo/docker-compose.yml" "$repo/install.sh" "$repo/LICENSE" "$stage/"
for file in check compose host lib up; do cp "$repo/scripts/$file.sh" "$stage/scripts/"; done
printf '{"version":"%s","commit":"%s"}\n' "$version" "$commit" >"$stage/release.json"
COPYFILE_DISABLE=1 tar -czf "$out/majhi-runtime.tar.gz" -C "$stage" \
  Dockerfile docker-compose.yml docker/owner.sh docker/laya.Dockerfile \
  scripts/check.sh scripts/compose.sh scripts/host.sh scripts/lib.sh scripts/up.sh \
  install.sh LICENSE release.json
cp "$stage/release.json" "$out/release.json"
(cd "$out" && if command -v sha256sum >/dev/null 2>&1; then
  sha256sum majhi-runtime.tar.gz
else
  shasum -a 256 majhi-runtime.tar.gz
fi) >"$out/majhi-runtime.tar.gz.sha256"
