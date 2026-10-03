import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SKILL_MAX_BYTES, SKILL_MAX_FILES } from "@majhi/shared";
import { UserError } from "../errors.ts";
import { isInside } from "./files.ts";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

const BAD = "That is not a zip file majhi can read.";

/**
 * Extracts a zip into `dest`. Every entry's path is checked before anything is written: no absolute
 * paths, no `..`, no backslashes, no drive letters, and the resolved target must lie inside `dest`
 * (the zip-slip check). Symlinks, encrypted entries and zip64 are refused, and the entry count and
 * the unpacked size are capped, so a zip bomb stops early.
 */
export async function extractZip(data: Uint8Array, dest: string): Promise<string[]> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const root = resolve(dest);
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new UserError("Zip64 archives are not supported.");
  if (count > SKILL_MAX_FILES * 4)
    throw new UserError(`The zip has more than ${SKILL_MAX_FILES * 4} entries.`);

  const written: string[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new UserError(BAD);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const mode = buf.readUInt32LE(at + 38) >>> 16;
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    const target = entryTarget(root, name);
    if (target === undefined) continue; // a folder entry, or a macOS metadata file
    if ((mode & S_IFMT) === S_IFLNK)
      throw new UserError(`${name} is a symlink. Zips with links are refused.`);
    if ((mode & S_IFMT) === S_IFDIR) continue;
    if ((flags & 1) !== 0) throw new UserError(`${name} is encrypted.`);
    total += size;
    if (total > SKILL_MAX_BYTES)
      throw new UserError(`The zip unpacks to more than ${SKILL_MAX_BYTES / 1024 / 1024} MB.`);

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new UserError(BAD);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) {
      try {
        content = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new UserError(`${name} could not be unpacked.`);
      }
    } else throw new UserError(`${name} uses a compression method majhi does not support.`);
    if (content.length !== size) throw new UserError(`${name} does not match its recorded size.`);

    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, content, { mode: (mode & 0o111) !== 0 ? 0o755 : 0o644 });
    written.push(name);
  }
  return written;
}

/** Where an entry goes inside `root`, or undefined for an entry to skip. Throws for a path that is not allowed. */
function entryTarget(root: string, name: string): string | undefined {
  if (name.endsWith("/")) return undefined;
  if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) return undefined;
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new UserError(`The zip has a path that is not allowed: ${JSON.stringify(name)}.`);
  }
  if (name.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new UserError(`The zip has a path that leaves its folder: ${JSON.stringify(name)}.`);
  }
  const target = resolve(root, name);
  if (target === root || !isInside(target, root)) {
    throw new UserError(`The zip has a path that leaves its folder: ${JSON.stringify(name)}.`);
  }
  return join(root, ...name.split("/"));
}

function findEnd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new UserError(BAD);
}
