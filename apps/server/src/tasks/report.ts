import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "../errors.ts";

export const REPORT_FILE = "REPORT.md";

/** A report is text for people to read. Past this size something else is in the file. */
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export interface Report {
  content: string;
  modifiedAt: string;
}

/**
 * `<task folder>/REPORT.md`, or undefined while the agent has not written it. Only that one name is
 * served. The agent shares the folder, so it could make the file a link to something else: the file
 * is opened without following a link, and a link or anything but a regular file is refused.
 */
export async function readReport(folder: string): Promise<Report | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(join(folder, REPORT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    if (code === "ELOOP") throw refused();
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refused();
    if (info.size > MAX_REPORT_BYTES) {
      throw new UserError(`${REPORT_FILE} is too large to show (over 2 MB).`, 409);
    }
    return { content: await handle.readFile("utf8"), modifiedAt: info.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

function refused(): UserError {
  return new UserError(`${REPORT_FILE} must be a regular file in the task folder, not a link.`, 409);
}
