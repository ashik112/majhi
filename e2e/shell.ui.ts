import { expect, type Page, test } from "@playwright/test";

// The seeded home has orgs Globex (GLX), Acme (ACM) and Northwind (NW), eleven agents, projects in each
// org and one account that is signed out. No task exists at the start; tests share one server and run in order.
test.describe.configure({ mode: "serial" });

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const board = (page: Page) => page.getByRole("heading", { name: "Board", exact: true });

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => window.localStorage.setItem("majhi.setup.skipped", "1"));
});

test("the sidebar links to every page, and the old addresses land on the new ones", async ({ page }) => {
  await page.goto("/");
  await expect(board(page)).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
  await expect(nav(page).getByRole("link", { name: /^Agents/ })).toContainText("11");

  for (const [name, path] of [
    ["Agents", "/agents"],
    ["Accounts", "/accounts"],
    ["Health and usage", "/usage"],
    ["Skills", "/skills"],
    ["Hub setup", "/setup"],
    ["Projects and links", "/projects"],
    ["Orgs", "/orgs"],
  ] as const) {
    await nav(page)
      .getByRole("link", { name: new RegExp(`^${name}`) })
      .click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(nav(page).getByRole("link", { name: new RegExp(`^${name}`) })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }

  await page.goto("/repos");
  await expect(page).toHaveURL(/\/projects$/);
  await page.goto("/studio/agents");
  await expect(page).toHaveURL(/\/agents$/);
  await page.goto("/studio/accounts");
  await expect(page).toHaveURL(/\/accounts$/);
});

test("the banner shows what needs the owner, and the sidebar counts it", async ({ page }) => {
  await page.goto("/");
  const banner = page.getByRole("status").filter({ hasText: "needs you to sign in" });
  await expect(banner).toContainText("claude-legacy needs you to sign in.");
  await banner.getByRole("button", { name: "Accounts" }).click();
  await expect(page).toHaveURL(/\/accounts\?account=claude-legacy$/);
  await expect(page.getByRole("region", { name: "Account details" })).toContainText("claude-legacy");
  await expect(nav(page).getByRole("link", { name: /^Accounts/ })).toContainText("An account needs you");

  const pulse = page.getByRole("region", { name: "Agents right now" });
  await expect(pulse).toContainText("Working");
  await expect(pulse).toContainText("Idle");
  await expect(pulse).toContainText("Health checked");
});

test("keys: g then a letter goes to a page, ? lists the keys", async ({ page }) => {
  await page.goto("/");
  await expect(board(page)).toBeVisible();
  for (const [keys, path] of [
    ["a", "/agents"],
    ["c", "/accounts"],
    ["h", "/usage"],
    ["s", "/setup"],
    ["p", "/projects"],
    ["o", "/orgs"],
  ] as const) {
    await page.keyboard.press("g");
    await page.keyboard.press(keys);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
  await page.keyboard.press("g");
  await page.keyboard.press("b");
  await expect(page).toHaveURL(/\/$/);
  await expect(board(page)).toBeVisible();

  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toContainText("New task");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("an empty board invites the first task; typing everything in the title picks the project and base", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Nothing on the board yet" })).toBeVisible();
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  const title = dialog.getByRole("textbox", { name: "Title" });
  await expect(title).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Add to inbox" })).toBeDisabled();

  await title.fill("fix the login redirect in alpha-api from develop");
  await expect(dialog.getByRole("button", { name: "alpha-api", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByText("Branches from develop")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Agent: @globex-lead/ })).toBeVisible();

  await dialog
    .getByRole("textbox", { name: "Details for the team" })
    .fill("The redirect loses the query string.");
  // A chip adds a project the words do not name.
  await dialog.getByRole("button", { name: "beta-web", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "beta-web", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("button", { name: "beta-web", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "beta-web", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await dialog.getByRole("button", { name: "Add to inbox" }).click();
  await expect(page).toHaveURL(/\/t\/GLX-\d+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("fix the login redirect");
  await expect(page.getByText("The redirect loses the query string.")).toBeVisible();
  // The task is in the inbox, so the panel offers Start and the branch card names the base.
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Branch and worktree" })).toContainText("develop");
  await expect(
    page.getByRole("complementary", { name: "Task details" }).getByText("@globex-lead"),
  ).toBeVisible();
});

test("the board shows the task in Inbox; j and Enter open it, n adds a chat task", async ({ page }) => {
  await page.goto("/");
  const inbox = page.getByRole("region", { name: "Inbox" });
  const card = inbox.getByRole("link", { name: /fix the login redirect/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText("alpha-api");
  await expect(page.getByText("1 open")).toBeVisible();

  await page.keyboard.press("j");
  await expect(card).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/t\/GLX-\d+$/);
  await page.getByRole("link", { name: "Back to board" }).click();
  await expect(board(page)).toBeVisible();

  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Title" }).fill("Explain how sessions are stored");
  await expect(dialog.getByText("this becomes a chat task")).toBeVisible();
  await dialog.getByRole("button", { name: "Add to inbox" }).click();
  await expect(page).toHaveURL(/\/t\/LOCAL-\d+$/);
  await page.getByRole("link", { name: "Back to board" }).click();
  await expect(inbox.getByRole("link")).toHaveCount(2);

  // h and l move between columns; there is only Inbox with cards, so the cursor stays.
  await page.keyboard.press("j");
  await page.keyboard.press("l");
  await expect(inbox.getByRole("link").first()).toBeFocused();
});

test("the org filter is remembered, keeps URLs clean, and narrows the board, the count and the dialog", async ({
  page,
}) => {
  await page.goto("/");
  const orgs = page.getByRole("group", { name: "Filter by org" });
  await expect(orgs.getByRole("button", { name: /All orgs/ })).toHaveAttribute("aria-pressed", "true");
  await expect(orgs.getByRole("button", { name: /Globex/ })).toContainText("1");

  await orgs.getByRole("button", { name: /Globex/ }).click();
  await expect(page).not.toHaveURL(/org=/);
  await expect(orgs.getByRole("button", { name: /Globex/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: /fix the login redirect/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Explain how sessions/ })).toHaveCount(0);
  await expect(page.getByText("1 open")).toBeVisible();

  // The filter goes with the owner to a page and back, and the dialog opens on that org's projects.
  await nav(page)
    .getByRole("link", { name: /^Agents/ })
    .click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog.getByRole("button", { name: "alpha-api", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await orgs.getByRole("button", { name: /All orgs/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /Explain how sessions/ })).toBeVisible();
});
