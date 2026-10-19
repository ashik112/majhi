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
});
