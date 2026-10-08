import { createHash } from "node:crypto";
import { chmod, copyFile, link, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fake programs that start fast. On macOS the first run of every new executable file costs 200 to
 * 400 ms (the system scans it), however small it is; a hard link to a file that already ran is
 * free. So a fake is written once per content, in a folder that outlives the test run, and each test
 * gets a hard link to it. The fake must not name its own path: it finds what it needs next to itself
 * (`$0`, `process.argv[1]`), which a hard link keeps.
 */
const FOLDER = join(tmpdir(), "majhi-fast-bin");

/** The shared copy of an executable with this content, made if no test has made it. */
export async function sharedExecutable(content: string): Promise<string> {
  const path = join(FOLDER, createHash("sha1").update(content).digest("hex").slice(0, 20));
  if (
    await stat(path).then(
      () => true,
      () => false,
    )
  )
    return path;
  await mkdir(FOLDER, { recursive: true });
  // Other test files make the same file at once: write apart, then rename into place.
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, content, { mode: 0o755 });
  await chmod(temp, 0o755);
  await rename(temp, path);
  return path;
}

/** Puts `master` at `dest` as a hard link, or a copy where the folders are on different disks. */
export async function linkExecutable(master: string, dest: string): Promise<void> {
  await rm(dest, { force: true });
  await link(master, dest).catch(async () => {
    await copyFile(master, dest);
    await chmod(dest, 0o755);
  });
}

/** Writes `content` at `dest` as an executable, fast. */
export async function writeFastExecutable(dest: string, content: string): Promise<void> {
  await linkExecutable(await sharedExecutable(content), dest);
}
