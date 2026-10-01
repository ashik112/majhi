import { appendFile, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

/** The boss calls a tool the way its MCP server does. */
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

const taskMd = (task: Task) => readFile(join(task.folder, "TASK.md"), "utf8");

describe("attachments by upload id and by path", () => {
  it("puts an upload id and a path in attachments/ and in TASK.md when a task is created", async () => {
    w = await bossWorld({ real: false });
    await put(w.chat.folder, "attachments/image.png");
    const owner = await upload("notes.txt", "text/plain", "hello");
    expect(owner.status).toBe(200);

    const made = await asBoss("majhi_tasks_create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      attachments: [owner.body.id, "attachments/image.png"],
      start: false,
    });
    expect(made.isError).toBe(false);
    const task = (await w.h.cmd("tasks.list")).body[0] as { id: string };
    const full = (await w.h.cmd("tasks.get", { id: task.id })).body as Task;
    expect(full.attachments.map((a) => a.name).sort()).toEqual(["image.png", "notes.txt"]);
    expect(await readFile(join(full.folder, "attachments", "notes.txt"), "utf8")).toBe("hello");
    expect([...(await readFile(join(full.folder, "attachments", "image.png")))]).toEqual([...PNG]);
    const md = await taskMd(full);
    expect(md).toContain("`attachments/image.png`");
    expect(md).toContain("`attachments/notes.txt`");
    // Copied, never moved: the boss chat keeps its file.
    expect((await stat(join(w.chat.folder, "attachments", "image.png"))).isFile()).toBe(true);
  });

  it("adds a later upload to TASK.md with room.send", async () => {
    w = await bossWorld({ real: false });
    const created = await w.h.cmd("tasks.create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    const file = await upload("shot.png", "image/png", PNG);
    const sent = await w.h.cmd("room.send", { task: id, text: "see this", attachments: [file.body.id] });
    expect(sent.status).toBe(200);
    // TASK.md is written again while the message is delivered, after the send returned.
    await w.h.majhi.services.runs.idle(id);
    const task = (await w.h.cmd("tasks.get", { id })).body as Task;
    expect(task.attachments.map((a) => a.name)).toEqual(["shot.png"]);
    expect(await taskMd(task)).toContain("`attachments/shot.png`");
  });

  it("gives a split child the file, and leaves the source in place", async () => {
    w = await bossWorld({ real: false });
    await put(w.chat.folder, "attachments/image.png");
    const parent = (
      await w.h.cmd("tasks.create", {
        text: "fix the bug in api",
        repos: [{ project: "acme-api" }],
        start: false,
      })
    ).body as Task;
    const split = await asBoss("majhi_tasks_split", {
      task: parent.id,
      children: [{ text: "reproduce it", attachments: ["attachments/image.png"] }, { text: "fix it" }],
    });
    expect(split.isError).toBe(false);
    const children = (await w.h.cmd("tasks.list")).body.filter((t: { id: string }) => t.id !== parent.id);
    const kids = await Promise.all(
      children.map(async (c: { id: string }) => (await w.h.cmd("tasks.get", { id: c.id })).body as Task),
    );
    const withFile = kids.filter((k) => k.attachments.length > 0);
    expect(withFile).toHaveLength(1);
    expect((await stat(join(withFile[0]?.folder ?? "", "attachments", "image.png"))).isFile()).toBe(true);
    expect((await stat(join(w.chat.folder, "attachments", "image.png"))).isFile()).toBe(true);
  });

  it("turns a file into an upload with uploads.create and uses the id once", async () => {
    w = await bossWorld({ real: false });
    await put(w.chat.folder, "attachments/image.png");
    const res = await asBoss("majhi_uploads_create", { path: "attachments/image.png" });
    expect(res.isError).toBe(false);
    const att = JSON.parse(res.text) as { id: string; kind: string; name: string; size: number };
    expect(att).toMatchObject({ kind: "image", name: "image.png", size: PNG.length });
    expect((await stat(join(w.chat.folder, "attachments", "image.png"))).isFile()).toBe(true);

    const made = await asBoss("majhi_tasks_create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      attachments: [att.id],
      start: false,
    });
    expect(made.isError).toBe(false);
    const again = await asBoss("majhi_tasks_create", {
      text: "fix the bug in api again",
      repos: [{ project: "acme-api" }],
      attachments: [att.id],
      start: false,
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("is gone");
    expect(again.text).toContain("24 hours");
  });
});

describe("attachment errors", () => {
  it("says what is accepted when the file does not exist", async () => {
    w = await bossWorld({ real: false });
    const res = await asBoss("majhi_tasks_create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      attachments: ["attachments/imge.png"],
      start: false,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      `"attachments/imge.png" is not an upload id or a file in your task folder (${w.chat.folder}). Attachments take an upload id (from majhi_uploads_create or the owner's Attach button) or a path to a file in your own task folder, like attachments/image.png.`,
    );
    // It failed before any card was posted.
    expect((await w.items()).filter((i) => i.type === "approval")).toEqual([]);
  });

  it("refuses a file outside the task folder, also through a symlink", async () => {
    w = await bossWorld({ real: false });
    const secret = await put(join(w.chat.folder, ".."), "outside/secret.txt", "no");
    await mkdir(join(w.chat.folder, "attachments"), { recursive: true });
    await symlink(secret, join(w.chat.folder, "attachments", "link.txt"));
    for (const path of [secret, "../outside/secret.txt", "attachments/link.txt"]) {
      const res = await asBoss("majhi_uploads_create", { path });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("is outside your task folder");
      expect(res.text).toContain(w.chat.folder);
    }
  });

  it("refuses a type that is not allowed, and lists the allowed ones", async () => {
    w = await bossWorld({ real: false });
    await put(w.chat.folder, "attachments/run.exe", "MZ");
    const res = await asBoss("majhi_uploads_create", { path: "attachments/run.exe" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('"run.exe" is not an allowed file type');
    expect(res.text).toContain("images (png, jpeg, gif, webp), pdf, text");
    const http = await upload("run.exe", "application/x-msdownload");
    expect(http.status).toBe(400);
    expect(http.body.error).toContain("not an allowed file type");
    // A mime type that contradicts the extension is refused too.
    expect((await upload("pic.png", "text/html")).status).toBe(400);
  });

  it("refuses a file over the size limit and says the limit", async () => {
    w = await bossWorld({ real: false });
    const big = join(w.chat.folder, "attachments", "big.log");
    await mkdir(join(big, ".."), { recursive: true });
    await writeFile(big, new Uint8Array(20 * 1024 * 1024 + 1));
    const res = await asBoss("majhi_uploads_create", { path: "attachments/big.log" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("over the limit of 20 MB");
    const task = await asBoss("majhi_tasks_create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      attachments: ["attachments/big.log"],
      start: false,
    });
    expect(task.text).toContain("over the limit of 20 MB");
  });

  it("refuses an upload listed twice in one call", async () => {
    w = await bossWorld({ real: false });
    const file = await upload("a.txt", "text/plain");
    const res = await asBoss("majhi_tasks_create", {
      text: "fix the bug in api",
      repos: [{ project: "acme-api" }],
      attachments: [file.body.id, file.body.id],
      start: false,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`Upload ${file.body.id} is listed more than once`);
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
    expect(local.text).toContain("is in org acme");
    expect(local.text).toContain("with no org");

    // An upload made in Acme cannot be attached to a task of another org.
    const made = await inAcme("majhi_uploads_create", { path: "attachments/image.png" });
    const id = (JSON.parse(made.text) as { id: string }).id;
    const other = await w.h.cmd("tasks.create", { text: "chat", kind: "chat", start: false });
    const sent = await w.h.cmd("room.send", { task: other.body.id, text: "here", attachments: [id] });
    expect(sent.status).toBe(400);
    expect(sent.body.error).toContain("came from a task in org acme");

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
    expect(plain.body.error).toContain('"attachments/image.png" is not an upload id');
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
    expect(uploadsCreate.body.error).toContain("is for agents");
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
      await expect(takePlanned(t.uploads, planned, t.into)).rejects.toThrow(
        "changed while it was being attached",
      );
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
      await expect(takePlanned(t.uploads, planned, t.into)).rejects.toThrow("is outside your task folder");
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
      await expect(takePlanned(t.uploads, planned, t.into)).rejects.toThrow("over the limit of 20 MB");
      await expect(stat(join(t.into, "notes.txt"))).rejects.toThrow();
    } finally {
      await t.cleanup();
    }
  });
});
