#!/bin/sh
# Gives the owner's uid a passwd entry with the owner's real home (where ~/.ssh/config is mounted):
# OpenSSH and some CLIs refuse to run without one. The last step of the server and runner images,
# always built on the owner's computer, so a release image from ghcr.io needs only this step.
set -eu
if ! getent group "$HOST_GID" >/dev/null; then groupadd -g "$HOST_GID" majhi; fi
if getent passwd "$HOST_UID" >/dev/null; then
  usermod -d "$HOST_HOME" "$(getent passwd "$HOST_UID" | cut -d: -f1)"
else
  useradd -u "$HOST_UID" -g "$HOST_GID" -d "$HOST_HOME" -M -s /bin/sh majhi
fi
