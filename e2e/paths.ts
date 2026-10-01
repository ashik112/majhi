import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where an e2e server keeps its throwaway home. Shared by `start-server.ts`, the fixture and the specs.
 *
 * - The fixture gives every Playwright worker its own folder (per worker process) and passes it to
 *   the server it starts as `MAJHI_E2E_ROOT`.
 * - A server started on its own (the screenshot configs, `memory-seed.ts`) uses a folder named after
 *   `MAJHI_E2E_PORT`.
 *
 * Real paths, so macOS /var -> /private/var does not leak in.
 */
const TMP = realpathSync(tmpdir());

/** The port of a server started on its own, outside the fixture. */
export const E2E_PORT = Number(process.env.MAJHI_E2E_PORT ?? 7071);

const inWorker = process.env.TEST_WORKER_INDEX !== undefined;

/** Recreated each time `start-server.ts` starts. */
export const E2E_ROOT =
  process.env.MAJHI_E2E_ROOT ??
  (inWorker ? join(TMP, `majhi-e2e-w${process.pid}`) : join(TMP, `majhi-e2e-${E2E_PORT}`));

/** Stands in for the owner's home on the host (`HOST_HOME`). */
export const HOST_HOME = join(E2E_ROOT, "home");

/** majhi's config folder (`MAJHI_HOME`). */
export const MAJHI_HOME = join(HOST_HOME, ".majhi");

/** The age identity for `secrets.age`, outside `MAJHI_HOME` like the container's secret. */
export const SECRETS_KEY_FILE = join(E2E_ROOT, "secrets", "key");

/** While this file exists, majhi's network probe says offline (`MAJHI_NET_PROBE=file:...`). */
export const OFFLINE_FILE = join(E2E_ROOT, "offline");
