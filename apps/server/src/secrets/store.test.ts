import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { generateKey, SECRETS_NOT_SET_UP, SecretStore } from "./store.ts";

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

  it("removes one secret and leaves the others", async () => {
    await store.set("a", "value-aaaa");
    await store.set("b", "value-bbbb");
    await store.delete("a");
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBe("value-bbbb");
  });

  it("says how to set up secrets when the key file is missing", async () => {
    const missing = new SecretStore(join(dir, "home"), join(dir, "nope.key"));
    expect(await missing.available()).toBe(false);
    await expect(missing.set("a", "value-aaaa")).rejects.toThrow(SECRETS_NOT_SET_UP);
    await expect(missing.delete("a")).resolves.toBeUndefined();
  });

  it("refuses a key that did not make the file", async () => {
    await store.set("a", "value-aaaa");
    const other = join(dir, "other.key");
    await writeKeyFile(other, await generateKey());
    await expect(new SecretStore(join(dir, "home"), other).get("a")).rejects.toThrow("Cannot decrypt");
  });

  it("reads the identity from a key file with comments", async () => {
    const identity = await generateKey();
    await writeFile(keyFile, `# created by test\n\n${identity}\n`);
    await store.set("a", "value-aaaa");
    expect(await new SecretStore(join(dir, "home"), keyFile).get("a")).toBe("value-aaaa");
  });
});
