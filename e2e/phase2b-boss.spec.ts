import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, MAJHI_HOME, test, useHome } from "./fixture.ts";

// The boss (majhi-boss) on a signed-in account. The fake adapter turns "call: <tool> {json}" into a
// real call to the majhi-admin MCP server, and echoes anything else.
useHome({ seed: "team" });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

const SECRET = "nr-e2e-not-a-real-secret-4711";
const API_KEY = `sk-ant-api03-${"Zq8Lm2".repeat(8)}`;

const drawer = (page: Page) => page.getByRole("complementary", { name: "Boss chat" });
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

async function openBoss(page: Page) {
  // The key handler is part of the shell, which mounts after the config loads.
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await page.keyboard.press("Meta+j");
  await expect(drawer(page)).toBeVisible();
}

test("Cmd J opens the boss over any page; a change waits for approval, then applies and can be undone", {
  tag: "@smoke",
}, async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  await openBoss(page);

  await say(
    page,
    'call: majhi_orgs_create {"id":"globex","name":"Globex","ownerAsked":false,"reason":"You mentioned a second company"}',
  );
  const card = drawer(page).getByRole("region", { name: "Approval: Create org Globex" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Change", { exact: true })).toBeVisible();
  await expect(card.getByText("You mentioned a second company")).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Reject" })).toBeVisible();
  await card.getByText("Details").click();
  await expect(card.getByText('"name": "Globex"')).toBeVisible();
  await shot(page, "boss-approval");

  // Nothing changed yet.
  expect((await cmd<{ id: string }[]>(page.request, "orgs.list")).map((o) => o.id)).not.toContain("globex");

  await card.getByRole("button", { name: "Approve" }).click();
  await expect(drawer(page).getByText("Applied: Create org Globex", { exact: true })).toBeVisible();
  // The boss is told and answers.
  await expect(
    log(page).getByText("echo: The owner approved: Create org Globex.", { exact: false }),
  ).toBeVisible();

  // The org shows on the Workspaces page.
  await page.keyboard.press("Meta+j");
  await expect(drawer(page)).toHaveCount(0);
  await page.goto("/orgs");
  await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
  await expect(page.getByText("Globex").first()).toBeVisible();
  // Private is a normal org card, first, and cannot be removed.
  const priv = page.getByRole("region", { name: "Private" });
  await expect(priv).toBeVisible();
  await expect(priv.getByRole("button", { name: "Add account to Private" })).toBeVisible();
  await expect(priv.getByRole("button", { name: /remove/i })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Personal" })).toHaveCount(0);

  // History on Hub setup lists it, made by the boss.
  await page.goto("/setup?section=history");
  const history = page.getByRole("region", { name: "History" });
  await expect(history.getByText("added org globex")).toBeVisible();
  await expect(history.getByText(/@majhi-boss/).first()).toBeVisible();
  await shot(page, "hub-setup-boss");

  // Undo from the card in the drawer.
  await openBoss(page);
  await drawer(page).getByRole("button", { name: "Undo" }).click();
  await expect(drawer(page).getByText("Undone: Create org Globex", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+j");
  await expect(drawer(page)).toHaveCount(0);
  await page.goto("/orgs");
  await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
  await expect(page.getByText("Globex")).toHaveCount(0);
});

test("a rejected change stays undone; Undo also works from History", async ({ page, request }) => {
  await page.goto("/");
  await openBoss(page);
  await say(
    page,
    'call: majhi_orgs_create {"id":"initech","name":"Initech","ownerAsked":false,"reason":"try it"}',
  );
  const card = drawer(page).getByRole("region", { name: "Approval: Create org Initech" });
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(drawer(page).getByText("Rejected: Create org Initech", { exact: true })).toBeVisible();
  await expect(log(page).getByText("echo: The owner rejected: Create org Initech.")).toBeVisible();
  expect((await cmd<{ id: string }[]>(request, "orgs.list")).map((o) => o.id)).not.toContain("initech");

  // When the owner asked, a change runs at once and the card is applied.
  await say(
    page,
    'call: majhi_orgs_create {"id":"initech","name":"Initech","ownerAsked":true,"reason":"You asked for Initech"}',
  );
  await expect(drawer(page).getByText("Applied: Create org Initech", { exact: true })).toBeVisible();
  await page.keyboard.press("Meta+j");
  await page.goto("/setup?section=history");
  const history = page.getByRole("region", { name: "History" });
  await history.getByRole("button", { name: "Undo: added org initech" }).click();
  await expect
    .poll(async () => (await cmd<{ id: string }[]>(request, "orgs.list")).map((o) => o.id))
    .not.toContain("initech");
});

test("a secret request saves the value in secrets.age and it never shows in the page", async ({
  page,
  request,
}) => {
  const traffic = recordTraffic(page);
  await page.goto("/");
  await openBoss(page);
  await say(page, 'call: majhi_request_secret {"name":"newrelic-acme","label":"New Relic key for Acme"}');
  const card = drawer(page).getByRole("form", { name: "Secret requested: New Relic key for Acme" });
  await expect(card).toBeVisible();
  const field = card.getByLabel("New Relic key for Acme (saved as secret:newrelic-acme)");
  await expect(field).toHaveAttribute("type", "password");
  await field.fill(SECRET);
  await shot(page, "boss-secret-request");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(drawer(page).getByText("Saved New Relic key for Acme as secret:newrelic-acme")).toBeVisible();
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

test("the composer warns about a secret, and sends only a reference", async ({ page, request }) => {
  const traffic = recordTraffic(page);
  await page.goto("/");
  await openBoss(page);
  await composer(page).fill(`use ${API_KEY} for the account`);
  await expect(
    drawer(page).getByText("This looks like a secret. It will be saved and the agent gets only a reference."),
  ).toBeVisible();
  await composer(page).press("Enter");
  await expect(
    log(page).getByText(/Saved a secret as secret:anthropic[a-z0-9-]*; the agent sees only the reference/),
  ).toBeVisible();
  await expect(
    log(page)
      .getByText(/use secret:anthropic[a-z0-9-]* for the account/)
      .first(),
  ).toBeVisible();
  expect(await page.content()).not.toContain(API_KEY);
  expect(traffic.filter((t) => t.includes(API_KEY))).toEqual([]);

  // Plain talk gets no warning.
  await composer(page).fill("create an org called Acme");
  await expect(drawer(page).getByText(/This looks like a secret/)).toHaveCount(0);
  await composer(page).fill("");
  expect(
    (await cmd<{ name: string }[]>(request, "secrets.list")).some((s) => s.name.startsWith("anthropic")),
  ).toBe(true);
});

test("Hub setup: sections save on their own; changing the policy asks first", async ({ page, request }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Hub setup" })).toBeVisible();
  // The boss is not on the page: Ask the boss opens its drawer.
  await page.getByRole("button", { name: /Ask the boss/ }).click();
  await expect(composer(page)).toBeVisible();
  await page.keyboard.press("Meta+j");
  await expect(drawer(page)).toHaveCount(0);

  await page.getByRole("button", { name: /^Context and limits/ }).click();
  await expect(page).toHaveURL(/section=context/);
  const limits = page.getByRole("region", { name: "Limits", exact: true });
  await limits.getByLabel("Agents at once").fill("4");
  await limits.getByRole("button", { name: "Save Limits" }).click();
  await expect(limits.getByRole("status")).toContainText("Saved");
  expect((await cmd<{ limits: { agents_max: number } }>(request, "settings.get")).limits.agents_max).toBe(4);

  await page.goto("/setup?section=approvals");
  const policy = page.getByRole("region", { name: "Approval policy", exact: true });
  await policy.getByLabel("Changes").selectOption("confirm");
  await policy.getByRole("button", { name: "Save Approval policy" }).click();
  const dialog = page.getByRole("dialog", { name: "Change the approval policy?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await cmd<{ policy: { change: string } }>(request, "settings.get")).policy.change).toBe(
    "when-asked",
  );
  await policy.getByRole("button", { name: "Save Approval policy" }).click();
  await dialog.getByRole("button", { name: "Change policy" }).click();
  await expect(policy.getByRole("status")).toContainText("Saved");
  expect((await cmd<{ policy: { change: string } }>(request, "settings.get")).policy.change).toBe("confirm");

  // With "confirm", even a call the owner asked for waits.
  await openBoss(page);
  await say(
    page,
    'call: majhi_orgs_create {"id":"umbrella","name":"Umbrella","ownerAsked":true,"reason":"You asked"}',
  );
  await expect(drawer(page).getByRole("region", { name: "Approval: Create org Umbrella" })).toBeVisible();
  await page.keyboard.press("Meta+j");
  await shot(page, "hub-setup-settings");
});
