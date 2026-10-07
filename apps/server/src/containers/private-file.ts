import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A file of majhi's own in a new folder only majhi can read, outside every task folder. */
export interface PrivateFile {
  file: string;
  /** Removes the file and its folder. Safe to call twice. */
  cleanup(): Promise<void>;
}

export async function writePrivateFile(prefix: string, name: string, text: string): Promise<PrivateFile> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const file = join(dir, name);
  try {
    await writeFile(file, text, { mode: 0o600 });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
