import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

/** Where Docker Desktop, OrbStack and Homebrew put `docker`. A LaunchAgent's PATH may lack them. */
const TOOL_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];

/** The current PATH with the usual tool folders added, each folder once. */
export function toolPath(current: string | undefined): string {
  const dirs = [...(current ?? "").split(":"), ...TOOL_DIRS].filter((d) => d !== "");
  return [...new Set(dirs)].join(":");
}

/** The absolute path of the first executable `name` on `path`, or undefined. */
export async function findExecutable(name: string, path: string): Promise<string | undefined> {
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here. Try the next folder.
    }
  }
  return undefined;
}
