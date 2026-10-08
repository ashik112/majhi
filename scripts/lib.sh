# Shared by check.sh, host.sh, up.sh and compose.sh, which source it: which OS this is, a time limit
# for calls that can hang, where Node 20 or newer is, whether systemd can run the host helper, and
# the environment `docker compose` runs with.

# What majhi does without when the host helper is off.
HELPER_OFF="no folder browser, remounts when roots change, updates, start at login, notifications or keyring copy of the secrets key"

# The command the owner runs again after fixing what a check found: install.sh sets it to its own.
MAJHI_RERUN=${MAJHI_RERUN:-make up}

# The last NAME=value line for $1 in the checkout's .env, without quotes or CR. Compose reads .env
# too, but a value in the environment wins over it there, so the scripts read it first.
dotenv() {
  file="${REPO_DIR:-.}/.env"
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$file" | tail -n 1 | tr -d "\"'\r" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# Exports what `docker compose` needs from this computer, the same for `make up`, the installer and
# every other compose call: the owner's uid, gid and time zone, the commit to bake in, the SSH agent
# socket, Laya's mode and GPU build args, and the secrets key file. LAYA (docker, native, off) and
# LAYA_GPU (nvidia, off) come from the environment (`make up LAYA=off`). Run it in the checkout.
compose_env() {
  HOST_UID=$(id -u)
  HOST_GID=$(id -g)
  # The commit baked into the image, so majhi can tell when newer code is on disk.
  if [ -f release.json ]; then
    MAJHI_COMMIT=$(sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' release.json)
  else
    MAJHI_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo dev)
  fi
  # This computer's time zone, for days, weeks and months of tokens and cost. Where /etc/localtime is
  # a copy, not a link, systemd's timedatectl knows it.
  MAJHI_TZ=$(readlink /etc/localtime 2>/dev/null | sed -n 's|.*/zoneinfo/||p' | grep . ||
    with_timeout 5 timedatectl show -p Timezone --value 2>/dev/null | grep . || echo UTC)
  export HOST_UID HOST_GID MAJHI_COMMIT MAJHI_TZ

  # The SSH agent socket the server gets for git (DECISIONS): MAJHI_SSH_AGENT from the environment or
  # .env, else per OS. On macOS the socket OrbStack and Docker Desktop forward from the Mac, or an
  # older SSH_AGENT_SOCK; on Linux and WSL2 the host helper's forwarder. `off`: no agent.
  MAJHI_SSH_AGENT=${MAJHI_SSH_AGENT:-$(dotenv MAJHI_SSH_AGENT)}
  if [ -z "$MAJHI_SSH_AGENT" ]; then
    if [ "$(uname -s)" = Darwin ]; then
      MAJHI_SSH_AGENT=${SSH_AGENT_SOCK:-$(dotenv SSH_AGENT_SOCK)}
      MAJHI_SSH_AGENT=${MAJHI_SSH_AGENT:-/run/host-services/ssh-auth.sock}
    else
      MAJHI_SSH_AGENT=$HOME/.majhi/run/ssh-agent.sock
    fi
  fi
  export MAJHI_SSH_AGENT

  # Laya in Docker (PyTorch on the CPU, or CUDA on an NVIDIA GPU) everywhere but Apple silicon Macs,
  # which run it natively (SPEC 5.12). LAYA=docker on a Mac is the fallback; LAYA=off skips it.
  # MAJHI_LAYA records the mode for the host helper, whose updates build and start Laya the same way.
  if [ -z "${LAYA:-}" ]; then
    if [ "$(uname -s)-$(uname -m)" = Darwin-arm64 ]; then LAYA=native; else LAYA=docker; fi
  fi
  MAJHI_LAYA=$LAYA
  COMPOSE_PROFILES=""
  MAJHI_LAYA_GPU=""
  if [ "$LAYA" = docker ]; then
    COMPOSE_PROFILES=laya
    if [ "${LAYA_GPU:-}" = nvidia ]; then MAJHI_LAYA_GPU=nvidia; fi
  fi
  export MAJHI_LAYA COMPOSE_PROFILES MAJHI_LAYA_GPU
  if [ "$MAJHI_LAYA_GPU" = nvidia ]; then
    # PyTorch for CUDA 13.0: amd64 and arm64, Turing (2018) or newer GPUs, driver 580 or newer. An
    # older GPU takes MAJHI_LAYA_TORCH_INDEX=https://download.pytorch.org/whl/cu126 in .env.
    MAJHI_LAYA_TORCH_INDEX=${MAJHI_LAYA_TORCH_INDEX:-$(dotenv MAJHI_LAYA_TORCH_INDEX)}
    MAJHI_LAYA_TORCH_INDEX=${MAJHI_LAYA_TORCH_INDEX:-https://download.pytorch.org/whl/cu130}
    MAJHI_LAYA_DEVICE=cuda
    export MAJHI_LAYA_TORCH_INDEX MAJHI_LAYA_DEVICE
  fi

  # The secrets key file. host.sh hands it to the helper, so its compose runs mount the same file.
  MAJHI_SECRETS_KEY=${MAJHI_SECRETS_KEY:-$(dotenv MAJHI_SECRETS_KEY)}
  MAJHI_SECRETS_KEY=${MAJHI_SECRETS_KEY:-$HOME/.config/majhi/secrets.key}
  export MAJHI_SECRETS_KEY
}

# nvidia when Docker can give Laya an NVIDIA GPU: Docker has the NVIDIA Container Toolkit's
# runtime, or WSL2 has the Windows driver. Nothing otherwise.
nvidia_gpu() {
  if [ -e /usr/lib/wsl/lib/nvidia-smi ] ||
    with_timeout 10 docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then
    echo nvidia
  fi
}

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
    printf '%s\n' "systemd is off in this distro, $off Add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown in Windows, then open the terminal and run $MAJHI_RERUN again."
  elif command -v systemctl >/dev/null 2>&1; then
    printf '%s\n' "systemd's user manager is not answering (systemctl --user), $off Run $MAJHI_RERUN from your own login session, not through su or sudo."
  else
    printf '%s\n' "This computer does not run systemd, $off"
  fi
}
