import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsKeyRestore } from "@majhi/shared";
import { armor, Encrypter } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { KEY_WORKS, restoreKey } from "./restore.ts";
import { generateKey, SecretStore } from "./store.ts";

const PASSPHRASE = "correct horse battery";

/** An export like majhi's, with a small work factor so the tests stay fast. */
async function exportOf(text: string, passphrase = PASSPHRASE): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  encrypter.setScryptWorkFactor(10);
  return armor.encode(await encrypter.encrypt(text));
}

describe("restoreKey", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let keyFile: string;
  let store: SecretStore;
  let sent: string[];
  let reply: SecretsKeyRestore;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    keyFile = join(dir, "config", "secrets.key");
    await mkdir(join(dir, "home"));
    store = new SecretStore(join(dir, "home"), keyFile);
    sent = [];
    reply = { written: true, restarts: true };
  });
  afterEach(() => cleanup());

  const writeKey = async (key: string) => {
    sent.push(key);
    return reply;
  };
  /** secrets.age made with this key, which then leaves the key file. */
  async function sealWith(key: string): Promise<void> {
    const sealer = join(dir, "sealer.key");
    await writeKeyFile(sealer, key);
    await new SecretStore(join(dir, "home"), sealer).set("acme-api", "value-1");
  }

  it("never replaces a key file that works", async () => {
    const key = await generateKey();
    await writeKeyFile(keyFile, key);
    // Before there is a secrets.age, any key opens it, so only the working key file stops the restore.
    const other = await exportOf(`${await generateKey()}\n`);
    await expect(
      restoreKey({ content: other, passphrase: PASSPHRASE }, { secrets: store, writeKey }),
    ).rejects.toThrow(KEY_WORKS);
    await sealWith(key);
    const same = await exportOf(`${key}\n`);
    await restoreKey({ content: same, passphrase: PASSPHRASE }, { secrets: store, writeKey });
    expect(sent).toEqual([]);
  });
});
