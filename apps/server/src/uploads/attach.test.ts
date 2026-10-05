import { appendFile, mkdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { tempDir } from "../testing/fixtures.ts";
import { type AttachSource, planAttachments, takePlanned } from "./attach.ts";
import { UploadStore } from "./store.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** The captain calls a tool the way its MCP server does. */
const asBoss = (tool: string, args: Record<string, unknown>) =>
  w.h.majhi.services.admin.call({ task: w.chat.id, agent: "boss" }, tool, {
    ownerAsked: true,
    reason: "test",
    ...args,
  });

async function put(folder: string, rel: string, data: Uint8Array | string = PNG): Promise<string> {
  const path = join(folder, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
  return path;
}

async function upload(name: string, mime: string, data: Uint8Array | string = "x") {
  const form = new FormData();
  form.set(
    "file",
    new File([data] as unknown as ConstructorParameters<typeof File>[0], name, { type: mime }),
  );
  const res = await w.h.majhi.app.request("/api/uploads", { method: "POST", body: form });
  return { status: res.status, body: (await res.json()) as { id: string; error?: string } };
}

describe("attachment errors", () => {
  it("refuses a file outside the task folder, also through a symlink", async () => {
    w = await bossWorld({ real: false });
    const secret = await put(join(w.chat.folder, ".."), "outside/secret.txt", "no");
    await mkdir(join(w.chat.folder, "attachments"), { recursive: true });
    await symlink(secret, join(w.chat.folder, "attachments", "link.txt"));
    for (const path of [secret, "../outside/secret.txt", "attachments/link.txt"]) {
      const res = await asBoss("majhi_uploads_create", { path });
      expect(res.isError).toBe(true);
    }
  });

  it("refuses a type that is not allowed, and lists the allowed ones", async () => {
    w = await bossWorld({ real: false });
    await put(w.chat.folder, "attachments/run.exe", "MZ");
    const res = await asBoss("majhi_uploads_create", { path: "attachments/run.exe" });
    expect(res.isError).toBe(true);
    const http = await upload("run.exe", "application/x-msdownload");
    expect(http.status).toBe(400);
    // A mime type that contradicts the extension is refused too.
    expect((await upload("pic.png", "text/html")).status).toBe(400);
  });

  it("refuses a file over the size limit", async () => {
    w = await bossWorld({ real: false });
    const big = join(w.chat.folder, "attachments", "big.log");
    await mkdir(join(big, ".."), { recursive: true });
    await writeFile(big, new Uint8Array(20 * 1024 * 1024 + 1));
    const res = await asBoss("majhi_uploads_create", { path: "attachments/big.log" });
    expect(res.isError).toBe(true);
    const task = await asBoss("majhi_tasks_create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      attachments: ["attachments/big.log"],
      start: false,
    });
    expect(task.isError).toBe(true);
  });

  it("refuses files across orgs, in both directions", async () => {
    w = await bossWorld({ real: false });
    const acme = (
      await w.h.cmd("tasks.create", {
        text: "fix the bug in api",
        repos: [{ project: "acme-api" }],
        start: false,
      })
    ).body as Task;
    await put(acme.folder, "attachments/image.png");
    const inAcme = (tool: string, args: Record<string, unknown>) =>
      w.h.majhi.services.admin.call({ task: acme.id, agent: "acme-builder" }, tool, {
        ownerAsked: true,
        reason: "test",
        ...args,
      });

    // A file from an Acme task cannot go to a task with no org.
    const local = await inAcme("majhi_tasks_create", {
      text: "chat about it",
      kind: "chat",
      attachments: ["attachments/image.png"],
      start: false,
    });
    expect(local.isError).toBe(true);

    // An upload made in Acme cannot be attached to a task of another org.
    const made = await inAcme("majhi_uploads_create", { path: "attachments/image.png" });
    const id = (JSON.parse(made.text) as { id: string }).id;
    const other = await w.h.cmd("tasks.create", { text: "chat", kind: "chat", start: false });
    const sent = await w.h.cmd("room.send", { task: other.body.id, text: "here", attachments: [id] });
    expect(sent.status).toBe(400);

    // The same upload goes to an Acme task.
    const ok = await w.h.cmd("room.send", { task: acme.id, text: "here", attachments: [id] });
    expect(ok.status).toBe(200);
  });

  it("refuses a path from an HTTP caller, even one that sends a task in the meta header", async () => {
    w = await bossWorld({ real: false });
    await put(w.chat.folder, "attachments/image.png");
    const plain = await w.h.cmd("tasks.create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      attachments: ["attachments/image.png"],
      start: false,
    });
    expect(plain.status).toBe(400);
    const spoofed = await w.h.cmd(
      "tasks.create",
      {
        text: "fix the bug in api",
        repos: [{ project: "acme-api" }],
        attachments: ["attachments/image.png"],
        start: false,
      },
      { task: w.chat.id },
    );
    expect(spoofed.status).toBe(400);
    const uploadsCreate = await w.h.cmd(
      "uploads.create",
      { path: "attachments/image.png" },
      { task: w.chat.id },
    );
    expect(uploadsCreate.status).toBe(400);
  });
});

describe("a file swapped after it was checked", () => {
  async function setup() {
    const { dir, cleanup } = await tempDir();
    const folder = join(dir, "LOCAL-1");
    const source: AttachSource = { task: "LOCAL-1", folder, org: undefined };
    const secret = join(dir, "other-task", "key.txt");
    await mkdir(join(dir, "other-task"), { recursive: true });
    await writeFile(secret, "secret");
    await mkdir(join(folder, "attachments"), { recursive: true });
    await writeFile(join(folder, "attachments", "notes.txt"), "notes");
    const uploads = new UploadStore(dir);
    const into = join(dir, "LOCAL-2", "attachments");
    return { dir, folder, source, secret, uploads, into, cleanup };
  }

  it("refuses a file replaced by a symlink to a file outside the folder", async () => {
    const t = await setup();
    try {
      const planned = await planAttachments(t.uploads, ["attachments/notes.txt"], t.source, undefined);
      const path = join(t.folder, "attachments", "notes.txt");
      await rm(path);
      await symlink(t.secret, path);
      await expect(takePlanned(t.uploads, planned, t.into)).rejects.toThrow();
      await expect(stat(join(t.into, "notes.txt"))).rejects.toThrow();
    } finally {
      await t.cleanup();
    }
  });

  it("refuses a folder replaced by a symlink to a folder outside", async () => {
    const t = await setup();
    try {
      const planned = await planAttachments(t.uploads, ["attachments/notes.txt"], t.source, undefined);
      await writeFile(join(t.dir, "other-task", "notes.txt"), "stolen");
      await rename(join(t.folder, "attachments"), join(t.folder, "attachments-old"));
      await symlink(join(t.dir, "other-task"), join(t.folder, "attachments"));
      await expect(takePlanned(t.uploads, planned, t.into)).rejects.toThrow();
      await expect(stat(join(t.into, "notes.txt"))).rejects.toThrow();
    } finally {
      await t.cleanup();
    }
  });

  it("stops copying a file that grew past the limit after it was checked", async () => {
    const t = await setup();
    try {
      const planned = await planAttachments(t.uploads, ["attachments/notes.txt"], t.source, undefined);
      await appendFile(join(t.folder, "attachments", "notes.txt"), new Uint8Array(20 * 1024 * 1024 + 1));
      await expect(takePlanned(t.uploads, planned, t.into)).rejects.toThrow();
      await expect(stat(join(t.into, "notes.txt"))).rejects.toThrow();
    } finally {
      await t.cleanup();
    }
  });
});
