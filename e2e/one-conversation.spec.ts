import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, useHome } from "./fixture.ts";

// A chat and the task it turns into are one conversation. The fake adapter turns "call: <server>/<tool> {json}"
// into a real call to that MCP server of the session, so the chat's agent makes, steers and changes tasks itself.
useHome({ seed: "team-api" });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

interface TaskView {
  id: string;
  kind: string;
  status: string;
  repos: { project: string; worktree?: string }[];
  origin?: { kind: string; room?: string };
}

async function cmd<T>(request: APIRequestContext, name: string, data: object = {}): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const composer = (page: Page) => page.getByRole("textbox", { name: "Message the room" });
const log = (page: Page) => page.getByRole("log", { name: "Room messages" });

async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** The agent's tool call waits for the owner's click: approve the newest card. */
async function approve(page: Page) {
  const button = page.getByRole("button", { name: "Approve" }).last();
  await expect(button).toBeVisible();
  await button.click();
}

/** A change the owner already asked for runs by itself; one that is not waits for the click. */
async function approveIfAsked(page: Page) {
  const button = page.getByRole("button", { name: "Approve" }).last();
  await button.waitFor({ state: "visible", timeout: 3_000 }).then(
    () => button.click(),
    () => undefined,
  );
}

/** The fake agent ends every turn the same way: n turns are done when its closing line shows n times. */
const turns = (page: Page, n: number) => expect(log(page).getByText("Tests passed")).toHaveCount(n);

async function openChat(page: Page, agent: string): Promise<string> {
  const chat = await cmd<{ id: string }>(page.request, "chats.create", { agent });
  await page.goto(`/chats/${chat.id}`);
  await expect(composer(page)).toBeVisible();
  return chat.id;
}

const call = (tool: string, args: object) => `call: majhi-tasks/${tool} ${JSON.stringify(args)}`;

test("the chat becomes the task: one conversation, one row in the list", async ({ page }) => {
  const id = await openChat(page, "acme-lead");
  await say(page, "The login on api drops the session after an hour");
  await turns(page, 1);

  await say(
    page,
    call("create", {
      text: "Fix the session drop on api",
      repos: [{ project: "api" }],
      start: true,
      ownerAsked: true,
      reason: "The owner asked for the fix",
    }),
  );
  await approve(page);

  // Same chat: its header now shows the task and its state, and the earlier talk is still above.
  const header = page.getByRole("banner").or(page.locator("header", { hasText: id }));
  await expect(header.getByRole("link", { name: id })).toBeVisible();
  await expect(log(page).getByText("The login on api drops the session after an hour")).toBeVisible();
  // The worktree comes a moment after the chat turns into the task.
  await expect
    .poll(async () => (await cmd<TaskView>(page.request, "tasks.get", { id })).repos[0]?.worktree)
    .toBeTruthy();
  const task = await cmd<TaskView>(page.request, "tasks.get", { id });
  expect(task.repos.map((r) => r.project)).toEqual(["api"]);
  expect(task.repos[0]?.worktree && existsSync(task.repos[0].worktree)).toBeTruthy();
  expect(task.origin).toEqual({ kind: "chat", room: id });
  await shot(page, "one-conversation-promoted");

  // The owner keeps talking in the same chat, and the work happens there.
  await say(page, "Also check the logout path");
  await expect(log(page).getByText("Also check the logout path")).toBeVisible();

  // One row, and it is this chat. No second task was made.
  const rows = await cmd<{ id: string; kind: string }[]>(page.request, "conversations.list");
  expect(rows.filter((r) => r.id === id)).toEqual([expect.objectContaining({ id, kind: "agent" })]);
  const tasks = await cmd<{ id: string; kind: string }[]>(page.request, "tasks.list", {});
  expect(tasks.filter((t) => t.kind === "code")).toHaveLength(1);
  await page.goto("/chats");
  await expect(page.getByRole("navigation", { name: "Chats" })).toBeVisible();
  await shot(page, "one-conversation-list");
});

test("a separate task: the chat's agent tells it, adds a repo, and takes it off again", async ({ page }) => {
  await cmd(page.request, "projects.register", {
    id: "web",
    org: "acme",
    path: "~/Work/beta-web",
    aliases: ["web"],
  });
  const chat = await openChat(page, "acme-lead");
  await say(page, "Please fix the session drop, as a separate task");
  await say(
    page,
    call("create", {
      text: "Fix the session drop on api",
      repos: [{ project: "api" }],
      start: true,
      separate: true,
      ownerAsked: true,
      reason: "The owner asked for a separate task",
    }),
  );
  await approve(page);

  const moved = page.getByText("Work moved to");
  await expect(moved).toBeVisible();
  const taskId = (await moved.getByRole("link").textContent())?.trim() ?? "";
  expect(taskId).not.toBe("");
  expect((await cmd<TaskView>(page.request, "tasks.get", { id: chat })).kind).toBe("chat");
  expect((await cmd<TaskView>(page.request, "tasks.get", { id: taskId })).origin).toEqual({
    kind: "chat",
    room: chat,
  });
  await shot(page, "one-conversation-moved");

  // The chat's agent writes to the working agent.
  await expect
    .poll(async () => (await cmd<TaskView>(page.request, "tasks.get", { id: taskId })).status)
    .toBe("review");
  await say(
    page,
    call("tell", {
      id: taskId,
      text: "Also cover the logout path",
      ownerAsked: true,
      reason: "The owner asked",
    }),
  );
  await expect
    .poll(async () => {
      const room = await cmd<{ items: { type: string; text?: string }[] }>(page.request, "room.items", {
        task: taskId,
        limit: 100,
      });
      return room.items.some((i) => i.type === "system" && i.text?.includes("Also cover the logout path"));
    })
    .toBe(true);

  // It adds a repo, then cannot take it off while the worktree holds uncommitted work.
  await say(
    page,
    call("add_repo", { id: taskId, project: "web", ownerAsked: true, reason: "The fix reaches the web app" }),
  );
  await approveIfAsked(page);
  await expect
    .poll(async () =>
      (await cmd<TaskView>(page.request, "tasks.get", { id: taskId })).repos.map((r) => r.project),
    )
    .toEqual(["api", "web"]);
  const web = (await cmd<TaskView>(page.request, "tasks.get", { id: taskId })).repos[1]?.worktree ?? "";
  writeFileSync(join(web, "draft.ts"), "export const a = 1;\n");
  await say(
    page,
    call("remove_repo", {
      id: taskId,
      project: "web",
      ownerAsked: true,
      reason: "The web app is not needed",
    }),
  );
  await approveIfAsked(page);
  await expect(
    log(page)
      .getByText(/uncommitted changes/)
      .first(),
  ).toBeVisible();
  expect((await cmd<TaskView>(page.request, "tasks.get", { id: taskId })).repos).toHaveLength(2);
  await shot(page, "one-conversation-refused");

  // The task's room says where it came from.
  await page.goto(`/t/${taskId}`);
  await expect(page.getByRole("link", { name: /From the chat/ })).toBeVisible();
  await shot(page, "one-conversation-from-chat");
});
