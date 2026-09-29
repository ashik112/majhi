#!/bin/sh
# Installs or removes the majhi host helper: a small Node process on this
# machine that lists folders for the folder browser and remounts workspace
# roots when they change (SPEC 4.2). On macOS it runs as a LaunchAgent.
# `make up` installs it and `make down` removes it.
#
#   sh scripts/host.sh install | uninstall
#
# MAJHI_HOST_LABEL and MAJHI_LAUNCH_AGENTS_DIR change the LaunchAgent label
# and folder, so tests never touch the real one.
set -eu

LABEL="${MAJHI_HOST_LABEL:-dev.majhi.host}"
AGENTS_DIR="${MAJHI_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS_DIR/$LABEL.plist"
MAJHI_DIR="$HOME/.majhi"
BUNDLE="$MAJHI_DIR/bin/majhi-host.mjs"
LOG_DIR="$MAJHI_DIR/logs"
IMAGE="majhi-server:dev"
REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

say() {
  printf 'host helper: %s\n' "$*"
}

is_macos() {
  [ "$(uname -s)" = Darwin ]
}

# MAJHI_PORT from the environment, else from .env (where compose reads it too), else 7070.
majhi_port() {
  if [ -n "${MAJHI_PORT:-}" ]; then
    printf '%s' "$MAJHI_PORT"
    return
  fi
  port=""
  if [ -f "$REPO_DIR/.env" ]; then
    port=$(sed -n 's/^[[:space:]]*MAJHI_PORT[[:space:]]*=[[:space:]]*//p' "$REPO_DIR/.env" | tail -n 1 | tr -d "\"'\r ")
  fi
  printf '%s' "${port:-7070}"
}

node_ok() {
  [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null
}

# Node 20 or newer: on PATH, from Homebrew, or the newest nvm install.
find_node() {
  nvm_node=""
  nvm_dir="${NVM_DIR:-$HOME/.nvm}/versions/node"
  if [ -d "$nvm_dir" ]; then
    newest=$(ls "$nvm_dir" | sed -n 's/^v//p' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
    if [ -n "$newest" ]; then nvm_node="$nvm_dir/v$newest/bin/node"; fi
  fi
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$nvm_node"; do
    if [ -n "$candidate" ] && node_ok "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

env_entry() {
  printf '    <key>%s</key>\n    <string>%s</string>\n' "$1" "$(xml "$2")"
}

write_plist() {
  node_bin=$1
  port=$(majhi_port)
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$node_bin")</string>
    <string>$(xml "$BUNDLE")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
EOF
    env_entry MAJHI_URL "http://127.0.0.1:$port"
    env_entry MAJHI_HOME "$MAJHI_DIR"
    env_entry MAJHI_REPO "$REPO_DIR"
    env_entry PATH "$PATH"
    env_entry HOME "$HOME"
    # Remounts run `docker compose` the way `make up` did, so they keep these settings.
    env_entry MAJHI_PORT "$port"
    for name in COMPOSE_PROJECT_NAME SSH_AGENT_SOCK DOCKER_CONFIG DOCKER_HOST DOCKER_CONTEXT; do
      value=$(printenv "$name" || true)
      if [ -n "$value" ]; then env_entry "$name" "$value"; fi
    done
    cat <<EOF
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG_DIR/host.out")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG_DIR/host.out")</string>
</dict>
</plist>
EOF
  } >"$PLIST.tmp"
  mv "$PLIST.tmp" "$PLIST"
}

# Copies the helper out of the image `make up` just built.
extract_bundle() {
  mkdir -p "$(dirname "$BUNDLE")"
  cid=$(docker create "$IMAGE") || return 1
  copied=0
  if docker cp "$cid:/app/host/majhi-host.mjs" "$BUNDLE.tmp" >/dev/null; then copied=1; fi
  docker rm "$cid" >/dev/null 2>&1 || true
  if [ "$copied" -ne 1 ]; then
    rm -f "$BUNDLE.tmp"
    return 1
  fi
  mv "$BUNDLE.tmp" "$BUNDLE"
}

install() {
  if ! is_macos; then
    say "the host helper is macOS-only for now, so folder browsing and automatic remounts are off."
    exit 0
  fi
  if ! node_bin=$(find_node); then
    say "Node 20 or newer was not found. Folder browsing and automatic remounts need it."
    say "majhi still works: type folder paths, and run \`make up\` after adding a root."
    exit 0
  fi
  if ! extract_bundle; then
    say "could not copy the helper out of the $IMAGE image. Folder browsing and automatic remounts are off."
    exit 0
  fi
  mkdir -p "$LOG_DIR" "$AGENTS_DIR"
  write_plist "$node_bin"

  domain="gui/$(id -u)"
  launchctl bootout "$domain/$LABEL" 2>/dev/null || true
  # bootout returns before the old process has gone, and bootstrap fails until it has.
  tries=0
  until launchctl bootstrap "$domain" "$PLIST" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 20 ]; then
      say "launchctl could not start $LABEL from $PLIST. Folder browsing and automatic remounts are off."
      exit 0
    fi
    sleep 0.5
  done
  say "running as $LABEL with node $("$node_bin" --version). Logs: make host-logs"
}

uninstall() {
  is_macos || exit 0
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    say "stopped and removed $LABEL"
  fi
}

# Prints the SSH public keys to mount read-only, one path per line, using the installed helper.
# Prints nothing when the helper or Node is missing: majhi then starts without those mounts.
pubkeys() {
  is_macos || exit 0
  [ -f "$BUNDLE" ] || exit 0
  node_bin=$(find_node) || exit 0
  "$node_bin" "$BUNDLE" --ssh-pubkeys 2>/dev/null || true
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
