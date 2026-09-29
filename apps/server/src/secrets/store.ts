import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { z } from "zod";
import { errorCode, UserError } from "../errors.ts";

export const SECRETS_FILE_NAME = "secrets.age";
export const SECRETS_NOT_SET_UP = "Secrets are not set up: run make up";

/** Decrypted content of secrets.age: secret name to value. */
const SecretsSchema = z.record(z.string(), z.string());
type Secrets = z.infer<typeof SecretsSchema>;

const IDENTITY_PREFIX = "AGE-SECRET-KEY-1";

/** A new age identity, one line, for `majhi gen-key`. */
export function generateKey(): Promise<string> {
  return generateIdentity();
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
    private readonly keyFile: string,
  ) {
    this.file = join(majhiHome, SECRETS_FILE_NAME);
  }

  /** True when the key file exists and holds an identity. */
  async available(): Promise<boolean> {
    return (await this.readIdentity()) !== undefined;
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.read())[name];
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
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
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(this.file));
    } catch (err) {
      if (errorCode(err) === "ENOENT") return {};
      throw err;
    }
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
