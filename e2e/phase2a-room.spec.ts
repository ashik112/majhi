import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, expectTasksHome, test, useHome } from "./fixture.ts";

// The room: stopping a turn, permissions, a chat task and what an agent can show. Org Acme with its
// agents, the API-key account codex-key and the project api. The fake Codex adapter pauses 600 ms
// between the steps of a turn, so a turn can be stopped halfway.
useHome({ seed: "team-api", slow: { codex: 600 } });
// The flows do not depend on each other, so each runs in a worker of its own.
test.describe.configure({ mode: "parallel" });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function cmd<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** Sets which things an existing agent may do without asking, keeping everything else. */
async function setPerms(request: APIRequestContext, id: string, perms: string[]) {
  const entries = await cmd<{ status: string; agent: { frontmatter: { id: string } } }[]>(
    request,
    "agents.list",
    {},
  );
  const entry = entries.find((e) => e.status === "ok" && e.agent.frontmatter.id === id);
  expect(entry, `agent ${id} exists`).toBeTruthy();
  const { frontmatter, instructions } = (
    entry as unknown as { agent: { frontmatter: object; instructions: string } }
  ).agent;
  const { id: _id, ...rest } = frontmatter as { id: string };
  await cmd(request, "agents.update", { id, frontmatter: { ...rest, perms }, instructions });
}

const taskIdOf = (page: Page) => new URL(page.url()).pathname.split("/").pop() as string;

const room = (page: Page) => page.getByRole("region", { name: "Task room" });
const messages = (page: Page) => page.getByRole("log", { name: "Room messages" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Message the room" });

const newTaskDialog = (page: Page) => page.getByRole("dialog", { name: "New task" });

/** Opens the New task dialog with `n` and types the title. */
async function openNewTask(page: Page, title: string) {
  await page.goto("/");
  await expectTasksHome(page);
  await page.keyboard.press("n");
  await expect(newTaskDialog(page)).toBeVisible();
  await newTaskDialog(page).getByRole("textbox", { name: "Title" }).fill(title);
}

/** Adds a task from the dialog and starts it; resolves with the new task's id once its room is open. */
async function startTask(page: Page, text: string): Promise<string> {
  await openNewTask(page, text);
  // Naming a project only offers it: the click adds it.
  await newTaskDialog(page).getByRole("button", { name: "Add api", exact: true }).click();
  await newTaskDialog(page).getByRole("button", { name: "Add and start" }).click();
  await expect(page).toHaveURL(/\/t\/[A-Z]+-\d+$/);
  await expect(room(page)).toBeVisible();
  return taskIdOf(page);
}

/** A permission that no longer waits: its verdict ("Allowed by rule", "Denied") and the request, on one line. */
const verdict = (log: Locator, text: string, request: string) =>
  log.getByRole("group").filter({ hasText: text }).filter({ hasText: request });

const panel = (page: Page) => page.getByRole("complementary", { name: "Task details" });

/** The agent finished its turn: the room panel says idle and the composer offers Send, not Stop. */
async function expectIdle(page: Page) {
  await expect(panel(page).getByText("Idle", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

test.beforeAll(async ({ request }) => {
  // The builder may only edit, so its commands ask. The lead and the captain (who runs the chat task)
  // may edit and run commands.
  await setPerms(request, "acme-builder", ["edit"]);
});

test("a command the agent may not run asks inline: Deny fails the tool and the turn goes on", {
  tag: "@smoke",
}, async ({ page }) => {
  await startTask(page, "tidy the readme in backend @acme-builder");
  const log = messages(page);
  const prompt = room(page).getByRole("region", { name: "Permission: Run npm test" });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Allow for this task" })).toBeVisible();
  await shot(page, "room-permission");

  await prompt.getByRole("button", { name: "Deny" }).click();
  await expect(prompt).toBeHidden();
  await expect(verdict(log, "Denied", "Run npm test")).toBeVisible();
  await expect(log.getByRole("button", { name: /Run npm test.*failed/ })).toBeVisible();
  await expect(log.getByText(/I could not run the tests\./)).toBeVisible();
  await expectIdle(page);
});

test("Allow for this task answers the next ask of that kind by itself", async ({ page }) => {
  await startTask(page, "fix the typo in api @acme-builder");
  const log = messages(page);
  const prompt = room(page).getByRole("region", { name: "Permission: Run npm test" });
  await prompt.getByRole("button", { name: "Allow for this task" }).click();
  await expect(log.getByText(/Tests passed\./)).toBeVisible();
  await expectIdle(page);

  await composer(page).fill("run it once more");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(verdict(log, "Allowed by rule", "Run npm test").last()).toBeVisible({ timeout: 20_000 });
  await expect(log.getByText(/Tests passed\./)).toHaveCount(2, { timeout: 20_000 });
  await expect(room(page).getByRole("region", { name: "Permission: Run npm test" })).toHaveCount(0);
  await expectIdle(page);
});
