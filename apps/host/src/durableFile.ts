import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Persist the contents before publishing a journal. Unix also persists the directory entry. */
export async function writeDurableText(file: string, text: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    if (process.platform !== "win32") {
      const dir = await open(dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}

export function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

export async function writeDurableJson(file: string, value: unknown): Promise<void> {
  await writeDurableText(file, JSON.stringify(value));
}

export async function removeDurableFile(file: string): Promise<void> {
  await rm(file, { force: true });
  if (process.platform !== "win32") {
    const dir = await open(dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
