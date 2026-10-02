import { createHash } from "node:crypto";
import type { SecretsKeyBackup } from "@majhi/shared";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { RunFn } from "./ssh.ts";

const SECURITY = "/usr/bin/security";
/** The Keychain item: Keychain Access lists it under this name. */
export const KEYCHAIN_SERVICE = "majhi secrets key";
export const KEYCHAIN_ACCOUNT = "secrets.key";
const KEYCHAIN_COMMENT = "Restores ~/.config/majhi/secrets.key, the key that decrypts ~/.majhi/secrets.age";
/** `security` exits with this when the item is not there. */
const NOT_FOUND = 44;
const CALL_TIMEOUT_MS = 15_000;
/** The whole identity line, so nothing in it can break the `security -i` command it goes into. */
const IDENTITY = /^AGE-SECRET-KEY-1[0-9A-Z]+$/;

/** The first 16 hex characters of the SHA-256 of the identity line. The server computes the same. */
export function keyFingerprint(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** The first `AGE-SECRET-KEY-1...` line of a key file, as the server reads it. */
export function identityOf(text: string | undefined): string | undefined {
  return text
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("AGE-SECRET-KEY-1"));
}

export interface KeychainDeps {
  run: RunFn;
  /** The file's text, or undefined when it does not exist. */
  readText: (path: string) => Promise<string | undefined>;
  /** The secrets key file on this Mac. */
  keyFile: string;
  platform: string;
  log: Logger;
  now?: () => Date;
}

export interface KeyBackup {
  /** The last look, for the poll header. Undefined off macOS and before the first look. */
  status(): SecretsKeyBackup | undefined;
  /** Saves the key when the Keychain holds none. Never replaces another key. Never throws. */
  ensure(): Promise<SecretsKeyBackup | undefined>;
  /** Saves the key file over whatever the Keychain holds, when the file is the `expected` key. */
  save(expected: string): Promise<SecretsKeyBackup>;
  /** The key the Keychain holds, to put back a lost key file. Undefined when there is none. */
  read(): Promise<string | undefined>;
}

/**
 * Keeps a copy of the secrets key in the login Keychain as a generic password. The key goes to
 * `security -i` on stdin, never in an argument, and is never logged or put in an error.
 */
export function createKeyBackup(deps: KeychainDeps): KeyBackup {
  const env = { PATH: "/usr/bin:/bin" };
  const now = deps.now ?? (() => new Date());
  let last: SecretsKeyBackup | undefined;

  const note = (saved: string | undefined, error?: string): SecretsKeyBackup => {
    last = {
      ...(saved === undefined ? {} : { saved: keyFingerprint(saved) }),
      ...(error === undefined ? {} : { error }),
      checkedAt: now().toISOString(),
    };
    return last;
  };

  const read = async (): Promise<string | undefined> => {
    const result = await deps.run(
      SECURITY,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { env, timeoutMs: CALL_TIMEOUT_MS },
    );
    if (result.code === NOT_FOUND) return undefined;
    if (result.code !== 0) throw new Error("The Keychain did not answer. Is it locked?");
    const identity = result.stdout.trim();
    return IDENTITY.test(identity) ? identity : undefined;
  };

  const write = async (identity: string): Promise<void> => {
    if (!IDENTITY.test(identity)) throw new Error("The secrets key file does not hold a key.");
    const command = [
      "add-generic-password",
      "-U",
      "-s",
      quote(KEYCHAIN_SERVICE),
      "-a",
      quote(KEYCHAIN_ACCOUNT),
      "-l",
      quote(KEYCHAIN_SERVICE),
      "-j",
      quote(KEYCHAIN_COMMENT),
      "-w",
      identity,
    ].join(" ");
    const result = await deps.run(SECURITY, ["-i"], {
      env,
      timeoutMs: CALL_TIMEOUT_MS,
      input: `${command}\nquit\n`,
    });
    // `security -i` can exit 0 after a failed command, so the copy is read back to be sure.
    if (result.code !== 0 || (await read()) !== identity) {
      throw new Error("The Keychain did not take the secrets key. Is it locked?");
    }
  };

  const fileKey = async (): Promise<string | undefined> => identityOf(await deps.readText(deps.keyFile));

  return {
    status: () => last,
    ensure: async () => {
      if (deps.platform !== "darwin") return undefined;
      try {
        const saved = await read();
        if (saved !== undefined) return note(saved);
        const key = await fileKey();
        if (key === undefined) return note(undefined);
        await write(key);
        deps.log("secrets key: saved a copy in the Keychain");
        return note(key);
      } catch (err) {
        const message = errorMessage(err);
        deps.log(`secrets key: ${message}`);
        return note(undefined, message);
      }
    },
    save: async (expected) => {
      if (deps.platform !== "darwin") throw new Error("Only a Mac has a Keychain to keep the key in.");
      const key = await fileKey();
      if (key === undefined) throw new Error(`There is no secrets key at ${deps.keyFile}.`);
      if (keyFingerprint(key) !== expected) {
        throw new Error(`The key at ${deps.keyFile} is not the key majhi uses, so it was not saved.`);
      }
      await write(key);
      deps.log("secrets key: saved a copy in the Keychain");
      return note(key);
    },
    read: () => (deps.platform === "darwin" ? read().catch(() => undefined) : Promise.resolve(undefined)),
  };
}

/** Quoted for the `security -i` command line. Only used on fixed strings. */
function quote(value: string): string {
  return `"${value}"`;
}
