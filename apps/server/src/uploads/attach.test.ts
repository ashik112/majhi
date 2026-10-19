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
});
