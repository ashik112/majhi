import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SecretsKeyLineSchema, type SecretsKeyRestore } from "@majhi/shared";
import { Decrypter, identityToRecipient } from "age-encryption";
import { errorCode, errorMessage } from "./errors.ts";
import { identityOf, keyFingerprint } from "./keyBackup.ts";
import type { Logger } from "./log.ts";

export const NOT_A_KEY = "The restored key is not a secrets key, so the key file was left as it is.";
export const DOES_NOT_OPEN = "The restored key does not open secrets.age, so the key file was left as it is.";
export const KEY_FILE_WORKS = "The key file already holds a working key, so it was not replaced.";
/** More old key files with the same second than anyone makes by hand. */
const ASIDE_TRIES = 100;

export interface KeyFiles {
  /** The secrets key file Docker mounts into majhi. */
  keyFile: string;
  /** `<MAJHI_HOME>/secrets.age`, the file the key opens. */
  secretsFile: string;
  now?: () => Date;
}

export interface KeyWrite {
  /** False when the key file already held this key. */
  written: boolean;
  /** Where the old key file went. */
  keptAside?: string;
}

/**
 * Writes a restored secrets key to the key file, mode 600 in a folder of mode 700. Only when the
 * file is missing or its key does not open secrets.age, and only a key that opens secrets.age.
 * Before there is a secrets.age, any valid key in the file counts as working. Whatever was at the
 * path (a file, or the folder Docker makes for a missing one) is renamed aside, never deleted.
 * Errors are fixed sentences or file errors: never the key.
 */
export async function writeRestoredKey(key: string, files: KeyFiles): Promise<KeyWrite> {
  if (!(await isIdentity(key))) throw new Error(NOT_A_KEY);
  const sealed = await readOptional(files.secretsFile);
  if (sealed !== undefined && !(await opens(key, sealed))) throw new Error(DOES_NOT_OPEN);
  const current = await currentKey(files.keyFile);
  const works =
    current !== undefined &&
    (sealed === undefined ? await isIdentity(current) : await opens(current, sealed));
  if (works) {
    if (current === key) return { written: false };
    throw new Error(KEY_FILE_WORKS);
  }

  const folder = dirname(files.keyFile);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const temp = `${files.keyFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // `wx`: never follows or reuses a file that is already there.
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${key}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    const aside = await keepAside(files.keyFile, (files.now ?? (() => new Date()))());
    try {
      await rename(temp, files.keyFile);
    } catch (err) {
      // Put the old file back, so a failed restore leaves the folder as it was.
      if (aside !== undefined) await rename(aside, files.keyFile).catch(() => undefined);
      throw err;
    }
    return aside === undefined ? { written: true } : { written: true, keptAside: aside };
  } finally {
    await rm(temp, { force: true });
  }
}

export interface KeyRestorerDeps extends KeyFiles {
  /** Recreates majhi's server so Docker mounts the key file again. Undefined when the helper cannot run Docker. */
  restart: (() => Promise<void>) | undefined;
  /** Saves the key file to the OS keyring when it holds the key with this fingerprint. Undefined to keep no copy. */
  saveToKeyring: ((fingerprint: string) => Promise<unknown>) | undefined;
  log: Logger;
}

export interface KeyRestoreRun {
  result: SecretsKeyRestore;
  /** Restarts majhi, then saves the key to the keyring. Run after the reply. Never throws. */
  after: () => Promise<void>;
}

/**
 * The `secretsKey.restore` job: writes the key under the guard of {@link writeRestoredKey}, one
 * restore at a time. What it logs never holds the key.
 */
export function createKeyRestorer(
  deps: KeyRestorerDeps,
): (params: { key: string }) => Promise<KeyRestoreRun> {
  let queue: Promise<unknown> = Promise.resolve();
  return (params) => {
    const run = queue.then(() => restore(params.key, deps));
    queue = run.catch(() => undefined);
    return run;
  };
}

async function restore(key: string, deps: KeyRestorerDeps): Promise<KeyRestoreRun> {
  const { restart, saveToKeyring, log } = deps;
  const write = await writeRestoredKey(key, deps);
  log(
    write.written
      ? `secrets key: restored from its export${write.keptAside === undefined ? "" : `, the old file is ${write.keptAside}`}`
      : "secrets key: the key file already holds the restored key",
  );
  const fingerprint = keyFingerprint(key);
  return {
    result: { ...write, restarts: restart !== undefined },
    after: async () => {
      if (restart !== undefined) {
        await restart().then(
          () => log("secrets key: restarted majhi to load the key"),
          (err: unknown) => log(`secrets key: ${errorMessage(err)}`),
        );
      }
      await saveToKeyring?.(fingerprint).catch((err: unknown) => log(`secrets key: ${errorMessage(err)}`));
    },
  };
}

/** True for one `AGE-SECRET-KEY-1...` line age reads as an X25519 identity. */
async function isIdentity(line: string): Promise<boolean> {
  if (!SecretsKeyLineSchema.safeParse(line).success) return false;
  try {
    await identityToRecipient(line);
    return true;
  } catch {
    return false;
  }
}

async function opens(identity: string, sealed: Uint8Array): Promise<boolean> {
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    await decrypter.decrypt(sealed);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(file: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

/** The key line in the key file, as the server reads it. Undefined when there is no file or no key in it. */
async function currentKey(keyFile: string): Promise<string | undefined> {
  try {
    return identityOf(await readFile(keyFile, "utf8"));
  } catch (err) {
    if (errorCode(err) === "ENOENT" || errorCode(err) === "EISDIR") return undefined;
    throw err;
  }
}

/** Renames what is at the key file's path to `<file>.old-<UTC time>`. Undefined when nothing is there. */
async function keepAside(keyFile: string, now: Date): Promise<string | undefined> {
  if (!(await present(keyFile))) return undefined;
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  for (let n = 1; n <= ASIDE_TRIES; n++) {
    const aside = `${keyFile}.old-${stamp}${n === 1 ? "" : `-${n}`}`;
    if (await present(aside)) continue;
    await rename(keyFile, aside);
    return aside;
  }
  throw new Error(`Too many old key files next to ${keyFile}. Move some away and try again.`);
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}
