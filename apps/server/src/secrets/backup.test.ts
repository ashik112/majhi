import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { KeyExports } from "./backup.ts";
import { generateKey, SecretStore } from "./store.ts";

describe("KeyExports", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let keyFile: string;
  let store: SecretStore;
  let exports: KeyExports;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    keyFile = join(dir, "config", "secrets.key");
    await writeKeyFile(keyFile, await generateKey());
    await mkdir(join(dir, "home"));
    store = new SecretStore(join(dir, "home"), keyFile);
    exports = new KeyExports(join(dir, "home"), store, () => new Date("2026-10-02T10:00:00Z"));
  });
  afterEach(() => cleanup());

  it("remembers which key it exported, and never the passphrase or the key", async () => {
    expect(await exports.last()).toBeUndefined();
    const out = await exports.export("correct horse battery");
    expect(out.fileName).toBe("majhi-secrets-key.age");
    expect(await exports.last()).toEqual({
      fingerprint: await store.fingerprint(),
      exportedAt: "2026-10-02T10:00:00.000Z",
    });
    const record = await readFile(join(dir, "home", "secrets-key-backup.json"), "utf8");
    expect(record).not.toContain("correct horse");
    expect(record).not.toContain("AGE-SECRET-KEY");
  });

});
