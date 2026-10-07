import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import type { TaskDockerErrorCode } from "@majhi/shared";
import { assertReadable, refuse, type Safety, shown } from "./args.ts";

/**
 * The one way majhi reads a file whose path a task controls (an env file, a compose file, a
 * Dockerfile). A task can make a FIFO, a socket or a file on a slow mount, and a plain `readFileSync`
 * on a FIFO blocks the server's event loop forever. So: the path must lead (symlinks followed) inside
 * the task folder, it is opened without waiting for a writer (`O_NONBLOCK`), it must be a regular
 * file, and it is read asynchronously, up to a byte cap, within a time limit.
 */
export interface TaskFileLimits {
  /** The most bytes read. A bigger file is refused. */
  maxBytes: number;
  /** The longest the read may take. */
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const CHUNK = 64 * 1024;

export async function readTaskFile(
  path: string,
  safety: Safety,
  what: string,
  outside: TaskDockerErrorCode,
  limits: TaskFileLimits,
): Promise<string> {
  assertReadable(path, safety, what, outside);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return refuse(`The ${what} ${shown(path)} does not exist.`, outside === "refused" ? "refused" : outside);
  }
  const timeout = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The ${what} ${shown(path)} could not be read in ${timeout} ms.`)),
      timeout,
    );
  });
  const read = (async () => {
    // O_NONBLOCK: opening a FIFO for reading returns at once instead of waiting for a writer.
    const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return refuse(`The ${what} ${shown(path)} is not a regular file.`);
      if (stat.size > limits.maxBytes) return refuse(`The ${what} ${shown(path)} is too big.`);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(CHUNK, limits.maxBytes + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > limits.maxBytes) return refuse(`The ${what} ${shown(path)} is too big.`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      await handle.close().catch(() => undefined);
    }
  })();
  try {
    return await Promise.race([read, expired]);
  } catch (err) {
    // The loser of the race must not leave an unhandled rejection behind.
    read.catch(() => undefined);
    if (err instanceof Error && err.message.includes("could not be read in")) return refuse(err.message);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
