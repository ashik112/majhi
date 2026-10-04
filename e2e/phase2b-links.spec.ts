import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, useHome } from "./fixture.ts";

// Org Acme and its agents, plus the project "api".
useHome({ seed: "team-api" });

async function cmd<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const taskIdOf = (page: Page) => new URL(page.url()).pathname.split("/").pop() as string;
const status = async (request: APIRequestContext, id: string) =>
  (await cmd<{ status: string }>(request, "tasks.get", { id })).status;
const dialog = (page: Page) => page.getByRole("dialog", { name: "New task" });
const card = (page: Page, id: string) => page.locator(`#card-${id}`);

/** Adds a task through the dialog. `chips` picks task ids under a group; resolves with the new id. */
async function addTask(
  page: Page,
  title: string,
  opts: { start: boolean; dependsOn?: string[]; partOf?: string },
): Promise<string> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await page.keyboard.press("n");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("textbox", { name: "Title" }).fill(title);
  // Naming a project only offers it: the click adds it.
  await dialog(page).getByRole("button", { name: "Add api", exact: true }).click();
  for (const id of opts.dependsOn ?? []) {
    await dialog(page).getByRole("button", { name: "Choose depends on" }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(`^${id}`) }).click();
  }
  if (opts.partOf) {
    await dialog(page).getByRole("button", { name: "Choose part of" }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(`^${opts.partOf}`) }).click();
  }
  await dialog(page)
    .getByRole("button", { name: opts.start ? "Add and start" : "Add to inbox" })
    .click();
  await expect(page).toHaveURL(/\/t\/[A-Z]+-\d+$/);
  return taskIdOf(page);
}

test("a task that depends on another waits, shows it on the board, and starts when it is done", {
  tag: "@smoke",
}, async ({ page, request }) => {
  const a = await addTask(page, "links alpha on api", { start: false });
  const b = await addTask(page, "links beta on api", { start: true, dependsOn: [a] });

  await expect(page.getByTestId("task-links").getByRole("link", { name: new RegExp(a) })).toBeVisible();
  await expect(page.getByTestId("task-links").getByText("Waits for", { exact: true })).toBeVisible();
  expect(await status(request, b)).toBe("ready");

  await page.goto("/");
  await expect(card(page, b)).toContainText(`Waiting on ${a}`);
  await page.screenshot({ path: "e2e/screenshots/links-board.png" });

  // Starting by hand is refused while it waits.
  const refused = await request.post("/api/cmd/tasks.start", { data: { id: b } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toContain(`Waiting on ${a}`);

  await cmd(request, "tasks.close", { id: a });
  await expect.poll(() => status(request, b), { timeout: 20_000 }).toBe("running");

  await page.goto(`/t/${b}`);
  await expect(page.getByRole("log", { name: "Room messages" }).getByText(`${b} starts.`)).toBeVisible();
  await expect(page.getByTestId("task-links").getByRole("link", { name: new RegExp(a) })).toBeVisible();
});
