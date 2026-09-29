import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared by the Playwright config, the server script and the tests. */
export const E2E_PORT = 7071;

/** Recreated on every run by `start-server.ts`. Real path, so macOS /var -> /private/var does not leak in. */
export const E2E_ROOT = join(realpathSync(tmpdir()), "majhi-e2e");

/** Stands in for the owner's home on the host (`HOST_HOME`). */
export const HOST_HOME = join(E2E_ROOT, "home");

/** majhi's config folder (`MAJHI_HOME`). */
export const MAJHI_HOME = join(HOST_HOME, ".majhi");
