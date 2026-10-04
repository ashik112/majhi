import { rmSync, writeFileSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, OFFLINE_FILE, test, useHome } from "./fixture.ts";

// The run manager (SPEC 5.7, 5.13, 5.17). Org Acme with the project "api", acme-lead (edit and
// shell) and acme-reviewer (edit only, so its `npm test` asks and its turn stays open) on
// claude-acme-1.
useHome({ seed: "team-api" });
test.describe.configure({ mode: "serial" });

async function cmd<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const createTask = async (request: APIRequestContext, text: string) =>
  (await cmd<{ id: string }>(request, "tasks.create", { text, repos: [{ project: "api" }], start: true })).id;
const status = async (request: APIRequestContext, id: string) =>
  cmd<{ status: string; pausedReason?: string }>(request, "tasks.get", { id });

const messages = (page: Page) => page.getByRole("log", { name: "Room messages" });
const needsYou = (page: Page) => page.getByRole("region", { name: "Needs you" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Task details" });
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

/** Sets which things an existing agent may do without asking, keeping everything else. */
async function setPerms(request: APIRequestContext, id: string, perms: string[]) {
  const entries = await cmd<
    { status: string; agent: { frontmatter: { id: string }; instructions: string } }[]
  >(request, "agents.list", {});
  const entry = entries.find((e) => e.status === "ok" && e.agent.frontmatter.id === id);
  if (entry === undefined) throw new Error(`agent ${id} does not exist`);
  const { id: _id, ...frontmatter } = entry.agent.frontmatter;
  await cmd(request, "agents.update", {
    id,
    frontmatter: { ...frontmatter, perms },
    instructions: entry.agent.instructions,
  });
}

test.beforeAll(async ({ request }) => {
  await setPerms(request, "acme-lead", ["edit", "shell"]);
  // Without shell the reviewer's `npm test` asks, so its turn stays open.
  await setPerms(request, "acme-reviewer", ["edit"]);
});

test("an agent waits in line when its account is at the limit, and starts when a slot frees", async ({
  page,
  request,
}) => {
  await cmd(request, "settings.set", { limits: { per_account: 1 } });
  // The reviewer's turn stops at a permission prompt, so it keeps its slot.
  const first = await createTask(request, "review on api @acme-reviewer");
  await page.goto(`/t/${first}`);
  await expect(needsYou(page).getByText(/acme-reviewer asks to/)).toBeVisible({ timeout: 20_000 });

  const second = await createTask(request, "lead on api @acme-lead");
  await page.goto(`/t/${second}`);
  await expect(panel(page).getByText("Queued, #1 in line")).toBeVisible({ timeout: 10_000 });
  await shot(page, "runs-queued");

  await cmd(request, "tasks.stop", { id: first });
  await expect(panel(page).getByText("Queued, #1 in line")).toHaveCount(0, { timeout: 20_000 });
  await expect(messages(page).getByText(/@acme-lead (started|resumed) on claude-acme-1/)).toBeVisible();
  await cmd(request, "settings.set", { limits: { per_account: 2 } });
  await cmd(request, "tasks.stop", { id: second });
});

test("offline pauses the running task, and it resumes on its own when the connection is back", async ({
  page,
  request,
}) => {
  const id = await createTask(request, "offline on api @acme-reviewer");
  await page.goto(`/t/${id}`);
  await expect(needsYou(page).getByText(/acme-reviewer asks to/)).toBeVisible({ timeout: 20_000 });

  writeFileSync(OFFLINE_FILE, "");
  await expect(panel(page).getByText("Paused, offline")).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText("majhi is offline. The task continues on its own when the connection is back."),
  ).toBeVisible();
  expect(await status(request, id)).toMatchObject({ status: "paused", pausedReason: "offline" });
  // The cut turn's prompt was withdrawn.
  const prompts = page.getByRole("region", { name: /^Permission:/ });
  await expect(prompts).toHaveCount(0);
  await shot(page, "runs-offline");

  rmSync(OFFLINE_FILE);
  await expect(messages(page).getByText("Resuming @acme-reviewer: the connection is back.")).toBeVisible({
    timeout: 10_000,
  });
  await expect.poll(async () => (await status(request, id)).status, { timeout: 10_000 }).toBe("running");
  // The continued turn asks again.
  await expect(prompts).toHaveCount(1, { timeout: 20_000 });
  await cmd(request, "tasks.stop", { id });
});
