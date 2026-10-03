import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (message: string) => void;

/** The log is moved to `<file>.1` when the next line would take it past this size. */
export const LOG_MAX_BYTES = 1_000_000;

/**
 * Appends timestamped lines to `file`, keeping one older file (`<file>.1`).
 * Writes are synchronous, so lines stay in order and survive a crash.
 */
export function createFileLogger(file: string, maxBytes = LOG_MAX_BYTES): Logger {
  mkdirSync(dirname(file), { recursive: true });
  return (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (process.stdout.isTTY) process.stdout.write(line);
    try {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, line);
    } catch (err) {
      // Logging must never stop the helper. The login service appends stderr to host.out.
      process.stderr.write(`majhi-host: cannot write ${file}: ${String(err)}\n${line}`);
    }
  };
}
