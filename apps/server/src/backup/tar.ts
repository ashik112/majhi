import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/** Level 3 keeps a database-sized backup quick; SQLite pages compress about as well at 3 as at 9. */
const GZIP_LEVEL = 3;

/** macOS `tar` would add `._` files for extended attributes; this keeps the archive to the files themselves. */
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: "1" };

/**
 * A folder as a gzip-compressed tar stream. The stream ends only after `tar` exited cleanly and
 * errors when it did not, so a half archive is never mistaken for a whole one.
 */
export function packDir(dir: string): Readable {
  const tar = spawn("tar", ["-cf", "-", "-C", dir, "."], { env: TAR_ENV, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  tar.stderr.on("data", (c: Buffer) => {
    if (stderr.length < 2000) stderr += c.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar could not pack the backup (${code}): ${stderr.trim()}`)),
    );
  });
  exited.catch(() => undefined);
  const gzip = tar.stdout.pipe(createGzip({ level: GZIP_LEVEL }));
  return Readable.from(
    (async function* () {
      for await (const chunk of gzip) yield chunk as Buffer;
      await exited;
    })(),
  );
}

/**
 * Unpacks a gzip-compressed tar stream into an existing, empty folder. Entries that climb out of the
 * folder (`..`, absolute paths) are refused by `tar` itself; the caller checks the result against the
 * manifest, so nothing outside the list survives.
 */
export async function unpackTo(source: Readable, dir: string): Promise<void> {
  const tar = spawn("tar", ["-xf", "-", "-C", dir, "--no-same-owner"], {
    env: TAR_ENV,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  tar.stderr.on("data", (c: Buffer) => {
    if (stderr.length < 2000) stderr += c.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar could not unpack the backup: ${stderr.trim()}`)),
    );
  });
  // tar may stop reading (and close its stdin) on a bad entry; its exit code then says why.
  tar.stdin.on("error", () => undefined);
  try {
    await pipeline(source, createGunzip(), tar.stdin);
  } catch (err) {
    tar.kill();
    await exited.catch(() => undefined);
    throw err;
  }
  await exited;
}
