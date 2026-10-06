#!/bin/sh
# Installs majhi, or updates it to the newest release: run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/ashik112/majhi/main/install.sh | sh
#
# It keeps a checkout of the newest release tag in ~/.majhi/app, records the version in that
# checkout's .env (MAJHI_VERSION, so compose takes that release's images from ghcr.io), then runs
# scripts/up.sh from it, the same steps as `make up`. macOS, Linux and Windows through WSL2.
#
# MAJHI_VERSION=v1.2.3 installs that release instead of the newest. MAJHI_APP_DIR and MAJHI_REPO_URL
# change where the checkout lives and where it comes from.
set -eu

# Where this script is served from. Change it here (and in README.md) when majhi gets its own domain.
INSTALL_URL="https://raw.githubusercontent.com/ashik112/majhi/main/install.sh"
REPO_URL=${MAJHI_REPO_URL:-https://github.com/ashik112/majhi.git}
APP_DIR=${MAJHI_APP_DIR:-$HOME/.majhi/app}
# What the checks in scripts/check.sh tell the owner to run again.
MAJHI_RERUN="the install command (curl -fsSL $INSTALL_URL | sh)"
export MAJHI_RERUN

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

say() {
  printf '==> %s\n' "$*"
}

# macos, linux or wsl, as scripts/lib.sh tells them apart. Stops anywhere else.
detect_os() {
  case $(uname -s) in
    Darwin) echo macos ;;
    Linux)
      if [ "${WSL_DISTRO_NAME+set}" = set ] || uname -r | grep -qiE 'microsoft|wsl'; then
        echo wsl
      else
        echo linux
      fi
      ;;
    MINGW* | MSYS* | CYGWIN*) fail "On Windows, majhi runs in WSL2. Run wsl --install in PowerShell, then run $MAJHI_RERUN in the distro's terminal." ;;
    *) fail "majhi runs on macOS, Linux and Windows through WSL2." ;;
  esac
}

# The release images are built for amd64 and arm64.
detect_arch() {
  case $(uname -m) in
    x86_64 | amd64) echo amd64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) fail "majhi's images are built for amd64 and arm64 computers, not $(uname -m)." ;;
  esac
}

need_git() {
  command -v git >/dev/null 2>&1 && return 0
  case $1 in
    macos) fail "git is not installed. Run xcode-select --install (or brew install git), then run $MAJHI_RERUN again." ;;
    *) fail "git is not installed. Install it (sudo apt install git, sudo dnf install git or sudo pacman -S git), then run $MAJHI_RERUN again." ;;
  esac
}

# Clones the checkout, or fetches the new tags into it. A checkout with changes is never touched.
fetch_checkout() {
  if [ ! -e "$APP_DIR" ]; then
    say "Getting majhi into $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    # Without file contents: checking out a tag fetches the ones it needs.
    git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$APP_DIR"
    return
  fi
  if ! git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    fail "$APP_DIR is in the way: it is not a majhi checkout. Move it, or set MAJHI_APP_DIR to another folder, then run $MAJHI_RERUN again."
  fi
  # A clone whose first checkout never happened lists every file as deleted: nothing to keep there.
  if [ -n "$(git -C "$APP_DIR" ls-files 2>/dev/null | head -n 1)" ] &&
    [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    fail "$APP_DIR has changes that are not committed, so it was left alone. Undo them (git -C $APP_DIR stash), then run $MAJHI_RERUN again."
  fi
  say "Looking for a newer majhi"
  git -C "$APP_DIR" fetch --quiet --tags origin
}

# The release to run: MAJHI_VERSION when set, else the newest vX.Y.Z tag (the host helper's
# updates pick it the same way, apps/host/src/release.ts).
pick_version() {
  if [ -n "${MAJHI_VERSION:-}" ]; then
    git -C "$APP_DIR" rev-parse --quiet --verify "refs/tags/$MAJHI_VERSION" >/dev/null ||
      fail "majhi has no release $MAJHI_VERSION. Leave MAJHI_VERSION out for the newest one."
    printf '%s' "$MAJHI_VERSION"
    return
  fi
  newest=$(git -C "$APP_DIR" tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
  [ -n "$newest" ] || fail "majhi has no release yet. Install it from source: git clone $REPO_URL && cd majhi && make up"
  printf '%s' "$newest"
}

# Sets MAJHI_VERSION in the checkout's .env and keeps every other line (the owner's settings).
record_version() {
  env_file="$APP_DIR/.env"
  {
    if [ -f "$env_file" ]; then grep -v '^[[:space:]]*MAJHI_VERSION[[:space:]]*=' "$env_file" || true; fi
    printf 'MAJHI_VERSION=%s\n' "$1"
  } >"$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
}

open_browser() {
  case $1 in
    macos) open "$2" >/dev/null 2>&1 || true ;;
    wsl)
      if command -v wslview >/dev/null 2>&1; then
        wslview "$2" >/dev/null 2>&1 || true
      else
        cmd.exe /c start "" "$2" >/dev/null 2>&1 || true
      fi
      ;;
    *)
      if { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$2" >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

main() {
  os=$(detect_os)
  arch=$(detect_arch)
  need_git "$os"
  fetch_checkout
  version=$(pick_version)
  installed=$(sed -n 's/^[[:space:]]*MAJHI_VERSION[[:space:]]*=[[:space:]]*//p' "$APP_DIR/.env" 2>/dev/null | tail -n 1 | tr -d "\"'\r ")
  if [ "$installed" = "$version" ]; then
    say "majhi $version is the newest. Starting it again"
  else
    say "Installing majhi $version ($os, $arch)"
  fi
  # Every time: a first clone has no files yet, and a run cut short may have left HEAD elsewhere.
  git -C "$APP_DIR" -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$version"
  record_version "$version"
  [ -f "$APP_DIR/scripts/up.sh" ] || fail "majhi $version is older than this installer. Install a newer release."
  sh "$APP_DIR/scripts/up.sh"

  port=$(sed -n 's/^[[:space:]]*MAJHI_PORT[[:space:]]*=[[:space:]]*//p' "$APP_DIR/.env" | tail -n 1 | tr -d "\"'\r ")
  url="http://127.0.0.1:${MAJHI_PORT:-${port:-7070}}"
  say "majhi $version is running on $url"
  say "To update, run $MAJHI_RERUN again, or press Update in majhi."
  open_browser "$os" "$url"
}

# Everything runs from here, so a download cut short runs nothing.
main "$@"
