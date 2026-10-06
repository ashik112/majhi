#!/bin/sh
# Starts majhi from this checkout, the one path `make up` and install.sh share: checks this computer,
# builds the images (from this checkout, or on top of the release images when .env sets
# MAJHI_VERSION), keeps or creates the secrets key, installs the host helper, mounts every workspace
# root from majhi.yaml and starts majhi on http://127.0.0.1:7070. Safe to run again.
#
#   sh scripts/up.sh                 (make up)
#   LAYA=off LAYA_GPU=off sh scripts/up.sh
set -eu

REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$(dirname -- "$0")/lib.sh"
cd "$REPO_DIR"

sh scripts/check.sh

# Laya gets an NVIDIA GPU when Docker can use one. LAYA_GPU=off keeps the CPU; LAYA_GPU=nvidia skips the look.
if [ "$(uname -s)" = Linux ] && [ "${LAYA:-docker}" = docker ] && [ -z "${LAYA_GPU:-}" ]; then
  LAYA_GPU=$(nvidia_gpu)
fi
compose_env

mkdir -p "$HOME/.majhi" "$HOME/.ssh"
touch "$HOME/.ssh/config" "$HOME/.ssh/known_hosts"
if [ "$MAJHI_LAYA_GPU" = nvidia ]; then
  echo "Laya gets the NVIDIA GPU: its image takes PyTorch for CUDA, a few GB more to download. LAYA_GPU=off keeps it on the CPU."
fi

# As compose reads it: the environment wins over .env.
version=${MAJHI_VERSION:-$(dotenv MAJHI_VERSION)}
if [ -n "$version" ]; then
  echo "Getting the majhi $version images"
else
  echo "Building the majhi images from this checkout. This takes a few minutes the first time"
fi
docker compose --profile runner build

# A key the keyring still holds (the host helper keeps a copy in the macOS Keychain or a Secret Service
# keyring) comes back before a new one is made. A locked keyring asks to be unlocked, so it gets a minute.
key=$MAJHI_SECRETS_KEY
if [ ! -s "$key" ]; then
  mkdir -p "$(dirname "$key")"
  chmod 700 "$(dirname "$key")"
  trap 'rm -f "$key.tmp"' EXIT
  if [ -x /usr/bin/security ] &&
    (umask 077 && /usr/bin/security find-generic-password -s "majhi secrets key" -a secrets.key -w >"$key.tmp" 2>/dev/null) &&
    grep -q '^AGE-SECRET-KEY-1' "$key.tmp"; then
    echo "Putting back the secrets key from the Keychain at $key"
  elif command -v secret-tool >/dev/null 2>&1 &&
    (umask 077 && with_timeout 60 secret-tool lookup service "majhi secrets key" account secrets.key >"$key.tmp" 2>/dev/null) &&
    grep -q '^AGE-SECRET-KEY-1' "$key.tmp"; then
    echo "Putting back the secrets key from the keyring at $key"
  else
    echo "Creating the secrets key at $key"
    (umask 077 && docker run --rm --pull never majhi-server:dev node dist/cli.js gen-key >"$key.tmp")
  fi
  chmod 600 "$key.tmp"
  mv "$key.tmp" "$key"
  trap - EXIT
fi

sh scripts/host.sh install

override=docker-compose.override.yml
trap 'rm -f "$override.tmp"' EXIT
MAJHI_SSH_PUBKEYS=$(sh scripts/host.sh pubkeys) docker compose run --rm --no-deps -T \
  -e MAJHI_SSH_PUBKEYS -e MAJHI_SSH_AGENT -e MAJHI_LAYA_GPU \
  server node dist/cli.js gen-override >"$override.tmp"
mv "$override.tmp" "$override"
trap - EXIT

docker compose up -d --wait

# Release images of other versions: what runs now was built on this version's (docs/DECISIONS.md).
if [ -n "$version" ]; then
  docker image ls --filter label=majhi.release --format '{{.Repository}}:{{.Tag}}' |
    while read -r ref; do
      case $ref in
        */*:"$version" | */*:"$version"-* | *"<none>"*) ;;
        */*) if docker image rm "$ref" >/dev/null 2>&1; then echo "Removed the old image $ref"; fi ;;
      esac
    done
fi

echo "majhi is running on http://127.0.0.1:${MAJHI_PORT:-$(dotenv MAJHI_PORT | grep . || echo 7070)}"
