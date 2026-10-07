import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, MAJHI_HOME, test, useHome } from "./fixture.ts";

// Usage limits (SPEC 5.7, Phase 7). Org Acme with the project "api": acme-lead on claude-acme-1,
// acme-builder on claude-acme-2. A `fake-limit` file in an account's config home makes the fake
// adapter fail every prompt of that account with the file's text, as a CLI that is out of usage.
useHome({ seed: "team-api" });
test.describe.configure({ mode: "serial" });

async function cmd<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface Item {
  type: string;
  agent?: string;
  text?: string;
}
const items = async (request: APIRequestContext, task: string) =>
  (await cmd<{ items: Item[] }>(request, "room.items", { task, limit: 500 })).items;
const messages = (page: Page) => page.getByRole("log", { name: "Room messages" });
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

const LIMIT_FILE = join(MAJHI_HOME, "accounts", "claude-acme-1", "fake-limit");

test.afterAll(() => rmSync(LIMIT_FILE, { force: true }));

test("an account at its limit mid-run hands the task to the fallback, with a handoff note", async ({
  page,
  request,
}) => {
  await cmd(request, "agents.edit", { id: "acme-lead", set: { fallback: "acme-builder" } });
  const { id } = await cmd<{ id: string }>(request, "tasks.create", {
    text: "tidy the api @acme-lead",
    repos: [{ project: "api" }],
    start: true,
  });

  // The lead's first turn runs on claude-acme-1 and ends.
  await expect
    .poll(async () => (await items(request, id)).some((i) => i.type === "agent" && i.agent === "acme-lead"), {
      timeout: 30_000,
    })
    .toBe(true);
  const working = async () =>
    (await cmd<{ id: string; working: string[] }[]>(request, "tasks.list", {})).find((t) => t.id === id)
      ?.working ?? [];
  await expect.poll(working, { timeout: 30_000 }).toEqual([]);

  // claude-acme-1 runs out, two hours from now; the lead's next turn hits it.
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  writeFileSync(LIMIT_FILE, `Claude AI usage limit reached|${resetsAt}`);
  await cmd(request, "room.send", { task: id, text: "carry on, @acme-lead" });

  await page.goto(`/t/${id}`);
  await expect(
    messages(page).getByText(
      /@acme-lead hit its usage limit \(resets .+\)\. @acme-builder continues from the checkpoint\./,
    ),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, "limits-handoff");

  // The fallback took the lead's place, and the task did not pause.
  const task = await cmd<{ team: string[]; status: string; folder: string }>(request, "tasks.get", { id });
  expect(task.team).toEqual(["acme-builder"]);
  expect(task.status).not.toBe("paused");

  // It starts from a handoff note built from the checkpoint, and works on claude-acme-2.
  const note = join(task.folder, ".handoffs", "acme-builder-1.md");
  await expect.poll(() => existsSync(note), { timeout: 10_000 }).toBe(true);
  expect(readFileSync(note, "utf8")).toContain("# Handoff note");
  await expect
    .poll(
      async () => (await items(request, id)).some((i) => i.type === "agent" && i.agent === "acme-builder"),
      { timeout: 30_000 },
    )
    .toBe(true);

  // The account is at its limit until the reset the error named.
  const accounts = await cmd<
    { id: string; status: string; limit?: { until: string; resetKnown: boolean } }[]
  >(request, "accounts.list", {});
  const acme1 = accounts.find((a) => a.id === "claude-acme-1");
  expect(acme1?.status).toBe("at-limit");
  expect(acme1?.limit).toMatchObject({ until: new Date(resetsAt * 1000).toISOString(), resetKnown: true });

  // The board's top bar shows it.
  await page.goto("/");
  await expect(page.getByTestId("account-readout").filter({ hasText: "claude-acme-1" })).toBeVisible();
  await shot(page, "limits-top-bar");
  await cmd(request, "tasks.close", { id });
});
