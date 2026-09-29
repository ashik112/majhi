#!/bin/sh
# Runs every check a change must pass. Used by `make ci` and CI.
set -eu

pnpm install --frozen-lockfile
pnpm exec biome check .
pnpm -r typecheck
pnpm exec tsc -p e2e
pnpm exec vitest run
pnpm --filter @majhi/web build
pnpm --filter @majhi/server build
pnpm exec playwright install chromium
pnpm exec playwright test
