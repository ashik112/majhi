#!/bin/sh
# Installs majhi, or updates it to the latest release: run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/ashik112/majhi-releases/main/install.sh | sh
#
# Downloads the latest runtime package and prebuilt images, without a source checkout.
# macOS, Linux and Windows through WSL2. MAJHI_VERSION pins a release. MAJHI_APP_DIR,
# MAJHI_DOWNLOAD_URL and MAJHI_LATEST_URL override the install directory and release host.
# MAJHI_INSTALL_ONLY=1 stages a package without starting services (used by the host updater).
set -eu

# Where majhi is served from. Change these (and the line in README.md) when it gets its own domain.
INSTALL_URL="https://raw.githubusercontent.com/ashik112/majhi-releases/main/install.sh"
DOWNLOAD_URL=${MAJHI_DOWNLOAD_URL:-https://github.com/ashik112/majhi-releases/releases/download}
LATEST_URL=${MAJHI_LATEST_URL:-https://api.github.com/repos/ashik112/majhi-releases/releases/latest}
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

# curl downloads the release; tar unpacks the runtime files.
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
    404) fail "majhi has no release yet. Try again after the first release is published." ;;
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

# Exact regular files allowed in a runtime package. Extract by name, never into the app folder.
RUNTIME_FILES="Dockerfile docker-compose.yml docker/owner.sh docker/laya.Dockerfile scripts/check.sh scripts/compose.sh scripts/host.sh scripts/lib.sh scripts/up.sh install.sh LICENSE release.json"

fetch_package() {
  # An existing checkout stays intact, including local changes. Keep using it for development.
  if [ -e "$APP_DIR/.git" ]; then
    say "Keeping the source checkout at $APP_DIR. Installing the runtime beside it"
    source_app="$APP_DIR"
    APP_DIR="$APP_DIR-runtime"
  fi
  [ ! -L "$APP_DIR" ] || fail "The runtime directory is a symbolic link, so it was left alone."
  if [ -e "$APP_DIR" ] && [ ! -f "$APP_DIR/release.json" ]; then
    fail "$APP_DIR is in the way: it is not a majhi runtime install. Set MAJHI_APP_DIR to another folder."
  fi
  parent=$(dirname "$APP_DIR")
  mkdir -p "$parent"
  stage=$(mktemp -d "$parent/.majhi-install.XXXXXX")
  lock="$APP_DIR.install-lock"
  if ! mkdir "$lock" 2>/dev/null; then
    rm -rf "$stage"
    fail "Another install is running for $APP_DIR."
  fi
  trap 'rm -rf "$stage"; rmdir "$lock"' EXIT
  trap 'exit 1' HUP INT TERM
  base="${DOWNLOAD_URL%/}/$version"
  curl -fsSL --connect-timeout 15 --max-time 300 "$base/majhi-runtime.tar.gz" -o "$stage/package.tar.gz" || fail "Could not download majhi $version. Your installed version was left alone."
  curl -fsSL --connect-timeout 15 --max-time 30 "$base/majhi-runtime.tar.gz.sha256" -o "$stage/checksum" || fail "Could not download the release checksum."
  expected=$(awk 'NR == 1 {print $1}' "$stage/checksum")
  printf '%s\n' "$expected" | grep -qE '^[0-9a-f]{64}$' || fail "The release checksum is invalid."
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$stage/package.tar.gz" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$stage/package.tar.gz" | awk '{print $1}')
  fi
  [ "$expected" = "$actual" ] || fail "The release download failed its checksum. Your installed version was left alone."
  tar -tzf "$stage/package.tar.gz" >"$stage/entries" || fail "The release archive is invalid."
  # Reject duplicates, extra files and non-regular entries, including symlinks and hard links.
  [ "$(wc -l <"$stage/entries" | tr -d ' ')" = 12 ] || fail "The release archive has unexpected files."
  tar -tvzf "$stage/package.tar.gz" >"$stage/types" || fail "The release archive is invalid."
  if awk 'substr($0,1,1) != "-" {bad=1} END {exit !bad}' "$stage/types"; then
    fail "The release archive contains a link or special file."
  fi
  mkdir "$stage/app"
  for file in $RUNTIME_FILES; do
    [ "$(awk -v wanted="$file" '$0 == wanted {n++} END {print n+0}' "$stage/entries")" = 1 ] || fail "The release archive is missing $file."
    mkdir -p "$stage/app/$(dirname "$file")"
    tar -xOzf "$stage/package.tar.gz" "$file" >"$stage/app/$file" || fail "Could not unpack $file."
  done
  packaged_version=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$stage/app/release.json")
  packaged_commit=$(sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' "$stage/app/release.json")
  [ "$packaged_version" = "$version" ] || fail "The package names another release."
  printf '%s\n' "$packaged_commit" | grep -qE '^[0-9a-f]{40,64}$' || fail "The package has no valid commit."
  if [ -n "${source_app:-}" ] && [ -f "$source_app/.env" ] && [ ! -d "$APP_DIR" ]; then
    cp "$source_app/.env" "$stage/app/.env"
  fi
  # Preserve owner config and generated mounts. A failure while staging touches neither.
  if [ -d "$APP_DIR" ]; then
    for file in .env docker-compose.override.yml; do
      if [ -f "$APP_DIR/$file" ]; then cp "$APP_DIR/$file" "$stage/app/$file"; fi
    done
    # Refuse to discard anything outside the runtime package and owner config.
    [ -z "$(find "$APP_DIR" -type l -print)" ] || fail "The runtime directory contains symbolic links, so it was left alone."
    [ -z "$(find "$APP_DIR" ! -type f ! -type d -print)" ] || fail "The runtime directory contains special files, so it was left alone."
    extra=$(find "$APP_DIR" -type f | while IFS= read -r entry; do
      relative=${entry#"$APP_DIR/"}
      case " $RUNTIME_FILES .env docker-compose.override.yml " in
        (*" $relative "*) ;;
        (*) printf '%s\n' "$relative" ;;
      esac
    done)
    [ -z "$extra" ] || fail "$APP_DIR contains extra files, so it was left alone."
    # Keep one prior package until the new one has started successfully.
    [ ! -e "$APP_DIR.previous" ] && [ ! -L "$APP_DIR.previous" ] || fail "$APP_DIR.previous already exists. The previous install was left alone."
    mv "$APP_DIR" "$APP_DIR.previous"
  fi
  if ! mv "$stage/app" "$APP_DIR"; then
    if [ -d "$APP_DIR.previous" ]; then mv "$APP_DIR.previous" "$APP_DIR"; fi
    fail "Could not install the runtime package."
  fi
  rm -rf "$stage"
  # Keep the lock until services have started, including while rolling back.
}

# Records the release and its endpoints in .env, keeping the owner's settings.
record_release() {
  env_file="$APP_DIR/.env"
  {
    if [ -f "$env_file" ]; then grep -vE '^[[:space:]]*MAJHI_(VERSION|LATEST_URL|DOWNLOAD_URL)[[:space:]]*=' "$env_file" || true; fi
    printf 'MAJHI_VERSION=%s\nMAJHI_LATEST_URL=%s\nMAJHI_DOWNLOAD_URL=%s\n' "$1" "$LATEST_URL" "$DOWNLOAD_URL"
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
  need curl "$os"
  need tar "$os"
  if ! command -v sha256sum >/dev/null 2>&1; then need shasum "$os"; fi
  version=$(pick_version)
  say "Installing majhi $version ($os, $arch)"
  fetch_package
  record_release "$version"
  if [ "${MAJHI_INSTALL_ONLY:-0}" != 1 ]; then
    if ! (unset MAJHI_VERSION; sh "$APP_DIR/scripts/up.sh"); then
      if [ -d "$APP_DIR.previous" ]; then
        rm -rf "$APP_DIR"
        mv "$APP_DIR.previous" "$APP_DIR"
        (unset MAJHI_VERSION; sh "$APP_DIR/scripts/up.sh") || true
      fi
      fail "majhi did not start. The previous package was restored when available."
    fi
  fi
  if [ -d "$APP_DIR.previous" ]; then rm -rf "$APP_DIR.previous"; fi
  [ "${MAJHI_INSTALL_ONLY:-0}" != 1 ] || return 0

  port=$(sed -n 's/^[[:space:]]*MAJHI_PORT[[:space:]]*=[[:space:]]*//p' "$APP_DIR/.env" | tail -n 1 | tr -d "\"'\r ")
  url="http://127.0.0.1:${MAJHI_PORT:-${port:-7070}}"
  say "majhi $version is running on $url"
  say "To update, run $MAJHI_RERUN again, or press Update in majhi."
  open_browser "$os" "$url"
}

# Everything runs from here, so a download cut short runs nothing.
main "$@"
