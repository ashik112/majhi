#!/bin/sh
# Runs every check a change must pass. Used by `make ci` and CI.
set -eu
# Do not pipe this script (e.g. through tail): the pipe hides its exit code.

pnpm install --frozen-lockfile
pnpm exec biome check .
pnpm -r typecheck
pnpm exec tsc -p e2e
pnpm exec vitest run
pnpm --filter @majhi/web build
pnpm --filter @majhi/server build
# The image already has Chromium; download it only when it is missing.
[ -d "${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}" ] || pnpm exec playwright install chromium
pnpm exec playwright test
