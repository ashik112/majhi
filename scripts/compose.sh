#!/bin/sh
# `docker compose` in this checkout with the environment up.sh gives it (lib.sh compose_env), for
# `make down`, `make logs` and `make doctor`.
#
#   sh scripts/compose.sh <compose arguments>
set -eu

REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_DIR"
. scripts/lib.sh
compose_env
exec docker compose "$@"
