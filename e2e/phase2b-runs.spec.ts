import { rmSync, writeFileSync } from "node:fs";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { OFFLINE_FILE } from "./fixture.ts";

// The run manager (SPEC 5.7, 5.13, 5.17). Builds on phases 1 and 2a: org Acme with the project
// "api", acme-lead (edit and shell) and acme-reviewer (no perms, so its `npm test` asks and its
// turn stays open) on claude-acme-1. Run in order after them.
test.describe.configure({ mode: "serial" });

async function cmd<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const createTask = async (request: APIRequestContext, text: string) =>
  (await cmd<{ id: string }>(request, "tasks.create", { text, start: true })).id;
const status = async (request: APIRequestContext, id: string) =>
  cmd<{ status: string; pausedReason?: string }>(request, "tasks.get", { id });

const messages = (page: Page) => page.getByRole("log", { name: "Room messages" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Task details" });
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

/** Sets which things an existing agent may do without asking, keeping everything else. */
async function setPerms(request: APIRequestContext, id: string, perms: string[]) {
  const entries = await cmd<
    { status: string; agent: { frontmatter: { id: string }; instructions: string } }[]
  >(request, "agents.list", {});
  const entry = entries.find((e) => e.status === "ok" && e.agent.frontmatter.id === id);
  expect(entry, `agent ${id} exists`).toBeTruthy();
  const { id: _id, ...frontmatter } = entry?.agent.frontmatter as { id: string };
  await cmd(request, "agents.update", {
    id,
    frontmatter: { ...frontmatter, perms },
    instructions: entry?.agent.instructions,
  });
}

test.beforeAll(async ({ request }) => {
  await setPerms(request, "acme-lead", ["edit", "shell"]);
  // Without shell the reviewer's `npm test` asks, so its turn stays open.
  await setPerms(request, "acme-reviewer", ["edit"]);
});

test.afterAll(async ({ request }) => {
  rmSync(OFFLINE_FILE, { force: true });
  await request.post("/api/cmd/settings.set", {
    data: { context: { compact_at: 0.8, compact_target: 0.4 }, limits: { per_account: 2 } },
  });
});

test("a compaction shows in the room as one quiet line, and Fresh session carries a note", async ({
  page,
  request,
}) => {
  // The fake's turn ends at 42k of 200k, so a 15% threshold compacts it; its /compact drops to a tenth.
  await cmd(request, "settings.set", { context: { compact_at: 0.15, compact_target: 0.1 } });
  const id = await createTask(request, "compact on api @acme-lead");
  await page.goto(`/t/${id}`);
  await expect(messages(page).getByText("@acme-lead compacted: 42k to 4k tokens (native)")).toBeVisible({
    timeout: 20_000,
  });
  const meter = panel(page).getByRole("meter", { name: "Context of @acme-lead" });
  await expect(meter).toHaveAttribute("aria-valuetext", "4k of 200k tokens");
  await shot(page, "runs-compacted");

  await cmd(request, "settings.set", { context: { compact_at: 0.8, compact_target: 0.4 } });
  await panel(page).getByRole("button", { name: "Fresh session for @acme-lead" }).click();
  const line = messages(page).getByText(/@acme-lead compacted: .* \(fresh\)/);
  await expect(line).toBeVisible({ timeout: 20_000 });
  await messages(page).getByRole("link", { name: "note" }).last().click();
  await expect(page).toHaveURL(/file=\.handoffs%2Facme-lead-1\.md|file=\.handoffs\/acme-lead-1\.md/);
  await expect(page.getByRole("heading", { name: "Next step" })).toBeVisible();
  await shot(page, "runs-fresh-note");
  await cmd(request, "tasks.close", { id });
});

test("an agent waits in line when its account is at the limit, and starts when a slot frees", async ({
  page,
  request,
}) => {
  await cmd(request, "settings.set", { limits: { per_account: 1 } });
  // The reviewer's turn stops at a permission prompt, so it keeps its slot.
  const first = await createTask(request, "review on api @acme-reviewer");
  await page.goto(`/t/${first}`);
  await expect(messages(page).getByText(/acme-reviewer asks to/)).toBeVisible({ timeout: 20_000 });

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
  await expect(messages(page).getByText(/acme-reviewer asks to/)).toBeVisible({ timeout: 20_000 });

  writeFileSync(OFFLINE_FILE, "");
  await expect(panel(page).getByText("Paused, offline")).toBeVisible({ timeout: 10_000 });
  await expect(
    panel(page).getByText("majhi is offline. The task continues on its own when the connection is back."),
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
