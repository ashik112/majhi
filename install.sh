#!/bin/sh
# Installs majhi, or updates it to the newest release: run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/ashik112/majhi/main/install.sh | sh
#
# It asks GitHub for the latest release (the release workflow moves that pointer last), keeps a
# checkout of its tag in ~/.majhi/app, records the version and the pointer in that checkout's .env
# (MAJHI_VERSION, so compose takes that release's images from ghcr.io, and MAJHI_LATEST_URL, where
# the host helper looks for updates), then runs scripts/up.sh from it, the same steps as `make up`.
# macOS, Linux and Windows through WSL2.
#
# MAJHI_VERSION=v1.2.3 installs that release instead of the latest. MAJHI_APP_DIR, MAJHI_REPO_URL and
# MAJHI_LATEST_URL change where the checkout lives, where it comes from and where the latest is read.
set -eu

# Where majhi is served from. Change these (and the line in README.md) when it gets its own domain.
INSTALL_URL="https://raw.githubusercontent.com/ashik112/majhi/main/install.sh"
REPO_URL=${MAJHI_REPO_URL:-https://github.com/ashik112/majhi.git}
LATEST_URL=${MAJHI_LATEST_URL:-https://api.github.com/repos/ashik112/majhi/releases/latest}
APP_DIR=${MAJHI_APP_DIR:-$HOME/.majhi/app}
RELEASE='^v[0-9]+\.[0-9]+\.[0-9]+$'
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

# git for the checkout, curl for the latest release.
need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  case $2 in
    macos) fail "$1 is not installed. Run xcode-select --install (or brew install $1), then run $MAJHI_RERUN again." ;;
    *) fail "$1 is not installed. Install it (sudo apt install $1, sudo dnf install $1 or sudo pacman -S $1), then run $MAJHI_RERUN again." ;;
  esac
}

# The tag of the latest release, as GitHub's releases API names it (`tag_name`). The host helper
# reads the same pointer for its updates (apps/host/src/release.ts).
latest_version() {
  out=$(curl -sSL -H 'Accept: application/vnd.github+json' -w '\n%{http_code}' "$LATEST_URL" 2>&1) ||
    fail "Could not reach $LATEST_URL: $(printf '%s\n' "$out" | tail -n 1). Check your internet connection, then run $MAJHI_RERUN again."
  # 000: a file:// address, which has no HTTP status.
  case $(printf '%s\n' "$out" | tail -n 1) in
    200 | 000) ;;
    404) fail "majhi has no release yet. Install it from source: git clone $REPO_URL && cd majhi && make up" ;;
    *) fail "$LATEST_URL answered $(printf '%s\n' "$out" | tail -n 1). Wait a few minutes, then run $MAJHI_RERUN again." ;;
  esac
  tag=$(printf '%s\n' "$out" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s\n' "$tag" | grep -qE "$RELEASE" || fail "$LATEST_URL names no majhi release."
  printf '%s' "$tag"
}

# The release to run: MAJHI_VERSION when set, else the latest.
pick_version() {
  if [ -z "${MAJHI_VERSION:-}" ]; then
    latest_version
    return
  fi
  printf '%s\n' "$MAJHI_VERSION" | grep -qE "$RELEASE" ||
    fail "MAJHI_VERSION=$MAJHI_VERSION is not a release: they look like v1.2.3. Leave it out for the latest."
  printf '%s' "$MAJHI_VERSION"
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
  say "Fetching the majhi releases"
  git -C "$APP_DIR" fetch --quiet --tags origin
}

# Sets MAJHI_VERSION and MAJHI_LATEST_URL in the checkout's .env and keeps every other line (the
# owner's settings).
record_release() {
  env_file="$APP_DIR/.env"
  {
    if [ -f "$env_file" ]; then grep -vE '^[[:space:]]*MAJHI_(VERSION|LATEST_URL)[[:space:]]*=' "$env_file" || true; fi
    printf 'MAJHI_VERSION=%s\nMAJHI_LATEST_URL=%s\n' "$1" "$LATEST_URL"
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
  need git "$os"
  need curl "$os"
  version=$(pick_version)
  fetch_checkout
  git -C "$APP_DIR" rev-parse --quiet --verify "refs/tags/$version" >/dev/null ||
    fail "majhi has no release $version in $REPO_URL. Leave MAJHI_VERSION out for the latest."
  installed=$(sed -n 's/^[[:space:]]*MAJHI_VERSION[[:space:]]*=[[:space:]]*//p' "$APP_DIR/.env" 2>/dev/null | tail -n 1 | tr -d "\"'\r ")
  if [ "$installed" = "$version" ]; then
    say "majhi $version is installed already. Starting it again"
  else
    say "Installing majhi $version ($os, $arch)"
  fi
  # Every time: a first clone has no files yet, and a run cut short may have left HEAD elsewhere.
  git -C "$APP_DIR" -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$version"
  record_release "$version"
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
