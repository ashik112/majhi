import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { armor, Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { z } from "zod";
import { errorCode, UserError } from "../errors.ts";

export const SECRETS_FILE_NAME = "secrets.age";
export const SECRETS_NOT_SET_UP = "Secrets are not set up: run make up";

/** Decrypted content of secrets.age: secret name to value. */
const SecretsSchema = z.record(z.string(), z.string());
type Secrets = z.infer<typeof SecretsSchema>;

const IDENTITY_PREFIX = "AGE-SECRET-KEY-1";

/** The first 16 hex characters of the SHA-256 of an identity line. The host helper computes the same. */
export function keyFingerprint(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** A new age identity, one line, for `majhi gen-key`. */
export function generateKey(): Promise<string> {
  return generateIdentity();
}

/**
 * How the key file and secrets.age fit together.
 * - `ok`: the key file holds a key that opens secrets.age, or there is no secrets.age yet.
 * - `missing`: no key and no secrets.age. `make up` makes a new key.
 * - `lost`: no key, but secrets.age exists. Only its own key can read it.
 * - `wrong`: the key file holds a key that does not open secrets.age.
 */
export type SecretsKeyState = "ok" | "missing" | "lost" | "wrong";

/** True when the identity decrypts the file. False for a line age cannot read as an identity. */
async function decrypts(identity: string, sealed: Uint8Array): Promise<boolean> {
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    await decrypter.decrypt(sealed);
    return true;
  } catch {
    return false;
  }
}

/**
 * API keys, encrypted with age in `<majhi home>/secrets.age`. The identity
 * lives in a separate key file outside the majhi home, so the file it protects
 * never sits next to it. Values are never logged and never returned to callers
 * other than `get`.
 */
export class SecretStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;

  constructor(
    majhiHome: string,
    readonly keyFile: string,
  ) {
    this.file = join(majhiHome, SECRETS_FILE_NAME);
  }

  /** True when the key file exists and holds an identity. */
  async available(): Promise<boolean> {
    return (await this.readIdentity()) !== undefined;
  }

  /** The key's fingerprint, to compare it with a backup. Undefined when secrets are not set up. */
  async fingerprint(): Promise<string | undefined> {
    const identity = await this.readIdentity();
    return identity === undefined ? undefined : keyFingerprint(identity);
  }

  /** Whether there is a key, and whether it opens secrets.age. */
  async keyState(): Promise<SecretsKeyState> {
    const identity = await this.readIdentity();
    const sealed = await this.readSealed();
    if (identity === undefined) return sealed === undefined ? "missing" : "lost";
    if (sealed === undefined) return "ok";
    return (await decrypts(identity, sealed)) ? "ok" : "wrong";
  }

  /** True when this identity opens secrets.age, or when there is no secrets.age yet. */
  async opens(identity: string): Promise<boolean> {
    const sealed = await this.readSealed();
    return sealed === undefined || (await decrypts(identity, sealed));
  }

  /**
   * The key file's content, encrypted with a passphrase (age scrypt) and armored, so it can leave
   * this computer. `age -d` with the passphrase gives back a key file majhi reads as is.
   */
  async exportKey(passphrase: string): Promise<string> {
    const identity = await this.requireIdentity();
    const encrypter = new Encrypter();
    encrypter.setPassphrase(passphrase);
    return armor.encode(await encrypter.encrypt(`${identity}\n`));
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.read())[name];
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  /** Names of every secret, sorted. Empty when secrets are not set up. Values are not returned. */
  async names(): Promise<string[]> {
    if (!(await this.available())) return [];
    return Object.keys(await this.read()).sort();
  }

  /** The name of a secret that holds exactly this value, so a pasted value is not saved twice. */
  async findName(value: string): Promise<string | undefined> {
    if (!(await this.available())) return undefined;
    return Object.entries(await this.read()).find(([, v]) => v === value)?.[0];
  }

  set(name: string, value: string): Promise<void> {
    return this.serialize(async () => {
      const secrets = await this.read();
      secrets[name] = value;
      await this.write(secrets);
    });
  }

  /** Removes a secret. Does nothing when there is none, or when the key file is missing. */
  delete(name: string): Promise<void> {
    return this.serialize(async () => {
      if (!(await this.available())) return;
      const secrets = await this.read();
      if (!(name in secrets)) return;
      delete secrets[name];
      await this.write(secrets);
    });
  }

  private async read(): Promise<Secrets> {
    const identity = await this.requireIdentity();
    const bytes = await this.readSealed();
    if (bytes === undefined) return {};
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    let text: string;
    try {
      text = await decrypter.decrypt(bytes, "text");
    } catch {
      throw new UserError(
        `Cannot decrypt ${SECRETS_FILE_NAME} with the key at ${this.keyFile}. Is it the key that made the file?`,
        409,
      );
    }
    return SecretsSchema.parse(JSON.parse(text));
  }

  /** secrets.age as it is on disk. Undefined when there is none yet. */
  private async readSealed(): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.file));
    } catch (err) {
      if (errorCode(err) === "ENOENT") return undefined;
      throw err;
    }
  }

  private async write(secrets: Secrets): Promise<void> {
    const identity = await this.requireIdentity();
    const encrypter = new Encrypter();
    encrypter.addRecipient(await identityToRecipient(identity));
    const bytes = await encrypter.encrypt(JSON.stringify(secrets));
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true });
    }
  }

  private async requireIdentity(): Promise<string> {
    const identity = await this.readIdentity();
    if (identity === undefined) throw new UserError(SECRETS_NOT_SET_UP, 409);
    return identity;
  }

  /** The first `AGE-SECRET-KEY-1...` line of the key file. Comment lines are skipped. */
  private async readIdentity(): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(this.keyFile, "utf8");
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "EISDIR") return undefined;
      throw err;
    }
    return text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(IDENTITY_PREFIX));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
