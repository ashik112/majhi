import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Dockerfile majhi checked, written to a folder of majhi's own so BuildKit reads those bytes and
 * not whatever the task's file holds a moment later. The folder is private to the build, outside every
 * task folder, and removed when the build ends.
 */
export interface DockerfileSnapshot {
  /** The file to pass to `--file`. */
  file: string;
  cleanup(): Promise<void>;
}

export async function snapshotDockerfile(text: string): Promise<DockerfileSnapshot> {
  const dir = await mkdtemp(join(tmpdir(), "majhi-build-"));
  const file = join(dir, "Dockerfile");
  try {
    await writeFile(file, text, { mode: 0o600 });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
