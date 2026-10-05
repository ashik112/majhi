import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskId } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { pickValue, readInRoots } from "./clipboard-copy.ts";

vi.setConfig({ testTimeout: 30_000 });

const KEY = "Zq-live-9f2c41d7a8b35e60";

describe("pickValue", () => {
  const text = `# keys\nAPI_KEY="${KEY}"\nexport TOKEN=abc==  # rotate monthly\nname: ${KEY}\n${KEY}\n\n`;

  it("says why there is no value, without the line's text", () => {
    for (const [line, part] of [
      [99, "whole"],
      [6, "whole"],
      [5, "value"],
    ] as const) {
      const out = pickValue(text, line, part);
      expect("problem" in out).toBe(true);
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  });
});

describe("readInRoots", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads a file inside a root, and refuses one outside it or reached through a link", async () => {
    dir = await mkdtemp(join(tmpdir(), "clip-"));
    const root = join(dir, "api");
    const elsewhere = join(dir, "other");
    await mkdir(root);
    await mkdir(elsewhere);
    await writeFile(join(root, ".env"), `API_KEY=${KEY}\n`);
    await writeFile(join(elsewhere, ".env"), "OTHER=1\n");
    await symlink(join(elsewhere, ".env"), join(root, "link.env"));

    expect(await readInRoots(join(root, ".env"), [root])).toEqual({ text: `API_KEY=${KEY}\n` });
    for (const path of [join(elsewhere, ".env"), join(root, "link.env"), join(root, "..", "other", ".env")]) {
      const out = await readInRoots(path, [root]);
      expect(out).toHaveProperty("problem");
    }
    expect(await readInRoots("relative/.env", [root])).toHaveProperty("problem");
    expect(await readInRoots(root, [root])).toHaveProperty("problem");
  });
});

describe("the captain copying to the owner's clipboard", () => {
  let w: BossWorld | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await w?.cleanup();
    w = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function lane(connected = true) {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { admin, secrets } = h.majhi.services;
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await h.majhi.services.autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    dir = await mkdtemp(join(tmpdir(), "clip-"));
    await writeFile(join(dir, ".env"), `API_KEY="${KEY}"\n`);
    const copied: string[] = [];
    const roots: string[] = [];
    admin.useClipboard({
      roots: async (org) => {
        roots.push(org);
        return org === "acme" ? [dir as string] : [];
      },
      available: () => connected,
      copy: async (text) => {
        copied.push(text);
        return true;
      },
    });
    const call = (args: Record<string, unknown>, caller = { task: chat, agent: "boss" }) =>
      admin.call(caller, "majhi_clipboard_copy", { ownerAsked: true, reason: "the owner asked", ...args });
    const everything = async () =>
      JSON.stringify([await w?.items(chat), (await h.cmd("audit.list", {})).body]);
    return { h, chat, copied, roots, call, secrets, everything, dir };
  }

  it("copies a line of a project file and the value shows nowhere else", async () => {
    const t = await lane();
    const res = await t.call({ file: join(t.dir, ".env"), line: 1, part: "value" });
    expect(res.isError).toBe(false);
    expect(t.copied).toEqual([KEY]);
    expect(res.text).not.toContain(KEY);
    expect(await t.everything()).not.toContain(KEY);
  });

  it("refuses without ownerAsked, outside the lane's projects, for an agent, and with no helper", async () => {
    const t = await lane();
    const file = join(t.dir, ".env");
    expect((await t.call({ file, line: 1, ownerAsked: false })).isError).toBe(true);
    expect((await t.call({ file: import.meta.filename, line: 1 })).isError).toBe(true);
    expect((await t.call({ secret: "missing" })).isError).toBe(true);
    expect(
      (await t.call({ file, line: 1 }, { task: t.chat as TaskId, agent: "acme-builder" })).isError,
    ).toBe(true);
    expect(t.copied).toEqual([]);
    const off = await lane(false);
    expect((await off.call({ file: join(off.dir, ".env"), line: 1 })).isError).toBe(true);
    expect(off.copied).toEqual([]);
  });
});
