import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_TOKEN_FILE } from "@majhi/shared";
import { errorCode } from "./errors.ts";

/**
 * Returns the token in `<majhiHome>/host.token`, creating the folder and the
 * token (32 random bytes as hex, readable by the owner only) when missing.
 */
export async function ensureToken(majhiHome: string): Promise<string> {
  await mkdir(majhiHome, { recursive: true });
  const file = join(majhiHome, HOST_TOKEN_FILE);
  const existing = await readToken(file);
  if (existing !== undefined && existing !== "") return existing;

  const token = randomBytes(32).toString("hex");
  try {
    // `wx` never replaces a token another process wrote a moment ago.
    await writeFile(file, `${token}\n`, { mode: 0o600, flag: existing === undefined ? "wx" : "w" });
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
    return (await readToken(file)) ?? token;
  }
  // `mode` only applies when the file is created. An empty file left behind keeps its old mode otherwise.
  await chmod(file, 0o600);
  return token;
}

/** The trimmed token, or undefined when the file does not exist. */
async function readToken(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}
