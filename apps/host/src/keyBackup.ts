import { createHash } from "node:crypto";
import type { KeyringState, SecretsKeyBackup } from "@majhi/shared";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";
import { type Keyring, SECRETS_KEY_ITEM } from "./platform/types.ts";

/** The whole identity line, so nothing in it can break the keyring call it goes into. */
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

/** A keyring check as the log shows it. */
function shown(state: KeyringState): string {
  return state.kind === "none" ? `none, ${state.reason}` : state.kind;
}

export interface KeyBackupDeps {
  keyring: Keyring;
  /** How messages name the keyring: `keyringName(os)`, "the Keychain" or "the keyring". */
  where: string;
  /** The file's text, or undefined when it does not exist. */
  readText: (path: string) => Promise<string | undefined>;
  /** The secrets key file on this computer. */
  keyFile: string;
  log: Logger;
  now?: () => Date;
}

export interface KeyBackup {
  /** The last look, for the poll header. Undefined before the first look and while no keyring runs. */
  status(): SecretsKeyBackup | undefined;
  /** The last keyring check, for the poll header. Undefined before the first. */
  keyring(): KeyringState | undefined;
  /** How messages name the keyring. */
  where: string;
  /**
   * Checks the keyring, then saves the key when it holds none. Never replaces another key. Does
   * nothing while no keyring runs. Never throws.
   */
  ensure(): Promise<SecretsKeyBackup | undefined>;
  /** Saves the key file over whatever the keyring holds, when the file is the `expected` key. */
  save(expected: string): Promise<SecretsKeyBackup>;
  /** The key the keyring holds, to put back a lost key file. Undefined when there is none. */
  read(): Promise<string | undefined>;
}

/**
 * Keeps a copy of the secrets key in the OS keyring: the login Keychain on macOS, a Secret Service
 * keyring on Linux and WSL2. The keyring takes the key on stdin, never in an argument, and the key
 * is never logged or put in an error.
 */
export function createKeyBackup(deps: KeyBackupDeps): KeyBackup {
  const now = deps.now ?? (() => new Date());
  let last: SecretsKeyBackup | undefined;
  let state: KeyringState | undefined;

  const note = (saved: string | undefined, error?: string): SecretsKeyBackup => {
    last = {
      ...(saved === undefined ? {} : { saved: keyFingerprint(saved) }),
      ...(error === undefined ? {} : { error }),
      checkedAt: now().toISOString(),
    };
    return last;
  };

  /** Asks whether a keyring answers, and logs the answer when it changed. */
  const check = async (): Promise<KeyringState> => {
    const next = await deps.keyring.check();
    if (state === undefined || shown(state) !== shown(next)) deps.log(`keyring: ${shown(next)}`);
    state = next;
    if (next.kind === "none") last = undefined;
    return next;
  };

  const read = async (): Promise<string | undefined> => {
    const identity = (await deps.keyring.read(SECRETS_KEY_ITEM))?.trim();
    return identity !== undefined && IDENTITY.test(identity) ? identity : undefined;
  };

  const write = async (identity: string): Promise<void> => {
    if (!IDENTITY.test(identity)) throw new Error("The secrets key file does not hold a key.");
    await deps.keyring.write(SECRETS_KEY_ITEM, identity);
    deps.log(`secrets key: saved a copy in ${deps.where}`);
  };

  const fileKey = async (): Promise<string | undefined> => identityOf(await deps.readText(deps.keyFile));

  return {
    status: () => last,
    keyring: () => state,
    where: deps.where,
    ensure: async () => {
      try {
        if ((await check()).kind === "none") return undefined;
        const saved = await read();
        if (saved !== undefined) return note(saved);
        const key = await fileKey();
        if (key === undefined) return note(undefined);
        await write(key);
        return note(key);
      } catch (err) {
        const message = errorMessage(err);
        deps.log(`secrets key: ${message}`);
        return note(undefined, message);
      }
    },
    save: async (expected) => {
      const keyring = await check();
      if (keyring.kind === "none")
        throw new Error(`No keyring is running on this computer: ${keyring.reason}`);
      const key = await fileKey();
      if (key === undefined) throw new Error(`There is no secrets key at ${deps.keyFile}.`);
      if (keyFingerprint(key) !== expected) {
        throw new Error(`The key at ${deps.keyFile} is not the key majhi uses, so it was not saved.`);
      }
      await write(key);
      return note(key);
    },
    read: () => read().catch(() => undefined),
  };
}
