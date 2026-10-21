#!/bin/sh
# Installs or removes the majhi host helper: one small program (Go, no runtime
# to install) on this machine that lists folders for the folder browser and
# remounts workspace roots when they change (SPEC 4.2). On macOS it runs as a
# LaunchAgent. On Linux and WSL2 it runs as the systemd user unit
# majhi-host.service, next to majhi-ssh-agent.service, majhi's own SSH agent.
# `make up` installs it and `make down` removes it.
#
#   sh scripts/host.sh install | uninstall | pubkeys
#
# The service file itself is written by the helper (`majhi-host install-service`, apps/host/internal/service).
# MAJHI_HOST_LABEL and MAJHI_LAUNCH_AGENTS_DIR change the LaunchAgent label
# and folder, and MAJHI_SYSTEMD_USER_DIR the folder of the units, so tests
# never touch the real ones. MAJHI_HOST_IMAGE names the image the helper is
# copied out of, for the same reason.
set -eu

. "$(dirname -- "$0")/lib.sh"

LABEL="${MAJHI_HOST_LABEL:-dev.majhi.host}"
AGENTS_DIR="${MAJHI_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"
UNIT_DIR="${MAJHI_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
HOST_UNIT="majhi-host.service"
AGENT_UNIT="majhi-ssh-agent.service"
ENV_FILE="$UNIT_DIR/majhi-host.env"
MAJHI_DIR="$HOME/.majhi"
BIN="$MAJHI_DIR/bin/majhi-host"
# What an install before the Go helper left behind: a bundle that needed Node.
OLD_BUNDLE="$MAJHI_DIR/bin/majhi-host.mjs"
LOG_DIR="$MAJHI_DIR/logs"
IMAGE="${MAJHI_HOST_IMAGE:-majhi-server:dev}"
REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
say() {
  printf 'host helper: %s\n' "$*"
}

# The name of the helper in the image for this computer: majhi-host-<os>-<cpu>.
helper_name() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) return 1 ;;
  esac
  case $(uname -m) in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=amd64 ;;
    *) return 1 ;;
  esac
  printf 'majhi-host-%s-%s' "$os" "$arch"
}

# Copies the helper for this computer out of the image `make up` just built. On macOS it is signed
# ad hoc, as the notifier is, when codesign is there. Developer ID signing needs the owner's
# certificate and is a later step (docs/DECISIONS.md).
extract_binary() {
  name=$(helper_name) || return 1
  mkdir -p "$(dirname "$BIN")"
  cid=$(docker create "$IMAGE") || return 1
  copied=0
  if docker cp "$cid:/app/host/$name" "$BIN.tmp" >/dev/null; then copied=1; fi
  docker rm "$cid" >/dev/null 2>&1 || true
  if [ "$copied" -ne 1 ]; then
    rm -f "$BIN.tmp"
    return 1
  fi
  chmod 755 "$BIN.tmp"
  if [ "$(uname -s)" = Darwin ] && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$BIN.tmp" >/dev/null 2>&1 || say "could not sign the helper ad hoc; it runs unsigned."
  fi
  mv "$BIN.tmp" "$BIN"
  # The Node bundle of an older install is of no use now.
  rm -f "$OLD_BUNDLE"
}

install() {
  os=$(host_os)
  case $os in
    macos) ;;
    linux | wsl)
      problem=$(systemd_problem)
      if [ -n "$problem" ]; then
        say "$problem"
        exit 0
      fi
      ;;
    *)
      say "the host helper runs on macOS, Linux and WSL2 only."
      exit 0
      ;;
  esac
  if ! extract_binary; then
    say "could not copy the helper out of the $IMAGE image. Folder browsing and automatic remounts are off."
    exit 0
  fi
  mkdir -p "$LOG_DIR"
  # The helper writes its own service file (the LaunchAgent, or the systemd units) and loads it, from
  # the environment this script runs in, so there is one writer of those files. It reports in the
  # same words, and a failure here never stops `make up`.
  MAJHI_HOME="$MAJHI_DIR" MAJHI_REPO="$REPO_DIR" "$BIN" install-service || true
}

remove_launch_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    say "stopped and removed $LABEL"
  fi
}

remove_units() {
  removed=""
  for unit in "$HOST_UNIT" "$AGENT_UNIT"; do
    [ -f "$UNIT_DIR/$unit" ] || continue
    systemctl --user disable --now --quiet "$unit" 2>/dev/null || true
    # disable takes the link away too, but needs a running user manager.
    rm -f "$UNIT_DIR/$unit" "$UNIT_DIR/default.target.wants/$unit"
    removed="$removed $unit"
  done
  rm -f "$ENV_FILE"
  if [ -n "$removed" ]; then
    systemctl --user daemon-reload 2>/dev/null || true
    say "stopped and removed$removed"
  fi
}

uninstall() {
  case $(host_os) in
    macos) remove_launch_agent ;;
    linux | wsl) remove_units ;;
  esac
}

# Prints the SSH public keys to mount read-only, one path per line, using the installed helper.
# Prints nothing when the helper is missing: majhi then starts without those mounts.
pubkeys() {
  [ -x "$BIN" ] || exit 0
  "$BIN" --ssh-pubkeys 2>/dev/null || true
}

case "${1:-}" in
  install) install ;;
  pubkeys) pubkeys ;;
  uninstall) uninstall ;;
  *)
    echo "Usage: sh scripts/host.sh install|uninstall|pubkeys" >&2
    exit 2
    ;;
esac
