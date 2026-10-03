# Shared by check.sh and host.sh, which source it: which OS this is, a time limit for calls that can
# hang, where Node 20 or newer is, and whether systemd can run the host helper.

# What majhi does without when the host helper is off.
HELPER_OFF="no folder browser, remounts when roots change, updates, start at login, notifications or keyring copy of the secrets key"

# macos, linux, wsl (Linux inside Windows, told apart like the helper's isWsl: the kernel release or
# WSL_DISTRO_NAME) or other.
host_os() {
  case $(uname -s) in
    Darwin) echo macos ;;
    Linux)
      if [ "${WSL_DISTRO_NAME+set}" = set ] || uname -r | grep -qiE 'microsoft|wsl'; then
        echo wsl
      else
        echo linux
      fi
      ;;
    *) echo other ;;
  esac
}

# Runs a command for at most $1 seconds where `timeout` exists (a stock Mac has none).
with_timeout() {
  seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

# Node 20 or newer at $1. It runs from $HOME, where the login service starts it, so a version
# manager's shim picks the same version there.
node_ok() {
  [ -x "$1" ] && (cd "$HOME" && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)') 2>/dev/null
}

# The newest `v<major>.<minor>.<patch>` folder name in $1, without the v. Nothing when there is none.
newest_version() {
  [ -d "$1" ] || return 0
  ls "$1" | sed -n 's/^v//p' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}

# Node 20 or newer: MAJHI_NODE when set (and then only that one), else on PATH, from Homebrew, the
# system's, Volta's, the newest nvm or fnm install, or the mise or asdf shim.
find_node() {
  if [ -n "${MAJHI_NODE:-}" ]; then
    node_ok "$MAJHI_NODE" && printf '%s' "$MAJHI_NODE"
    return
  fi
  data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
  nvm_dir="${NVM_DIR:-$HOME/.nvm}/versions/node"
  fnm_dir="${FNM_DIR:-$data_dir/fnm}/node-versions"
  nvm_node=""
  fnm_node=""
  newest=$(newest_version "$nvm_dir")
  if [ -n "$newest" ]; then nvm_node="$nvm_dir/v$newest/bin/node"; fi
  newest=$(newest_version "$fnm_dir")
  if [ -n "$newest" ]; then fnm_node="$fnm_dir/v$newest/installation/bin/node"; fi
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node \
    /usr/bin/node "$HOME/.volta/bin/node" "$nvm_node" "$fnm_node" \
    "${MISE_DATA_DIR:-$data_dir/mise}/shims/node" "${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node"; do
    case $candidate in
      # fnm's link for one shell, gone once that shell exits. Its install folder is tried instead.
      "" | */fnm_multishells/*) continue ;;
    esac
    if node_ok "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# Why systemd cannot run the host helper on Linux or WSL2, what is off then and the step that
# turns it on, as one line. Nothing when systemd's user manager answers.
systemd_problem() {
  if with_timeout 5 systemctl --user show --property=Version >/dev/null 2>&1; then
    return 0
  fi
  off="so the host helper is off: $HELPER_OFF, and majhi has no SSH agent for git."
  if [ "$(host_os)" = wsl ]; then
    printf '%s\n' "systemd is off in this distro, $off Add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown in Windows, then open the terminal and run make up again."
  elif command -v systemctl >/dev/null 2>&1; then
    printf '%s\n' "systemd's user manager is not answering (systemctl --user), $off Run make up from your own login session, not through su or sudo."
  else
    printf '%s\n' "This computer does not run systemd, $off"
  fi
}
