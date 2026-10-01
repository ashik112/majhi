import { readFile, stat, utimes, writeFile } from "node:fs/promises";
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
  it("stores a file under cache/uploads and tells images from files", async () => {
    const file = await store.save({ name: "a.txt", mime: "text/plain", data: data("hi") });
    const image = await store.save({ name: "b.png", mime: "IMAGE/PNG", data: data("x") });
    expect(file).toMatchObject({ kind: "file", name: "a.txt", mime: "text/plain", size: 2 });
    expect(image).toMatchObject({ kind: "image", mime: "image/png" });
    expect(store.dir).toBe(join(dir, "cache", "uploads"));
    expect((await stat(join(store.dir, `${file.id}.bin`))).isFile()).toBe(true);
  });

  it("moves an upload into a folder under a free name", async () => {
    const one = await store.save({ name: "a.txt", mime: "text/plain", data: data("one") });
    const two = await store.save({ name: "a.txt", mime: "text/plain", data: data("two") });
    const target = join(dir, "task", "attachments");
    expect(await store.take(one.id, target)).toMatchObject({ id: one.id, path: "a.txt", kind: "file" });
    expect(await store.take(two.id, target)).toMatchObject({ path: "a-2.txt" });
    expect(await readFile(join(target, "a-2.txt"), "utf8")).toBe("two");
    await expect(store.take(one.id, target)).rejects.toThrow("is gone");
    await expect(store.take("../../etc/passwd", target)).rejects.toThrow("is not an upload id");
  });

  it("refuses files over 20 MB", async () => {
    await expect(
      store.save({ name: "big.txt", mime: "", data: new Uint8Array(20 * 1024 * 1024 + 1) }),
    ).rejects.toThrow("over the limit of 20 MB");
  });

  it("removes uploads older than a day and keeps newer ones", async () => {
    const old = await store.save({ name: "old.txt", mime: "text/plain", data: data("o") });
    now += UPLOAD_MAX_AGE_MS - 1000;
    const fresh = await store.save({ name: "new.txt", mime: "text/plain", data: data("n") });
    now += 2000;
    expect(await store.sweep()).toBe(1);
    await expect(store.take(old.id, join(dir, "x"))).rejects.toThrow("is gone");
    expect(await store.take(fresh.id, join(dir, "x"))).toMatchObject({ path: "new.txt" });
  });

  it("removes a meta file that cannot be read by its age on disk", async () => {
    const orphan = join(store.dir, "9b2f3c1e-0000-4000-8000-000000000000.json");
    await store.save({ name: "a.txt", mime: "", data: data("a") });
    await writeFile(orphan, "not json");
    const long = new Date(now - UPLOAD_MAX_AGE_MS - 5000);
    await utimes(orphan, long, long);
    expect(await store.sweep()).toBe(1);
  });

  it("sweeps nothing when there is no cache folder yet", async () => {
    expect(await store.sweep()).toBe(0);
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
