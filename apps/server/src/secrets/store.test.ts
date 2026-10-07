import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { generateKey, SecretStore } from "./store.ts";

describe("SecretStore", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let store: SecretStore;
  let keyFile: string;

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    keyFile = join(dir, "config", "secrets.key");
    await writeKeyFile(keyFile, await generateKey());
    await mkdir(join(dir, "home"));
    store = new SecretStore(join(dir, "home"), keyFile);
  });
  afterEach(() => cleanup());

  it("round trips values and keeps them out of the file", async () => {
    await store.set("claude-a", "sk-test-fake-0000");
    await store.set("codex-b", "sk-test-fake-1111");

    expect(await store.get("claude-a")).toBe("sk-test-fake-0000");
    expect(await store.get("codex-b")).toBe("sk-test-fake-1111");
    expect(await store.get("missing")).toBeUndefined();

    const raw = await readFile(store.file);
    expect(raw.includes("sk-test-fake")).toBe(false);
    expect(raw.includes("claude-a")).toBe(false);
  });

  it("refuses a key that did not make the file", async () => {
    await store.set("a", "value-aaaa");
    const other = join(dir, "other.key");
    await writeKeyFile(other, await generateKey());
    await expect(new SecretStore(join(dir, "home"), other).get("a")).rejects.toThrow("Cannot decrypt");
  });

  it("tells whether the key file opens secrets.age", async () => {
    const identity = await generateKey();
    await writeKeyFile(keyFile, identity);
    const none = join(dir, "none.key");
    expect(await new SecretStore(join(dir, "home"), none).keyState()).toBe("missing");
    expect(await store.keyState()).toBe("ok");
    expect(await store.opens(await generateKey())).toBe(true);
    await store.set("a", "value-aaaa");
    expect(await store.keyState()).toBe("ok");
    expect(await new SecretStore(join(dir, "home"), none).keyState()).toBe("lost");
    // A folder where the key file should be, as Docker makes for a missing one.
    await mkdir(join(dir, "folder.key"));
    expect(await new SecretStore(join(dir, "home"), join(dir, "folder.key")).keyState()).toBe("lost");
    const other = join(dir, "other.key");
    await writeKeyFile(other, await generateKey());
    const wrong = new SecretStore(join(dir, "home"), other);
    expect(await wrong.keyState()).toBe("wrong");
    expect(await wrong.opens(identity)).toBe(true);
    expect(await wrong.opens(await generateKey())).toBe(false);
  });
});
