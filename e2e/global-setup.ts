import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DIST_INDEX = join(REPO, "apps/web/dist/index.html");
/** What the web build reads. */
const SOURCES = ["apps/web/src", "apps/web/public", "apps/web/index.html", "apps/web/vite.config.ts", "packages/shared/src"];

function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = stat.mtimeMs;
  for (const entry of readdirSync(path)) latest = Math.max(latest, newest(join(path, entry)));
  return latest;
}

/**
 * Builds the web app once per run, for every worker's server. Skipped when `apps/web/dist` is newer
 * than everything the build reads.
 */
export default function globalSetup(): void {
  const built = existsSync(DIST_INDEX) ? statSync(DIST_INDEX).mtimeMs : 0;
  const changed = Math.max(...SOURCES.map((s) => newest(join(REPO, s))));
  if (built > changed) return;
  execFileSync("pnpm", ["--filter", "@majhi/web", "build"], { cwd: REPO, stdio: "inherit" });
}
