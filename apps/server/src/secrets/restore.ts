import { KEY_EXPORT_FILE_NAME, SecretsKeyLineSchema, type SecretsKeyRestore } from "@majhi/shared";
import { armor, Decrypter, identityToRecipient } from "age-encryption";
import { errorMessage, UserError } from "../errors.ts";
import { keyFingerprint, type SecretStore } from "./store.ts";

/** The scrypt work factor of majhi's export and of `age -p`. More would cost the server a GB of memory. */
const EXPORT_MAX_LOG_N = 18;

export const NOT_AN_EXPORT = `This is not a secrets key export. Choose the ${KEY_EXPORT_FILE_NAME} file that Export key saved.`;
export const WRONG_PASSPHRASE = "The passphrase does not open this file.";
export const UNREADABLE = "This file could not be opened. It may be damaged.";
export const NO_KEY_INSIDE = "The file opened, but it does not hold a secrets key.";
export const NOT_THIS_KEY =
  "This key does not open secrets.age, so it was not restored. Use the export of the key that made secrets.age.";
export const KEY_WORKS = "majhi's key file already works, so it was not replaced.";
export const ALREADY_IN_USE = "majhi already uses this key. Nothing to restore.";

/** The work factor in the export's `-> scrypt <salt> <logN>` line. Undefined when it has none. */
function scryptWorkFactor(sealed: Uint8Array): number | undefined {
  const header = new TextDecoder().decode(sealed.subarray(0, 512));
  const match = /^-> scrypt \S+ (\d+)$/m.exec(header);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The secrets key inside an export: the armored, passphrase-protected age file `secrets.exportKey`
 * makes. It must hold exactly one `AGE-SECRET-KEY-1...` line; comment lines are skipped. Errors are
 * fixed sentences: they never hold the passphrase, the key or the file.
 */
export async function decryptKeyExport(content: string, passphrase: string): Promise<string> {
  let sealed: Uint8Array;
  try {
    sealed = armor.decode(content);
  } catch {
    throw new UserError(NOT_AN_EXPORT, 400);
  }
  const logN = scryptWorkFactor(sealed);
  if (logN === undefined || logN > EXPORT_MAX_LOG_N) throw new UserError(NOT_AN_EXPORT, 400);
  const decrypter = new Decrypter();
  decrypter.addPassphrase(passphrase);
  let text: string;
  try {
    text = await decrypter.decrypt(sealed, "text");
  } catch (err) {
    // age says this when the passphrase unwraps nothing. Anything else is a damaged file.
    const wrong = errorMessage(err).includes("no identity matched");
    throw new UserError(wrong ? WRONG_PASSPHRASE : UNREADABLE, 400);
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const key = lines.length === 1 ? SecretsKeyLineSchema.safeParse(lines[0]) : undefined;
  if (key?.success !== true) throw new UserError(NO_KEY_INSIDE, 400);
  try {
    // Checks the key's checksum and length, so a damaged line never reaches the key file.
    await identityToRecipient(key.data);
  } catch {
    throw new UserError(NO_KEY_INSIDE, 400);
  }
  return key.data;
}

export interface KeyRestoreDeps {
  secrets: SecretStore;
  /** Asks the host helper to write the key to the key file and restart majhi (`secretsKey.restore`). */
  writeKey: (key: string) => Promise<SecretsKeyRestore>;
}

/**
 * `secrets.restoreKey`: opens the export with its passphrase, checks that its key opens secrets.age,
 * and has the host helper write it to the key file. Only when majhi's own key is missing or does
 * not open secrets.age; the helper checks the key file on the host again before it writes.
 */
export async function restoreKey(
  input: { content: string; passphrase: string },
  { secrets, writeKey }: KeyRestoreDeps,
): Promise<{ detail: string }> {
  const key = await decryptKeyExport(input.content, input.passphrase);
  if (!(await secrets.opens(key))) throw new UserError(NOT_THIS_KEY, 409);
  if ((await secrets.keyState()) === "ok") {
    if ((await secrets.fingerprint()) === keyFingerprint(key)) return { detail: ALREADY_IN_USE };
    throw new UserError(KEY_WORKS, 409);
  }
  return { detail: restoredDetail(await writeKey(key)) };
}

function restoredDetail(result: SecretsKeyRestore): string {
  const done = result.written ? "Restored the secrets key." : "The key file already holds this key.";
  const load = result.restarts
    ? "majhi restarts to load it and is back in a few seconds."
    : "Run `make up` in the majhi folder once to load it.";
  const aside = result.keptAside === undefined ? "" : ` The old key file is kept as ${result.keptAside}.`;
  return `${done} ${load}${aside}`;
}
