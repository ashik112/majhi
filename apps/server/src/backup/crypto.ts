import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Decrypter, Encrypter, identityToRecipient } from "age-encryption";
import { errorMessage, UserError } from "../errors.ts";

/**
 * What locks a backup: the secrets key (the default, so the same key that opens secrets.age opens
 * the backups) or a passphrase the owner typed for one backup. Neither is ever written to disk here.
 */
export type Lock =
  | { kind: "key"; identity: string }
  /** `logN` is the scrypt cost; the default is the age default. Only tests lower it. */
  | { kind: "passphrase"; passphrase: string; logN?: number };

/** age's own default scrypt work factor, about a second per attempt. */
const SCRYPT_LOG_N = 18;

/** The backup is fine but this key or passphrase does not open it. Not a sign of damage. */
export class Locked extends UserError {}

/** Node streams carry bytes; age's streaming API is web streams. These two bridge them. */
function toWeb(stream: Readable): ReadableStream<Uint8Array> {
  // Readable.toWeb types its chunks as `any`; a byte stream carries Uint8Array.
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

function fromWeb(stream: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(stream as unknown as WebReadableStream<Uint8Array>);
}

/** The encrypted bytes of `plain`, as a stream. Memory stays flat however large the backup is. */
export async function encryptStream(plain: Readable, lock: Lock): Promise<Readable> {
  const encrypter = new Encrypter();
  if (lock.kind === "key") {
    encrypter.addRecipient(await identityToRecipient(lock.identity));
  } else {
    encrypter.setScryptWorkFactor(lock.logN ?? SCRYPT_LOG_N);
    encrypter.setPassphrase(lock.passphrase);
  }
  return fromWeb(await encrypter.encrypt(toWeb(plain)));
}

/**
 * The plain bytes of an encrypted stream. A wrong key or passphrase fails here, before any data
 * flows; a damaged or cut-off file fails when the stream reaches the damage.
 */
export async function decryptStream(sealed: Readable, lock: Lock): Promise<Readable> {
  const decrypter = new Decrypter();
  if (lock.kind === "key") decrypter.addIdentity(lock.identity);
  else decrypter.addPassphrase(lock.passphrase);
  try {
    return fromWeb(await decrypter.decrypt(toWeb(sealed)));
  } catch (err) {
    sealed.destroy();
    throw new Locked(
      lock.kind === "key"
        ? "The secrets key on this computer does not open this backup. Restore the key first, or use the passphrase it was made with."
        : "That passphrase does not open this backup.",
      409,
      [errorMessage(err)],
    );
  }
}

/** How an age file is locked, read from its header: `scrypt` is a passphrase, anything else a key. */
export async function lockOf(file: string): Promise<"key" | "passphrase" | "none"> {
  const head = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(file, { start: 0, end: 255 });
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
  if (!head.startsWith("age-encryption.org/v1\n")) return "none";
  return /^-> scrypt /m.test(head) ? "passphrase" : "key";
}
