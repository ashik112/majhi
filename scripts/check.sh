#!/bin/sh
# Checks this computer before `make up` builds anything. Stops with one line and the step to take
# when majhi cannot run here, and warns when it runs with a part turned off.
#
#   sh scripts/check.sh
set -eu

. "$(dirname -- "$0")/lib.sh"

OS=$(host_os)
ENGINE_URL="https://docs.docker.com/engine/install/"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

# Docker Desktop for Linux and rootless Docker map container uids through a user namespace, so the
# owner's uid in the server lands on another uid outside (DECISIONS). Docker Engine run as root does not.
engine_step() {
  unset_host=""
  if [ -n "${DOCKER_HOST:-}" ]; then unset_host="unset DOCKER_HOST, "; fi
  printf 'Switch to Docker Engine running as root (%s): %ssudo systemctl enable --now docker, then docker context use default, then make up again.' "$ENGINE_URL" "$unset_host"
}

DESKTOP_REFUSAL="Docker Desktop for Linux is not supported yet: files majhi writes would belong to another user."
ROOTLESS_REFUSAL="Rootless Docker is not supported yet: files majhi writes would belong to another user."

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    case $OS in
      macos) fail "Docker is not installed. Install OrbStack (https://orbstack.dev) or Docker Desktop, then run make up again." ;;
      wsl) fail "docker is not in this distro. Start Docker Desktop in Windows and turn on Settings > Resources > WSL integration for ${WSL_DISTRO_NAME:-this distro}, then run make up again." ;;
      *) fail "Docker is not installed. Install Docker Engine ($ENGINE_URL), then run make up again." ;;
    esac
  fi

  errors=$(mktemp)
  trap 'rm -f "$errors"' EXIT
  if ! info=$(with_timeout 20 docker info --format '{{json .OperatingSystem}} {{json .SecurityOptions}}' 2>"$errors"); then
    if grep -qi 'permission denied' "$errors"; then
      case $OS in
        wsl) fail "Your user may not use Docker. Run sudo usermod -aG docker \$USER, then wsl --shutdown in Windows, then open the terminal and run make up again." ;;
        *) fail "Your user may not use Docker. Run sudo usermod -aG docker \$USER, then log out and back in, and run make up again." ;;
      esac
    fi
    # The desktop-linux context points at ~/.docker/desktop/docker.sock.
    if [ "$OS" = linux ] && grep -q '/\.docker/desktop/' "$errors"; then
      fail "$DESKTOP_REFUSAL $(engine_step)"
    fi
    case $OS in
      macos) fail "Docker is not running. Open OrbStack or Docker Desktop, then run make up again." ;;
      wsl) fail "Docker is not running. Start Docker Desktop in Windows, then run make up again." ;;
      *) fail "Docker is not running. Run sudo systemctl enable --now docker, then make up again." ;;
    esac
  fi

  version=$(docker compose version --short 2>/dev/null || true)
  major=${version#v}
  major=${major%%.*}
  case $major in
    "" | *[!0-9]*) major=0 ;;
  esac
  if [ "$major" -lt 2 ]; then
    case $OS in
      macos) fail "Docker Compose v2 is missing. Update OrbStack or Docker Desktop, which include it, then run make up again." ;;
      wsl) fail "Docker Compose v2 is missing. Update Docker Desktop, which includes it, then run make up again." ;;
      *) fail "Docker Compose v2 is missing. Install the docker-compose-plugin package (https://docs.docker.com/compose/install/linux/), then run make up again." ;;
    esac
  fi

  if [ "$OS" = linux ]; then
    case $info in
      '"Docker Desktop"'*) fail "$DESKTOP_REFUSAL $(engine_step)" ;;
    esac
  fi
  case $info in
    *'"name=rootless"'*) fail "$ROOTLESS_REFUSAL $(engine_step)" ;;
  esac
}

# Why the secrets key cannot have a copy in a keyring, the way the helper probes it (decision 4 of
# the Linux brief): D-Bus first, so a locked keyring never pops a prompt. Nothing when it can.
keyring_problem() {
  if ! command -v secret-tool >/dev/null 2>&1; then
    printf '%s\n' "secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch)."
  elif ! command -v busctl >/dev/null 2>&1; then
    printf '%s\n' "The keyring cannot be checked without busctl (systemd)."
  else
    case $(with_timeout 5 busctl --user get-property org.freedesktop.secrets \
      /org/freedesktop/secrets/aliases/default org.freedesktop.Secret.Collection Locked 2>/dev/null) in
      "b false") ;;
      "b true") printf '%s\n' "The keyring is locked." ;;
      *) printf '%s\n' "No keyring is running." ;;
    esac
  fi
}

check_warnings() {
  if ! command -v git >/dev/null 2>&1; then
    warn "git is not installed, so majhi cannot update itself. Install git to turn updates on."
  fi

  if ! find_node >/dev/null; then
    case $OS in
      linux | wsl) warn "Node 20 or newer is not installed, so the host helper is off: $HELPER_OFF, and majhi has no SSH agent for git. Install Node 20 or newer, then run make up again." ;;
      *) warn "Node 20 or newer is not installed, so the host helper is off: $HELPER_OFF. Install Node 20 or newer, then run make up again." ;;
    esac
  fi

  case $OS in
    linux | wsl) ;;
    *) return 0 ;;
  esac

  reason=$(keyring_problem)
  if [ -n "$reason" ]; then
    warn "$reason The secrets key may have no copy in a keyring: export it on majhi's Health page (Export key) and keep the file safe."
  fi

  problem=$(systemd_problem)
  if [ -n "$problem" ]; then
    warn "$problem"
  fi
}

if [ "$OS" = other ]; then
  fail "majhi runs on macOS, Linux and Windows through WSL2. On Windows, run make up in a WSL2 distro."
fi
check_docker
check_warnings
