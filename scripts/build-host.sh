#!/bin/sh
# Builds the host helper (apps/host, Go) into apps/host/dist, one binary per target, named
# majhi-host-<os>-<arch> (.exe on Windows). With no arguments it builds for this computer. The image
# build does the same for every target (Dockerfile, stage host-build).
#
#   sh scripts/build-host.sh [--contract] [os/arch ...]
#   for example: sh scripts/build-host.sh darwin/arm64 linux/amd64
#
# --contract builds the helper over a fake platform instead (cmd/contract, dist/contract-<os>-<arch>),
# which the contract test runs (apps/server/src/host/contract.test.ts). It is never shipped.
#
# Go runs in a container (the image named by GO_IMAGE in the Dockerfile), so nothing but Docker is
# needed. A module cache volume (majhi-gocache) keeps repeated builds quick.
set -eu

REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GO_IMAGE=${GO_IMAGE:-$(sed -n 's/^ARG GO_IMAGE=//p' "$REPO_DIR/Dockerfile" | head -n 1)}

host_target() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "build-host: no default target on this OS; name one, like linux/amd64" >&2; exit 2 ;;
  esac
  case $(uname -m) in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=amd64 ;;
    *) echo "build-host: unknown CPU $(uname -m)" >&2; exit 2 ;;
  esac
  printf '%s/%s' "$os" "$arch"
}

package=.
name=majhi-host
if [ "${1:-}" = "--contract" ]; then
  package=./cmd/contract
  name=contract
  shift
fi
if [ "$#" -eq 0 ]; then set -- "$(host_target)"; fi
mkdir -p "$REPO_DIR/apps/host/dist"

for target in "$@"; do
  os=${target%/*}
  arch=${target#*/}
  ext=""
  if [ "$os" = windows ]; then ext=.exe; fi
  docker run --rm \
    -v "$REPO_DIR/apps/host":/src -v majhi-gocache:/go \
    -e GOCACHE=/go/.cache -e CGO_ENABLED=0 -e GOOS="$os" -e GOARCH="$arch" -e GOFLAGS=-buildvcs=false \
    -w /src "$GO_IMAGE" \
    go build -trimpath -ldflags="-s -w" -o "dist/$name-$os-$arch$ext" "$package"
  echo "built apps/host/dist/$name-$os-$arch$ext"
done
