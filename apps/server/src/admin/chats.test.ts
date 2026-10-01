import type { Task, TaskSummary } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const list = async (): Promise<TaskSummary[]> => (await w.h.cmd("tasks.list", { includeDone: true })).body;
const idle = (id: string) => w.h.majhi.services.runs.idle(id);
const say = (task: string, text: string) => w.h.cmd("room.send", { task, text });

describe("chats with agents", () => {
  it("reuses an untitled chat, names a chat from the first message, and keeps several chats apart", async () => {
    w = await bossWorld();
    const again = await w.h.cmd("chats.create", { agent: "boss" });
    expect(again.body.id).toBe(w.chat.id);

    await say(w.chat.id, "Why is the build red?\nIt failed twice.");
    await idle(w.chat.id);
    const second = (await w.h.cmd("chats.create", { agent: "boss" })).body as Task;
    expect(second.id).not.toBe(w.chat.id);

    const chats = (await list()).filter((t) => t.chat === true);
    expect(chats.map((t) => [t.id, t.title]).sort()).toEqual(
      [
        [w.chat.id, "Why is the build red?"],
        [second.id, "Chat"],
      ].sort(),
    );
    const renamed = await w.h.cmd("chats.rename", { id: second.id, title: "Release notes" });
    expect(renamed.body.title).toBe("Release notes");
  });

  it("runs a chat with an org agent inside that org", async () => {
    w = await bossWorld();
    await w.h.cmd("agents.create", {
      id: "acme-dev",
      frontmatter: { scope: "acme", role: "Builder", account: "claude-acme" },
      instructions: "Build.\n",
    });
    const chat = (await w.h.cmd("chats.create", { agent: "acme-dev" })).body as Task;
    expect(chat).toMatchObject({ kind: "chat", org: "acme", team: ["acme-dev"], repos: [] });
    expect((await w.h.cmd("chats.create", { agent: "ghost" })).status).toBe(404);
  });

  it("continues a finished chat when the owner writes in it", async () => {
    w = await bossWorld();
    await say(w.chat.id, "first question");
    await idle(w.chat.id);
    await w.h.cmd("tasks.close", { id: w.chat.id, by: "owner", whenUnshipped: "keep" });
    expect((await list()).find((t) => t.id === w.chat.id)?.status).toBe("done");

    expect((await say(w.chat.id, "and a follow up")).status).toBe(200);
    await idle(w.chat.id);
    const after = (await list()).find((t) => t.id === w.chat.id);
    expect(after?.status).toBe("running");
    expect(after?.title).toBe("first question");
    // A finished code task still refuses messages.
    const task = (
      await w.h.cmd("tasks.create", { text: "Plain task", kind: "chat", agent: "boss", attachments: [], start: false })
    ).body;
    await w.h.cmd("tasks.close", { id: task.id, by: "owner", whenUnshipped: "keep" });
    expect((await say(task.id, "hello")).status).toBe(409);
  });

  it("marks a chat as asking only while something waits for the owner", async () => {
    w = await bossWorld();
    await say(
      w.chat.id,
      'call: majhi_orgs_create {"id":"acme2","name":"Acme Two","ownerAsked":false,"reason":"a second company"}',
    );
    await idle(w.chat.id);
    expect((await list()).find((t) => t.id === w.chat.id)?.asking).toBe(true);

    const items = (await w.items()).filter((i) => i.type === "approval");
    await w.h.cmd("room.approve", { task: w.chat.id, item: items[0]?.id, decision: "approve" });
    await idle(w.chat.id);
    expect((await list()).find((t) => t.id === w.chat.id)?.asking).toBeUndefined();
  });
});
