import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { UserError } from "../../errors.ts";

/** Entries of a folder a path watch looks at, at most. A bigger tree is fingerprinted by what was seen. */
export const PATH_ENTRY_LIMIT = 5_000;
/** Folders a path watch does not look into: they change on their own and say nothing about the project. */
const SKIPPED = new Set([".git", "node_modules"]);
/** The most of a page that is read. */
export const URL_BODY_LIMIT = 1_000_000;
export const URL_TIMEOUT_MS = 15_000;

/**
 * A fingerprint of a file or folder inside `checkout`: size and modification time of the file, or of
 * every file in the folder. `missing` when it is not there. A path that leaves the checkout, by
 * `..` or by a link, is refused.
 */
export async function pathPrint(checkout: string, path: string): Promise<string> {
  const root = await realpath(checkout);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new UserError(`"${path}" is outside the project.`);
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return "missing";
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new UserError(`"${path}" leads outside the project.`);
  }
  const info = await stat(real);
  if (!info.isDirectory()) return `file ${info.size} ${Math.trunc(info.mtimeMs)}`;
  const hash = createHash("sha256");
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (seen >= PATH_ENTRY_LIMIT) return;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      let file: Awaited<ReturnType<typeof stat>>;
      try {
        file = await stat(join(dir, entry.name));
      } catch {
        continue; // gone since the listing
      }
      seen += 1;
      hash.update(`${relative(real, join(dir, entry.name))}\0${file.size}\0${Math.trunc(file.mtimeMs)}\n`);
    }
  };
  await walk(real);
  return `dir ${seen} ${hash.digest("hex").slice(0, 16)}`;
}

/** The status and a hash of the first megabyte of the body. A failed request throws. */
export async function urlPrint(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    headers: { "user-agent": "majhi-watch" },
  });
  const hash = createHash("sha256");
  let read = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    while (read < URL_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      hash.update(
        read > URL_BODY_LIMIT ? value.subarray(0, value.byteLength - (read - URL_BODY_LIMIT)) : value,
      );
    }
    await reader.cancel().catch(() => undefined);
  }
  return `${response.status} ${hash.digest("hex").slice(0, 16)}`;
}
