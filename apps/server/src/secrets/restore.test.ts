import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SecretsKeyRestore } from "@majhi/shared";
import { armor, Encrypter, identityToRecipient } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The round trip runs the host helper's own write, as majhi does on the owner's computer.
import { createKeyRestorer } from "../../../host/src/keyRestore.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { KeyExports } from "./backup.ts";
import {
  ALREADY_IN_USE,
  decryptKeyExport,
  KEY_WORKS,
  NO_KEY_INSIDE,
  NOT_AN_EXPORT,
  NOT_THIS_KEY,
  restoreKey,
  UNREADABLE,
  WRONG_PASSPHRASE,
} from "./restore.ts";
import { generateKey, keyFingerprint, SecretStore } from "./store.ts";

const PASSPHRASE = "correct horse battery";
const BECH32 = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";

/** An export like majhi's, with a small work factor so the tests stay fast. */
async function exportOf(text: string, passphrase = PASSPHRASE): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  encrypter.setScryptWorkFactor(10);
  return armor.encode(await encrypter.encrypt(text));
}

/** The armored file with its bytes changed. The header is ASCII, so text indexes are byte indexes. */
function edited(content: string, edit: (sealed: Uint8Array, header: string) => void): string {
  const sealed = armor.decode(content);
  edit(sealed, new TextDecoder().decode(sealed.subarray(0, 200)));
  return armor.encode(sealed);
}

/** The error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof Error)) throw new Error("It did not fail.");
  return err;
}

describe("decryptKeyExport", () => {
  it("opens an export and skips comment lines, like those age-keygen writes", async () => {
    const key = await generateKey();
    expect(await decryptKeyExport(await exportOf(`${key}\n`), PASSPHRASE)).toBe(key);
    const recipient = await identityToRecipient(key);
    const keygen = `# created: 2026-10-02T10:00:00Z\n# public key: ${recipient}\n${key}\n`;
    expect(await decryptKeyExport(`\r\n${await exportOf(keygen)}\r\n`, PASSPHRASE)).toBe(key);
  });

  it("tells a wrong passphrase from a damaged file, and never puts either secret in the error", async () => {
    const key = await generateKey();
    const content = await exportOf(`${key}\n`);
    const wrong = await failure(decryptKeyExport(content, "not the passphrase"));
    expect(wrong.message).toBe(WRONG_PASSPHRASE);
    const damaged = edited(content, (sealed) => {
      sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    });
    const unreadable = await failure(decryptKeyExport(damaged, PASSPHRASE));
    expect(unreadable.message).toBe(UNREADABLE);
    for (const err of [wrong, unreadable]) {
      expect(`${err.message} ${err.stack}`).not.toContain(PASSPHRASE);
      expect(`${err.message} ${err.stack}`).not.toContain("AGE-SECRET-KEY");
    }
  });

  it("refuses what is not a passphrase export before it spends the work factor", async () => {
    const key = await generateKey();
    await expect(decryptKeyExport("AGE-SECRET-KEY-1 is not a file", PASSPHRASE)).rejects.toThrow(
      NOT_AN_EXPORT,
    );
    const toRecipient = new Encrypter();
    toRecipient.addRecipient(await identityToRecipient(key));
    const forRecipient = armor.encode(await toRecipient.encrypt(`${key}\n`));
    await expect(decryptKeyExport(forRecipient, PASSPHRASE)).rejects.toThrow(NOT_AN_EXPORT);
    // Work factor 19 takes 512 MB to open: more than an export of majhi's or `age -p` ever asks.
    const costly = edited(await exportOf(`${key}\n`), (bytes, header) => {
      const at = header.indexOf(" 10\n");
      bytes.set(new TextEncoder().encode(" 19"), at);
    });
    await expect(decryptKeyExport(costly, PASSPHRASE)).rejects.toThrow(NOT_AN_EXPORT);
  });

  it("refuses a file without exactly one sound key", async () => {
    const key = await generateKey();
    const at = 30;
    const flipped = BECH32[(BECH32.indexOf(key[at] ?? "Q") + 1) % BECH32.length] ?? "Q";
    const damagedKey = `${key.slice(0, at)}${flipped}${key.slice(at + 1)}`;
    for (const text of ["hello\n", `${key}\n${await generateKey()}\n`, `${damagedKey}\n`, "\n"]) {
      await expect(decryptKeyExport(await exportOf(text), PASSPHRASE)).rejects.toThrow(NO_KEY_INSIDE);
    }
  });
});

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

  it("restores when there is no key file, or the key file does not open secrets.age", async () => {
    const key = await generateKey();
    const content = await exportOf(`${key}\n`);
    expect(await restoreKey({ content, passphrase: PASSPHRASE }, { secrets: store, writeKey })).toEqual({
      detail: "Restored the secrets key. majhi restarts to load it and is back in a few seconds.",
    });
    await sealWith(key);
    await restoreKey({ content, passphrase: PASSPHRASE }, { secrets: store, writeKey });
    await writeKeyFile(keyFile, await generateKey());
    reply = { written: true, keptAside: `${keyFile}.old-20261002T100000Z`, restarts: false };
    expect(await restoreKey({ content, passphrase: PASSPHRASE }, { secrets: store, writeKey })).toEqual({
      detail: `Restored the secrets key. Run \`make up\` in the majhi folder once to load it. The old key file is kept as ${keyFile}.old-20261002T100000Z.`,
    });
    expect(sent).toEqual([key, key, key]);
  });

  it("refuses a key that does not open secrets.age", async () => {
    await sealWith(await generateKey());
    const content = await exportOf(`${await generateKey()}\n`);
    const err = await failure(restoreKey({ content, passphrase: PASSPHRASE }, { secrets: store, writeKey }));
    expect(err.message).toBe(NOT_THIS_KEY);
    expect(sent).toEqual([]);
  });

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
    expect(await restoreKey({ content: same, passphrase: PASSPHRASE }, { secrets: store, writeKey })).toEqual(
      {
        detail: ALREADY_IN_USE,
      },
    );
    expect(sent).toEqual([]);
  });

  it("round trips: an export restored into a new home reads secrets.age again", async () => {
    // The old computer: a key, a secret in secrets.age, and the export.
    const old = join(dir, "old");
    const key = await generateKey();
    await writeKeyFile(join(old, ".config", "majhi", "secrets.key"), key);
    const oldStore = new SecretStore(join(old, ".majhi"), join(old, ".config", "majhi", "secrets.key"));
    await oldStore.set("acme-api", "value-1");
    const { content } = await new KeyExports(join(old, ".majhi"), oldStore).export(PASSPHRASE);

    // The new computer: secrets.age copied over, and the new key `make up` made.
    const home = join(dir, "new");
    const newKeyFile = join(home, ".config", "majhi", "secrets.key");
    await mkdir(join(home, ".majhi"), { recursive: true });
    await copyFile(oldStore.file, join(home, ".majhi", "secrets.age"));
    await writeKeyFile(newKeyFile, await generateKey());
    const secrets = new SecretStore(join(home, ".majhi"), newKeyFile);
    expect(await secrets.keyState()).toBe("wrong");

    const events: string[] = [];
    const logs: string[] = [];
    const helper = createKeyRestorer({
      keyFile: newKeyFile,
      secretsFile: secrets.file,
      now: () => new Date("2026-10-02T10:00:00.250Z"),
      restart: async () => {
        events.push("restart");
      },
      saveToKeyring: async (fingerprint) => {
        events.push(`keyring ${fingerprint}`);
      },
      log: (line) => logs.push(line),
    });
    let after: () => Promise<void> = async () => undefined;
    const out = await restoreKey(
      { content, passphrase: PASSPHRASE },
      {
        secrets,
        writeKey: async (restored) => {
          const run = await helper({ key: restored });
          after = run.after;
          return run.result;
        },
      },
    );
    await after();

    const aside = `${newKeyFile}.old-20261002T100000Z`;
    expect(out.detail).toBe(
      `Restored the secrets key. majhi restarts to load it and is back in a few seconds. The old key file is kept as ${aside}.`,
    );
    expect(await secrets.keyState()).toBe("ok");
    expect(await secrets.get("acme-api")).toBe("value-1");
    expect(await secrets.fingerprint()).toBe(keyFingerprint(key));
    expect((await stat(newKeyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(newKeyFile))).mode & 0o777).toBe(0o700);
    expect((await readdir(dirname(newKeyFile))).sort()).toEqual([
      "secrets.key",
      "secrets.key.old-20261002T100000Z",
    ]);
    expect(events).toEqual(["restart", `keyring ${keyFingerprint(key)}`]);
    for (const text of [out.detail, ...logs]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain(PASSPHRASE);
    }
  });
});
