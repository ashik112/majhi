import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by the Playwright config, the server script and the tests. */
export const E2E_PORT = Number(process.env.MAJHI_E2E_PORT ?? 7071);

/** Recreated on every run by `start-server.ts`. Real path, so macOS /var -> /private/var does not leak in. */
export const E2E_ROOT = join(
  realpathSync(tmpdir()),
  E2E_PORT === 7071 ? "majhi-e2e" : `majhi-e2e-${E2E_PORT}`,
);

/** Stands in for the owner's home on the host (`HOST_HOME`). */
export const HOST_HOME = join(E2E_ROOT, "home");

/** majhi's config folder (`MAJHI_HOME`). */
export const MAJHI_HOME = join(HOST_HOME, ".majhi");

/** The age identity for `secrets.age`, outside `MAJHI_HOME` like the container's secret. */
export const SECRETS_KEY_FILE = join(E2E_ROOT, "secrets", "key");

/** While this file exists, majhi's network probe says offline (`MAJHI_NET_PROBE=file:...`). */
export const OFFLINE_FILE = join(E2E_ROOT, "offline");
