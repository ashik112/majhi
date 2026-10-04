import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { errorMessage, UserError } from "../errors.ts";
import { defaultDir } from "./state.ts";

/** Mount points that are the container's own plumbing, not folders the owner shared. */
const SYSTEM_MOUNTS = ["/proc", "/sys", "/dev", "/etc", "/run", "/tmp"];

/** The mount points listed in `/proc/self/mountinfo` (field 5), without the root. */
export function mountPoints(mountinfo: string): string[] {
  const out: string[] = [];
  for (const line of mountinfo.split("\n")) {
    const point = line.split(" ")[4];
    if (point !== undefined && point !== "/") out.push(point.replace(/\\040/g, " "));
  }
  return out;
}

/**
 * In the server container, a folder is only the owner's disk if a bind mount covers it. Anything
 * else would be written into the container's own layer and vanish when the container is replaced.
 */
export function isMounted(path: string, mounts: readonly string[]): boolean {
  return mounts.some(
    (m) => !SYSTEM_MOUNTS.some((s) => m === s || m.startsWith(`${s}/`)) && (path === m || path.startsWith(`${m}/`)),
  );
}

export interface DestinationEnv {
  /** True inside the server container, where the mount check applies. */
  container: boolean;
  /** Contents of `/proc/self/mountinfo`. */
  mountinfo?: string;
}

export function hostDestinationEnv(): DestinationEnv {
  const container = existsSync("/.dockerenv");
  return container ? { container, mountinfo: readFileSync("/proc/self/mountinfo", "utf8") } : { container };
}

/**
 * Checks a folder the owner picked and returns its normalized path. It must be absolute, outside the
 * majhi home (the config history would otherwise pick the archives up and back them up again), on
 * the owner's disk and writable.
 */
export async function checkDestination(home: string, input: string, env: DestinationEnv): Promise<string> {
  if (!isAbsolute(input)) throw new UserError("Choose a folder by its full path.");
  const path = resolve(normalize(input));
  const rel = relative(home, path);
  const insideHome = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (insideHome && path !== defaultDir(home) && !path.startsWith(`${defaultDir(home)}/`)) {
    throw new UserError("Choose a folder outside the majhi home. Backups kept inside it would be backed up again.");
  }
  if (env.container && !isMounted(path, mountPoints(env.mountinfo ?? ""))) {
    throw new UserError(
      "majhi cannot reach that folder from its container. Add it as a workspace folder in Hub setup, then choose it again.",
    );
  }
  await probeWritable(path);
  return path;
}

/** Creates the folder if needed and writes and removes one small file, so a read-only or full disk shows now, not at 3 a.m. */
export async function probeWritable(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.majhi-write-test-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
  } catch (err) {
    throw new UserError(`majhi cannot write to ${dir}: ${errorMessage(err)}`, 409);
  }
}
