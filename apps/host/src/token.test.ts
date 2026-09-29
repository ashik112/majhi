import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureToken } from "./token.ts";

describe("ensureToken", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-host-test-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("creates the config folder and a 32-byte hex token only the owner can read", async () => {
    const majhiHome = join(dir, "home", ".majhi");
    const token = await ensureToken(majhiHome);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const file = join(majhiHome, "host.token");
    expect(await readFile(file, "utf8")).toBe(`${token}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing token", async () => {
    const first = await ensureToken(dir);
    expect(await ensureToken(dir)).toBe(first);
  });

  it("replaces an empty token file and tightens its mode", async () => {
    const file = join(dir, "host.token");
    await writeFile(file, "\n", { mode: 0o644 });
    const token = await ensureToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
