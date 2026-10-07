import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A name safe to put in a path: letters, digits, dot, dash and underscore. */
export function safeName(name: string): string {
  let out = "";
  for (const ch of name.split("/").pop() ?? "file") {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "-" ||
      ch === "_";
    out += ok ? ch : "_";
  }
  while (out.startsWith(".")) out = out.slice(1);
  return out === "" ? "file" : out.slice(0, 80);
}

/** Writes a fetched file into the connection's folder, readable by the owner only. */
export async function saveFetched(
  dir: string,
  name: string,
  data: Uint8Array,
  type: string,
): Promise<{ path: string; type: string; bytes: number }> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID().slice(0, 8)}-${safeName(name)}`);
  await writeFile(path, data, { mode: 0o600 });
  return { path, type, bytes: data.byteLength };
}
