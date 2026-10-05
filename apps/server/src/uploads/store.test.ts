import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { safeName, UPLOAD_MAX_AGE_MS, UploadStore } from "./store.ts";

let dir: string;
let cleanup: () => Promise<void>;
let now = Date.now();
let store: UploadStore;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  now = Date.now();
  store = new UploadStore(dir, () => now);
});
afterEach(() => cleanup());

const data = (text: string) => new TextEncoder().encode(text);

describe("UploadStore", () => {
  it("moves an upload into a folder under a free name", async () => {
    const one = await store.save({ name: "a.txt", mime: "text/plain", data: data("one") });
    const two = await store.save({ name: "a.txt", mime: "text/plain", data: data("two") });
    const target = join(dir, "task", "attachments");
    expect(await store.take(one.id, target)).toMatchObject({ id: one.id, path: "a.txt", kind: "file" });
    expect(await store.take(two.id, target)).toMatchObject({ path: "a-2.txt" });
    expect(await readFile(join(target, "a-2.txt"), "utf8")).toBe("two");
    await expect(store.take(one.id, target)).rejects.toThrow();
    await expect(store.take("../../etc/passwd", target)).rejects.toThrow();
  });

  it("refuses files over 20 MB", async () => {
    await expect(
      store.save({ name: "big.txt", mime: "", data: new Uint8Array(20 * 1024 * 1024 + 1) }),
    ).rejects.toThrow();
  });

  it("removes uploads older than a day and keeps newer ones", async () => {
    const old = await store.save({ name: "old.txt", mime: "text/plain", data: data("o") });
    now += UPLOAD_MAX_AGE_MS - 1000;
    const fresh = await store.save({ name: "new.txt", mime: "text/plain", data: data("n") });
    now += 2000;
    expect(await store.sweep()).toBe(1);
    await expect(store.take(old.id, join(dir, "x"))).rejects.toThrow();
    expect(await store.take(fresh.id, join(dir, "x"))).toMatchObject({ path: "new.txt" });
  });
});

describe("safeName", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\dir\\file.txt", "file.txt"],
    [".hidden", "hidden"],
    ["a<b>c?.txt", "a_b_c_.txt"],
    ["", "file"],
    ["x".repeat(300), "x".repeat(120)],
  ])("%s becomes %s", (input, output) => {
    expect(safeName(input)).toBe(output);
  });
});
