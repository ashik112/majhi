import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_TOKEN_FILE } from "@majhi/shared";

/**
 * True when the `Authorization` header carries the token from
 * `<majhiHome>/host.token`. The file is read on every request, so a new token
 * works at once. Without the file, nothing is authorized.
 */
export async function isHostAuthorized(header: string | undefined, majhiHome: string): Promise<boolean> {
  const given = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
  if (given === undefined) return false;
  let expected: string;
  try {
    expected = (await readFile(join(majhiHome, HOST_TOKEN_FILE), "utf8")).trim();
  } catch {
    return false;
  }
  if (expected === "") return false;
  // Hashing gives both sides the same length, which timingSafeEqual needs.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
