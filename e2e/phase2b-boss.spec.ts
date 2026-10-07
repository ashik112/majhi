import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, MAJHI_HOME, test, useHome } from "./fixture.ts";

// The captain (majhi-boss) on a signed-in account. The fake adapter turns "call: <tool> {json}" into a
// real call to the majhi-admin MCP server, and echoes anything else.
useHome({ seed: "team" });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

const SECRET = "nr-e2e-not-a-real-secret-4711";
const API_KEY = `sk-ant-api03-${"Zq8Lm2".repeat(8)}`;

const drawer = (page: Page) => page.getByRole("complementary", { name: "Captain" });
const composer = (page: Page) => drawer(page).getByRole("textbox", { name: "Message the room" });
const log = (page: Page) => drawer(page).getByRole("log", { name: "Room messages" });

async function cmd<T>(request: APIRequestContext, name: string, data: object = {}): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** Everything the page received from majhi: command answers and socket frames. */
function recordTraffic(page: Page): string[] {
  const seen: string[] = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/")) return;
    try {
      seen.push(await res.text());
    } catch {
      // Redirects and aborted requests have no body.
    }
  });
  page.on("websocket", (ws) => ws.on("framereceived", (frame) => seen.push(String(frame.payload))));
  return seen;
}

async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

async function showSteps(page: Page) {
  // The decision line shows once the card has settled and folded.
  await expect(
    log(page)
      .getByText(/^You (approved|rejected): /)
      .last(),
  ).toBeVisible();
  await openLastSteps(page);
}

/** Opens the newest "steps it took" row, and leaves it open if it already is. */
async function openLastSteps(page: Page) {
  const fold = log(page)
    .getByRole("button", { name: /steps? it took/ })
    .last();
  await expect(fold).toBeVisible();
  // The log can re-render under the click; click again until the row stays open.
  await expect(async () => {
    if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function openBoss(page: Page) {
  // The key handler is part of the shell, which mounts after the config loads.
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await page.keyboard.press("Meta+j");
  await expect(drawer(page)).toBeVisible();
}

test("Cmd J opens the captain over any page; a change waits for approval, then applies and can be undone", {
  tag: "@smoke",
}, async ({ page }) => {
  await page.goto("/agents");
  await expect(drawer(page)).toHaveCount(0);
  await openBoss(page);

  await say(
    page,
    'call: majhi_orgs_create {"id":"globex","name":"Globex","ownerAsked":false,"reason":"You mentioned a second company"}',
  );
  const card = drawer(page).getByRole("region", { name: "Approval: Create org Globex" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Reject" })).toBeVisible();
  await shot(page, "boss-approval");

  // Nothing changed yet.
  expect((await cmd<{ id: string }[]>(page.request, "orgs.list")).map((o) => o.id)).not.toContain("globex");

  await card.getByRole("button", { name: "Approve" }).click();
  // A settled approval folds into the conversation's "steps it took" row.
  await showSteps(page);
  // The change applied, and the captain is told.
  await expect
    .poll(async () => (await cmd<{ id: string }[]>(page.request, "orgs.list")).map((o) => o.id))
    .toContain("globex");
  await expect(
    log(page).getByText("echo: The owner approved: Create org Globex.", { exact: false }),
  ).toBeVisible();

  // History lists it, made by the captain.
  await page.goto("/setup?section=history");
  const history = page.getByRole("region", { name: "History" });
  await expect(history.getByText(/@majhi-boss/).first()).toBeVisible();

  // Undo from the card in the drawer.
  await openBoss(page);
  await showSteps(page);
  await drawer(page).getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await cmd<{ id: string }[]>(page.request, "orgs.list")).map((o) => o.id))
    .not.toContain("globex");
});

test("a secret request saves the value in secrets.age and it never shows in the page", async ({
  page,
  request,
}) => {
  const traffic = recordTraffic(page);
  await page.goto("/");
  await openBoss(page);
  await say(page, 'call: majhi_request_secret {"name":"newrelic-acme","label":"New Relic key for Acme"}');
  const card = drawer(page).getByRole("region", { name: "Secret requested: New Relic key for Acme" });
  await expect(card).toBeVisible();
  const field = card.getByLabel("New Relic key for Acme (saved as secret:newrelic-acme)");
  await expect(field).toHaveAttribute("type", "password");
  await field.fill(SECRET);
  await shot(page, "boss-secret-request");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(log(page).getByText("echo: Saved as secret:newrelic-acme")).toBeVisible();

  // Not in the page, not in a field, not in anything majhi sent back.
  expect(await page.content()).not.toContain(SECRET);
  expect(
    await page.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)),
  ).not.toContain(SECRET);
  expect(traffic.filter((t) => t.includes(SECRET))).toEqual([]);
  const names = await cmd<{ name: string }[]>(request, "secrets.list");
  expect(names.map((s) => s.name)).toContain("newrelic-acme");
  expect(JSON.stringify(names)).not.toContain(SECRET);
  expect(readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8")).not.toContain(SECRET);
  expect(readFileSync(join(MAJHI_HOME, "secrets.age")).toString("latin1")).not.toContain(SECRET);
});

test("a secret typed in the composer is saved, and only a reference is sent", async ({ page, request }) => {
  const traffic = recordTraffic(page);
  await page.goto("/");
  await openBoss(page);
  await composer(page).fill(`use ${API_KEY} for the account`);
  await composer(page).press("Enter");
  await expect(
    log(page)
      .getByText(/use secret:anthropic[a-z0-9-]* for the account/)
      .first(),
  ).toBeVisible();
  expect(await page.content()).not.toContain(API_KEY);
  expect(traffic.filter((t) => t.includes(API_KEY))).toEqual([]);

  expect(
    (await cmd<{ name: string }[]>(request, "secrets.list")).some((s) => s.name.startsWith("anthropic")),
  ).toBe(true);
});
