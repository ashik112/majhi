#!/bin/sh
# Installs or removes the majhi host helper: a small Node process on this
# machine that lists folders for the folder browser and remounts workspace
# roots when they change (SPEC 4.2). On macOS it runs as a LaunchAgent. On
# Linux and WSL2 it runs as the systemd user unit majhi-host.service, next to
# majhi-ssh-agent.service, majhi's own SSH agent. `make up` installs it and
# `make down` removes it.
#
#   sh scripts/host.sh install | uninstall | pubkeys
#
# MAJHI_HOST_LABEL and MAJHI_LAUNCH_AGENTS_DIR change the LaunchAgent label
# and folder, and MAJHI_SYSTEMD_USER_DIR the folder of the units, so tests
# never touch the real ones.
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
BUNDLE="$MAJHI_DIR/bin/majhi-host.mjs"
LOG_DIR="$MAJHI_DIR/logs"
RUN_DIR="$MAJHI_DIR/run"
IMAGE="majhi-server:dev"
REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# Remounts run `docker compose` the way `make up` did, so the helper keeps these settings, among them
# the agent socket and Laya's GPU that `make up` picked (decisions 1 and 9 of the Linux brief).
PASSTHROUGH="COMPOSE_PROJECT_NAME SSH_AGENT_SOCK DOCKER_CONFIG DOCKER_HOST DOCKER_CONTEXT MAJHI_SSH_AGENT MAJHI_LAYA_GPU"
NL='
'

say() {
  printf 'host helper: %s\n' "$*"
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
    env_entry MAJHI_PORT "$port"
    for name in $PASSTHROUGH; do
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

# $1 as the program on a unit's command line: in double quotes, with % as %%. systemd reads
# specifiers there, but no variables (systemd.service(5)).
exec_program() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/%/%%/g')"
}

# $1 as an argument on a unit's command line: in double quotes, with \ and " escaped, % as %% and $
# as $$, since systemd reads escapes, specifiers and variables there.
exec_arg() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"]/\\&/g' -e 's/%/%%/g' -e 's/\$/$$/g')"
}

# $1 as the value of a unit's path setting, where systemd reads specifiers and takes the rest as is.
unit_path() {
  printf '%s' "$1" | sed 's/%/%%/g'
}

# NAME="value" for the helper's EnvironmentFile, with \ " ` and $ escaped (systemd.exec(5)). A value
# with a line break cannot be written that way, so it is left out, and the reason goes to stderr.
env_line() {
  case $2 in
    *"$NL"*)
      say "left $1 out of the helper's environment: its value has a line break." >&2
      return 0
      ;;
  esac
  printf '%s="%s"\n' "$1" "$(printf '%s' "$2" | sed 's/[\\"`$]/\\&/g')"
}

# The helper's environment: the same variables as the LaunchAgent's.
write_env_file() {
  port=$(majhi_port)
  (
    umask 077
    {
      echo "# Written by make up (scripts/host.sh) for $HOST_UNIT. make down removes it."
      env_line MAJHI_URL "http://127.0.0.1:$port"
      env_line MAJHI_HOME "$MAJHI_DIR"
      env_line MAJHI_REPO "$REPO_DIR"
      env_line PATH "$PATH"
      env_line HOME "$HOME"
      env_line MAJHI_PORT "$port"
      for name in $PASSTHROUGH; do
        value=$(printenv "$name" || true)
        if [ -n "$value" ]; then env_line "$name" "$value"; fi
      done
    } >"$ENV_FILE.tmp"
  )
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

# systemd starts the helper again whenever it exits, with no limit: it exits on purpose after an
# update or a restart from majhi.
write_host_unit() {
  node_bin=$1
  cat >"$UNIT_DIR/$HOST_UNIT.tmp" <<EOF
# Written by make up (scripts/host.sh). make down removes it.
[Unit]
Description=majhi host helper
StartLimitIntervalSec=0

[Service]
ExecStart=$(exec_program "$node_bin") $(exec_arg "$BUNDLE")
EnvironmentFile=$(unit_path "$ENV_FILE")
Restart=always
RestartSec=2
StandardOutput=append:$(unit_path "$LOG_DIR/host.out")
StandardError=append:$(unit_path "$LOG_DIR/host.out")

[Install]
WantedBy=default.target
EOF
  mv "$UNIT_DIR/$HOST_UNIT.tmp" "$UNIT_DIR/$HOST_UNIT"
}

# majhi's own agent, for when the session has none (decision 3 of the Linux brief). It runs apart
# from the helper, so keys stay loaded when the helper restarts. A socket left by a killed agent
# would stop the next one from starting, so it goes first.
write_agent_unit() {
  agent_bin=$1
  mkdir_bin=$2
  rm_bin=$3
  cat >"$UNIT_DIR/$AGENT_UNIT.tmp" <<EOF
# Written by make up (scripts/host.sh). make down removes it.
[Unit]
Description=majhi's SSH agent, for when the session has none

[Service]
ExecStartPre=$(exec_program "$mkdir_bin") -p -m 700 $(exec_arg "$RUN_DIR")
ExecStartPre=$(exec_program "$rm_bin") -f $(exec_arg "$RUN_DIR/agent.sock")
ExecStart=$(exec_program "$agent_bin") -D -a $(exec_arg "$RUN_DIR/agent.sock")
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  mv "$UNIT_DIR/$AGENT_UNIT.tmp" "$UNIT_DIR/$AGENT_UNIT"
}

# The absolute path of program $1, which a unit's command line needs.
program() {
  found=$(command -v "$1" 2>/dev/null) || return 1
  case $found in
    /*) printf '%s' "$found" ;;
    *) return 1 ;;
  esac
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

start_launch_agent() {
  node_bin=$1
  mkdir -p "$AGENTS_DIR"
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

# WSL has no login of its own: Docker Desktop boots the distro at Windows sign-in, and only then
# does a lingering user's systemd start the helper.
linger() {
  user=${USER:-$(id -un)}
  case $(loginctl show-user "$user" --property=Linger 2>/dev/null || true) in
    Linger=yes) return 0 ;;
  esac
  if ! loginctl enable-linger --no-ask-password "$user" >/dev/null 2>&1; then
    say "the helper runs only while a terminal is open in this distro. To start it when Windows starts, run: sudo loginctl enable-linger $user"
  fi
}

start_units() {
  node_bin=$1
  mkdir -p "$UNIT_DIR" "$RUN_DIR"
  chmod 700 "$RUN_DIR"
  write_env_file
  write_host_unit "$node_bin"
  agent=""
  if agent_bin=$(program ssh-agent) && mkdir_bin=$(program mkdir) && rm_bin=$(program rm); then
    write_agent_unit "$agent_bin" "$mkdir_bin" "$rm_bin"
    agent=$AGENT_UNIT
  else
    say "ssh-agent was not found, so majhi has no agent of its own: SSH keys reach it only from the session's agent."
  fi

  # The agent only starts: a restart would drop the keys it holds. The helper restarts on its new bundle.
  if ! systemctl --user daemon-reload || ! systemctl --user enable --quiet ${agent:+"$agent"} "$HOST_UNIT"; then
    say "systemctl could not enable $HOST_UNIT. Folder browsing and automatic remounts are off."
    exit 0
  fi
  if [ -n "$agent" ] && ! systemctl --user start "$agent"; then
    say "systemctl could not start $agent. journalctl --user -u $agent says why."
  fi
  if ! systemctl --user restart "$HOST_UNIT"; then
    say "systemctl could not start $HOST_UNIT. journalctl --user -u $HOST_UNIT says why."
    exit 0
  fi
  if [ "$(host_os)" = wsl ]; then linger; fi
  say "running as $HOST_UNIT with node $("$node_bin" --version). Logs: make host-logs"
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
  if ! node_bin=$(find_node); then
    say "Node 20 or newer was not found. Folder browsing and automatic remounts need it."
    if [ "$os" != macos ]; then say "SSH keys reach majhi through it too, so git over SSH does not work without it."; fi
    say "majhi still works: type folder paths, and run \`make up\` after adding a root."
    exit 0
  fi
  if ! extract_bundle; then
    say "could not copy the helper out of the $IMAGE image. Folder browsing and automatic remounts are off."
    exit 0
  fi
  mkdir -p "$LOG_DIR"
  if [ "$os" = macos ]; then
    start_launch_agent "$node_bin"
  else
    start_units "$node_bin"
  fi
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
# Prints nothing when the helper or Node is missing: majhi then starts without those mounts.
pubkeys() {
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
