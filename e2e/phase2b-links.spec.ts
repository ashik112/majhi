import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// Builds on phases 1 and 2a: org Acme, its agents and the project "api". Run in order after them.
test.describe.configure({ mode: "serial" });

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

test("a task that depends on another waits, shows it on the board, and starts when it is done", async ({
  page,
  request,
}) => {
  const a = await addTask(page, "links alpha on api", { start: false });
  const b = await addTask(page, "links beta on api", { start: true, dependsOn: [a] });

  await expect(page.getByTestId("task-links").getByRole("link", { name: new RegExp(a) })).toBeVisible();
  await expect(page.getByTestId("task-links").getByText("Waits for")).toBeVisible();
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
  await expect(page.getByText(`Started: ${a} is done.`)).toBeVisible();
  await expect(page.getByTestId("task-links").getByRole("link", { name: new RegExp(a) })).toBeVisible();
});

test("a parent shows its progress and closes when its children are done", async ({ page, request }) => {
  const parent = await addTask(page, "links parent on api", { start: false });
  const one = await addTask(page, "links child one on api", { start: false, partOf: parent });
  const two = await addTask(page, "links child two on api", { start: false, partOf: parent });

  await page.goto("/");
  await expect(card(page, parent)).toContainText("0 of 2 done");
  await expect(card(page, one)).toContainText(`Part of ${parent}`);
  await page.screenshot({ path: "e2e/screenshots/links-parent.png" });

  await page.goto(`/t/${parent}`);
  const links = page.getByTestId("task-links");
  await expect(links.getByText("0 of 2 done")).toBeVisible();
  await links.getByRole("button", { name: /Subtasks/ }).click();
  await expect(page.getByRole("menuitemradio", { name: new RegExp(one) })).toBeVisible();
  await page.keyboard.press("Escape");

  // Add a link from the task view: make the second child wait for the first.
  await page.goto(`/t/${two}`);
  await page.getByRole("button", { name: "Link a task" }).click();
  await page.getByRole("menuitem", { name: "Waits for..." }).click();
  const picker = page.getByRole("dialog", { name: "Waits for" });
  await picker.getByRole("button", { name: "Choose waits for" }).click();
  await picker.getByRole("menuitemradio", { name: new RegExp(`^${one}`) }).click();
  await picker.getByRole("button", { name: "Add link" }).click();
  await expect(page.getByTestId("task-links").getByText("Waits for")).toBeVisible();
  await page.getByRole("button", { name: `Remove link to ${one}` }).click();
  await page
    .getByRole("dialog", { name: "Remove link" })
    .getByRole("button", { name: "Remove link" })
    .click();
  await expect(page.getByTestId("task-links").getByText("Waits for")).toHaveCount(0);

  await cmd(request, "tasks.close", { id: one });
  await page.goto(`/t/${parent}`);
  await expect(page.getByTestId("task-links").getByText("1 of 2 done")).toBeVisible();
  expect(await status(request, parent)).not.toBe("done");

  await cmd(request, "tasks.close", { id: two });
  await expect.poll(() => status(request, parent)).toBe("done");
  await page.goto(`/t/${parent}`);
  await expect(page.getByTestId("task-links").getByText("2 of 2 done")).toBeVisible();
  await expect(page.getByText("Every subtask is done. Task closed.")).toBeVisible();
});
