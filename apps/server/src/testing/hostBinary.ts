import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const HOST = join(REPO, "apps/host");

/** The newest change among the Go sources of the host helper (`go.mod`, `go.sum` and every `.go` file). */
function newestSource(path: string): number {
  const info = statSync(path);
  if (!info.isDirectory())
    return path.endsWith(".go") || path.endsWith("go.mod") || path.endsWith("go.sum") ? info.mtimeMs : 0;
  let latest = 0;
  for (const entry of readdirSync(path)) {
    if (entry === "dist" || entry === "node_modules") continue;
    latest = Math.max(latest, newestSource(join(path, entry)));
  }
  return latest;
}

/**
 * The host helper built for this computer's OS and CPU: `apps/host/dist/majhi-host-<os>-<arch>`, or with
 * `contract` the helper over a fake platform that the contract test runs. A binary that is missing, or
 * older than a Go source, is built first with scripts/build-host.sh (Go in a container), so a test never
 * runs a helper that is not the code on disk.
 */
export function hostBinary(kind: "helper" | "contract"): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const file = join(HOST, "dist", `${kind === "contract" ? "contract" : "majhi-host"}-${os}-${arch}`);
  if (!existsSync(file) || statSync(file).mtimeMs < newestSource(HOST)) {
    execFileSync(
      "sh",
      [join(REPO, "scripts/build-host.sh"), ...(kind === "contract" ? ["--contract"] : []), `${os}/${arch}`],
      {
        stdio: "inherit",
        timeout: 600_000,
      },
    );
  }
  return file;
}
