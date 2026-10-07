import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { toolName } from "../admin/tools.ts";
import { git } from "../testing/fixtures.ts";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * A chat and the task it turns into are one conversation: the chat is promoted in place (same id,
 * same room, history kept). A separate task made from a chat is steered by that chat's agent, inside
 * the rails: only a task it made or the owner named, only its repos, never uncommitted work.
 */

let w: World;
afterEach(() => w?.cleanup());

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const services = () => w.h.majhi.services;
const prompts: { task: string | undefined; text: string }[] = [];
let chatId = "";
let hold: Promise<void> = Promise.resolve();

async function world(): Promise<{ chat: Task; as: { task: string; agent: string } }> {
  w = await taskWorld();
  await w.addRepo("web");
  expect(
    (await cmd("projects.register", { id: "acme-web", org: "acme", path: "~/Work/web", aliases: ["web"] }))
      .status,
  ).toBe(200);
  prompts.length = 0;
  hold = Promise.resolve();
  chatId = "";
  w.h.runtime.onSession = (session, start) => {
    session.script = async (turn) => {
      prompts.push({ task: start.task, text: turn.text });
      // The work of a separate task stays "running" until the test lets it end.
      if (start.task !== undefined && start.task !== chatId) await hold;
      turn.emit({ type: "text", messageId: `m${prompts.length}`, text: "ok" });
      return "end_turn";
    };
  };
  const made = await cmd("chats.create", { agent: "acme-builder" });
  expect(made.status).toBe(200);
  const chat = made.body as Task;
  chatId = chat.id;
  expect((await cmd("room.send", { task: chat.id, text: "The login on api drops the session" })).status).toBe(
    200,
  );
  await services().runs.idle(chat.id);
  return { chat, as: { task: chat.id, agent: "acme-builder" } };
}

const create = (as: { task: string; agent: string }, input: Record<string, unknown>) =>
  services().admin.runAllowed(
    as,
    "tasks.create",
    {
      text: "Fix the session drop on api",
      repos: [{ project: "acme-api" }],
      start: false,
      attachments: [],
      dependsOn: [],
      ...input,
    },
    { reason: "the owner wants it fixed" },
  );
const run = (
  as: { task: string; agent: string },
  command: "tasks.look" | "tasks.addRepo" | "tasks.removeRepo",
  input: Record<string, unknown>,
) => services().admin.runAllowed(as, command, input, { reason: "test" });
const items = async (task: string) =>
  (await cmd("room.items", { task, limit: 200 })).body.items as RoomItem[];
const get = async (id: string) => (await cmd("tasks.get", { id })).body as Task;

describe("promoting a chat", () => {
  it("keeps the chat's id, room and history, and gives it repos, a type and worktrees", async () => {
    const { chat, as } = await world();
    const before = (await items(chat.id)).map((i) => i.id);
    const tasksBefore = ((await cmd("tasks.list", {})).body as Task[]).length;

    const made = await create(as, {});
    expect(made.isError).toBe(false);

    const task = await get(chat.id);
    expect(task).toMatchObject({ id: chat.id, kind: "code", org: "acme", team: ["acme-builder"] });
    expect(task.repos.map((r) => r.project)).toEqual(["acme-api"]);
    expect(task.repos[0]?.worktree).toBe(join(w.taskDir(chat.id), "acme-api"));
    expect(task.typing).toBeDefined();
    expect(task.origin).toEqual({ kind: "chat", room: chat.id });
    // No second task was made.
    expect(((await cmd("tasks.list", {})).body as Task[]).length).toBe(tasksBefore);
    // The history is the same rows, and the room says what happened.
    const after = await items(chat.id);
    expect(before.every((id) => after.some((i) => i.id === id))).toBe(true);
    expect(after.some((i) => i.type === "system" && i.text.includes(`now task ${chat.id}`))).toBe(true);
    // One row in the conversations list, still the chat.
    const rows = ((await cmd("conversations.list")).body as Conversation[]).filter((c) => c.id === chat.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("agent");
  });

  it("makes a separate task only when the agent asks for one, and links it to the chat", async () => {
    const { chat, as } = await world();
    const made = await create(as, { separate: true });
    expect(made.isError).toBe(false);
    const separate = JSON.parse(made.text) as Task;
    expect(separate.id).not.toBe(chat.id);
    expect((await get(chat.id)).kind).toBe("chat");
    expect((await get(separate.id)).origin).toEqual({ kind: "chat", room: chat.id });
    const rows = (await cmd("tasks.list", {})).body as {
      id: string;
      origin?: { kind: string; room?: string; name?: string };
    }[];
    expect(rows.find((r) => r.id === separate.id)?.origin).toMatchObject({ kind: "chat", room: chat.id });
  });

  it("refuses a chat with no repos to promote, and a chat that is already a task", async () => {
    const { chat, as } = await world();
    const none = await create(as, { repos: [] });
    expect(none.isError).toBe(true);
    expect((await get(chat.id)).kind).toBe("chat");
    expect((await create(as, {})).isError).toBe(false);
    // A promoted chat is a task now: creating from it makes a new task, never a second promotion.
    const next = await create(as, { text: "Another job" });
    expect(next.isError).toBe(false);
    expect(JSON.parse(next.text).id).not.toBe(chat.id);
  });
});

describe("a chat's agent and the separate task it made", () => {
  async function separate() {
    const { chat, as } = await world();
    let release: () => void = () => {};
    hold = new Promise<void>((r) => {
      release = r;
    });
    const made = await create(as, {
      text: "separate work: fix the session drop on api",
      repos: [{ project: "acme-api" }, { project: "acme-web" }],
      separate: true,
      start: true,
    });
    expect(made.isError).toBe(false);
    const task = JSON.parse(made.text) as Task;
    await until(() => prompts.some((p) => p.task === task.id), "the task's first turn");
    return { chat, as, task, release };
  }

  it("tells the working agent like a message from the owner, once per turn of that agent", async () => {
    const { as, task, release } = await separate();
    const told = await services().admin.call(as, toolName("tasks.tell"), {
      id: task.id,
      text: "Also cover the logout path",
      ownerAsked: false,
      reason: "the owner asked in chat",
    });
    expect(told.isError).toBe(false);
    expect(JSON.parse(told.text)).toMatchObject({ id: task.id, told: true });
    const room = await items(task.id);
    expect(room.some((i) => i.type === "system" && i.text.includes("Also cover the logout path"))).toBe(true);
    // A second note before the agent took a new turn is not sent.
    const again = await services().admin.call(as, toolName("tasks.tell"), {
      id: task.id,
      text: "and the signup",
      ownerAsked: false,
      reason: "x",
    });
    expect(JSON.parse(again.text)).toMatchObject({ told: false, refused: "already-told" });
    release();
    await until(
      () => prompts.some((p) => p.task === task.id && p.text.includes("Also cover the logout path")),
      "the note reaches the agent",
    );
  });

  it("refuses to tell a task it has no link to, until the owner names it in the chat", async () => {
    const { chat, as, release } = await separate();
    const other = await cmd("tasks.create", {
      text: "fix api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const id = (other.body as Task).id;
    const refused = await services().admin.call(as, toolName("tasks.tell"), {
      id,
      text: "hi",
      ownerAsked: false,
      reason: "x",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("not a task this chat made");
    expect((await run(as, "tasks.look", { id })).isError).toBe(true);
    await cmd("room.send", { task: chat.id, text: `please look at ${id}` });
    expect((await run(as, "tasks.look", { id })).isError).toBe(false);
    release();
  });

  it("reads the working folder and refuses paths outside the repo", async () => {
    const { as, task, release } = await separate();
    await writeFile(join(w.taskDir(task.id), "acme-api", "notes.txt"), "draft\n");
    const status = await run(as, "tasks.look", { id: task.id });
    const look = JSON.parse(status.text);
    expect(look.repos.find((r: { project: string }) => r.project === "acme-api").changes).toEqual([
      "?? notes.txt",
    ]);
    const file = await run(as, "tasks.look", { id: task.id, project: "acme-api", path: "notes.txt" });
    expect(JSON.parse(file.text).file).toMatchObject({ path: "notes.txt", content: "draft\n" });
    for (const path of ["../ACM-9/TASK.md", ".git/config", "/etc/passwd"]) {
      expect((await run(as, "tasks.look", { id: task.id, project: "acme-api", path })).isError).toBe(true);
    }
    release();
  });

  it("removes a repo only when no uncommitted work would be lost, and lists what is there when it would", async () => {
    const { as, task, release } = await separate();
    const web = join(w.taskDir(task.id), "acme-web");
    await writeFile(join(web, "draft.ts"), "export const a = 1;\n");
    const refused = await run(as, "tasks.removeRepo", { id: task.id, project: "acme-web" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("?? draft.ts");
    expect(refused.text).toContain("Ask the owner");
    expect((await get(task.id)).repos.map((r) => r.project)).toEqual(["acme-api", "acme-web"]);
    // An agent can never throw the work away.
    const discard = await run(as, "tasks.removeRepo", { id: task.id, project: "acme-web", discard: true });
    expect(discard.isError).toBe(true);
    expect((await get(task.id)).repos).toHaveLength(2);
    // Clean again: it goes, and the other repo stays.
    await git(web, "add", ".");
    await git(web, "commit", "--quiet", "-m", "draft");
    expect((await run(as, "tasks.removeRepo", { id: task.id, project: "acme-web" })).isError).toBe(false);
    expect((await get(task.id)).repos.map((r) => r.project)).toEqual(["acme-api"]);
    release();
  });

  it("adds a repo to the task, with a branch and a worktree", async () => {
    const { chat, as } = await world();
    const made = await create(as, { separate: true, start: true });
    const task = JSON.parse(made.text) as Task;
    expect(task.repos.map((r) => r.project)).toEqual(["acme-api"]);
    const added = await run(as, "tasks.addRepo", { id: task.id, project: "acme-web" });
    expect(added.isError).toBe(false);
    const after = await get(task.id);
    expect(after.repos.map((r) => r.project)).toEqual(["acme-api", "acme-web"]);
    expect(after.repos[1]?.worktree).toBe(join(w.taskDir(task.id), "acme-web"));
    // The chat itself has no repos to add to.
    expect((await run(as, "tasks.addRepo", { id: chat.id, project: "acme-web" })).isError).toBe(true);
  });
});
