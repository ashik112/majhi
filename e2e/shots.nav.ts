import { expect, type Page, test } from "@playwright/test";
import type { OrgView, PendingNotice, TaskSummary } from "../packages/shared/src/index.ts";

/**
 * The sidebar, the workspace switcher and the notifications bell. The server is the seeded one (`ui`:
 * Globex, Acme, Northwind and Private, eleven agents, one signed-out account); the task list and the
 * notifications are stubbed in the browser, and the "long" scene renames Northwind to a long name and
 * fills Acme with hundreds of open tasks.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.nav.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/nav-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const LONG_NAME = "Northwind Traders International Logistics";

const summary = (
  id: string,
  org: string,
  title: string,
  status: TaskSummary["status"],
  extra: Partial<TaskSummary> = {},
): TaskSummary => ({
  id,
  title,
  kind: "code",
  org,
  status,
  team: [],
  mode: "lead",
  updatedAt: iso(10),
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
  ...extra,
});

/** A few tasks that need the owner, in every way the bell lists. */
const NEEDY: TaskSummary[] = [
  summary("GLX-433", "globex", "Progress events over the socket", "paused", {
    pausedReason: "limit",
    team: ["globex-builder"],
  }),
  summary("ACM-212", "acme", "Migrate the billing tables to the new ledger schema", "paused", {
    pausedReason: "error",
  }),
  summary("NW-77", "northwind", "Rotate the staging cluster certificates", "paused", {
    pausedReason: "loop",
  }),
  summary("GLX-440", "globex", "Alert when the export queue backs up", "paused", { pausedReason: "blocked" }),
  summary("ACM-219", "acme", "Publish the 4.2 release notes", "running", { asking: true }),
  summary("GLX-418", "globex", "Schematic export times out on large boards", "review", { asking: true }),
  summary("NW-81", "northwind", "Upgrade the ingress controller", "running", { asking: true }),
];

const NOTICES: PendingNotice[] = [
  {
    task: "ACM-219",
    item: "a1",
    kind: "approval",
    text: "ACM-219 needs approval: npm publish --tag latest",
    at: iso(9),
  },
  {
    task: "ACM-219",
    item: "s1",
    kind: "secret",
    text: "ACM-219 needs a secret: NPM_TOKEN for the Acme registry",
    at: iso(8),
  },
  {
    task: "GLX-418",
    item: "c1",
    kind: "question",
    text: "GLX-418 needs a decision: Keep the synchronous export behind a flag for one release, or remove it now?",
    at: iso(6),
  },
  {
    task: "NW-81",
    item: "q1",
    kind: "question",
    text: "@northwind-ops in NW-81 is asking you something",
    at: iso(3),
  },
];

function scene(kind: "short" | "long"): TaskSummary[] {
  const base = [...NEEDY, summary("GLX-450", "globex", "Document the export API", "inbox")];
  if (kind === "short") return base;
  const many = Array.from({ length: 236 }, (_, i) =>
    summary(`ACM-${300 + i}`, "acme", `Backlog item ${i + 1}`, i % 9 === 0 ? "ready" : "inbox"),
  );
  const nw = Array.from({ length: 128 }, (_, i) =>
    summary(`NW-${200 + i}`, "northwind", `Infra chore ${i + 1}`, "inbox"),
  );
  return [...base, ...many, ...nw];
}

async function stub(page: Page, kind: "short" | "long"): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("majhi.setup.skipped", "1");
    window.localStorage.removeItem("majhi.org");
  });
  await page.route("**/api/cmd/tasks.list", (r) => r.fulfill({ json: scene(kind) }));
  await page.route("**/api/cmd/notify.pending", (r) => r.fulfill({ json: NOTICES }));
  if (kind === "long")
    await page.route("**/api/cmd/orgs.list", async (r) => {
      const res = await r.fetch();
      const orgs = (await res.json()) as OrgView[];
      await r.fulfill({
        json: orgs.map((o) => (o.id === "northwind" ? { ...o, name: LONG_NAME } : o)),
      });
    });
}

async function theme(page: Page, value: "dark" | "light"): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, value);
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const switcher = (page: Page) => page.getByRole("button", { name: /^Workspace: / });
const workspaces = (page: Page) => page.getByRole("menu", { name: "Workspaces" });

/** Nothing runs off the window, and at 900px the sidebar's middle fits without scrolling. */
async function fits(page: Page, h: number): Promise<void> {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
  if (h >= 900) {
    const scroll = await nav(page).evaluate((n) => {
      const box = n.parentElement as HTMLElement;
      return box.scrollHeight - box.clientHeight;
    });
    expect(scroll).toBeLessThanOrEqual(0);
  }
}

for (const kind of ["short", "long"] as const) {
  for (const [w, h] of [
    [1440, 900],
    [1100, 700],
  ] as const) {
    for (const t of ["dark", "light"] as const) {
      test(`sidebar ${kind} ${w}x${h} ${t}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await stub(page, kind);
        await page.goto("/agents");
        await theme(page, t);
        await expect(nav(page).getByRole("button", { name: /^Setup/ })).toContainText("Agents");
        await page.waitForTimeout(700);
        await page.screenshot({ path: `${SHOTS}/sidebar-${kind}-${w}x${h}-${t}.png` });
        await fits(page, h);
      });
    }
  }

  test(`switcher open ${kind}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await stub(page, kind);
    await page.goto("/");
    await theme(page, "dark");
    await switcher(page).click();
    await expect(workspaces(page)).toBeVisible();
    await expect(workspaces(page)).toBeInViewport({ ratio: 1 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/switcher-${kind}.png` });
  });
}

for (const t of ["dark", "light"] as const) {
  test(`bell panel ${t}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await stub(page, "long");
    await page.goto("/");
    await theme(page, t);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const panel = page.getByRole("dialog", { name: "Needs you" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("ACM-219 needs approval: npm publish --tag latest");
    await expect(panel).toContainText("Sign in claude-legacy: its agents cannot run until you do.");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/bell-${t}.png` });
  });
}

test("bell panel at 1100x700", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stub(page, "long");
  await page.goto("/agents");
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Needs you" });
  await expect(panel).toBeInViewport({ ratio: 1 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/bell-1100x700.png` });
});

for (const t of ["dark", "light"] as const) {
  test(`workspaces page ${t}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await stub(page, "long");
    await page.goto("/orgs");
    await theme(page, t);
    await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${SHOTS}/workspaces-page-${t}.png` });
  });
}

test("choosing a workspace on Agents stays on Agents and filters it; All shows everything again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, "short");
  await page.goto("/agents");
  const list = page.getByRole("navigation", { name: "Agents" });
  await expect(list.getByRole("region", { name: "Globex" })).toBeVisible();
  await expect(list.getByRole("region", { name: "Acme" })).toBeVisible();

  await switcher(page).click();
  await workspaces(page).getByRole("menuitemradio", { name: /Acme/ }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(switcher(page)).toHaveAccessibleName("Workspace: Acme. Change workspace");
  await expect(list.getByRole("region", { name: "Acme" })).toBeVisible();
  await expect(list.getByRole("region", { name: "Root" })).toBeVisible();
  await expect(list.getByRole("region", { name: "Globex" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/agents-filtered-acme.png` });

  // The choice stays while the owner moves between pages.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: /^Setup/ })
    .click();
  await page
    .getByRole("menu", { name: "Setup" })
    .getByRole("menuitem", { name: /^Accounts/ })
    .click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(switcher(page)).toHaveAccessibleName("Workspace: Acme. Change workspace");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: /^Setup/ })
    .click();
  await page
    .getByRole("menu", { name: "Setup" })
    .getByRole("menuitem", { name: /^Agents/ })
    .click();

  await switcher(page).click();
  await workspaces(page)
    .getByRole("menuitemradio", { name: /All workspaces/ })
    .click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(list.getByRole("region", { name: "Globex" })).toBeVisible();
  await expect(list.getByRole("region", { name: "Acme" })).toBeVisible();
});

test("every sidebar item opens its page", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stub(page, "short");
  await page.goto("/agents");
  for (const [name, path, heading] of [
    ["Today", "/today", "Today"],
    ["Decisions", "/decisions", "Decisions"],
    ["Board", "/", "Board"],
    ["Chats", "/chats", undefined],
    ["Business", "/business", "Business"],
    ["Captain", "/captain", "Captain"],
    ["Playbooks", "/playbooks", "Playbooks"],
  ] as const) {
    const link = nav(page).getByRole("link", { name: new RegExp(`^${name}`) });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/" : path}$`));
    await expect(link).toHaveAttribute("aria-current", "page");
    if (heading)
      await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
  }
  // Everything set up once opens from the one Setup row, which then names the page.
  for (const [name, path, heading] of [
    ["Agents", "/agents", "Agents"],
    ["Accounts", "/accounts", "Accounts"],
    ["Connections", "/connections", "Connections"],
    ["Projects and links", "/projects", "Projects and links"],
    ["Skills", "/skills", "Skills & MCP"],
    ["Memory", "/memory", "Memory"],
    ["Automations", "/automations", "Automations"],
    ["Limits", "/limits", "Limits"],
    ["Hub setup", "/setup", "Hub setup"],
    ["Health and usage", "/usage", "Health and usage"],
    ["Audit log", "/audit", "Audit log"],
  ] as const) {
    await nav(page)
      .getByRole("button", { name: /^Setup/ })
      .click();
    await page
      .getByRole("menu", { name: "Setup" })
      .getByRole("menuitem", { name: new RegExp(`^${name}`) })
      .click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(nav(page).getByRole("button", { name: /^Setup/ })).toContainText(name);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
  }

  // Captain opens its page, and the chat button beside it opens the drawer; Workspaces open from the switcher.
  await nav(page)
    .getByRole("link", { name: /^Captain/ })
    .click();
  await expect(page).toHaveURL(/\/captain$/);
  const chat = nav(page).getByRole("button", { name: "Open the captain chat" });
  await chat.click();
  await expect(chat).toHaveAttribute("aria-pressed", "true");
  await chat.click();
  await switcher(page).click();
  await workspaces(page).getByRole("menuitem", { name: "Manage workspaces" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
  await expect(sidebar(page)).toBeVisible();
});

test("the bell opens and a row opens its task", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, "short");
  await page.goto("/agents");
  const bell = page.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName(`Notifications, ${4 + NOTICES.length + 1} need you`);
  await bell.click();
  const panel = page.getByRole("dialog", { name: "Needs you" });
  await panel.getByRole("button", { name: /ACM-219 needs approval/ }).click();
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/t\/ACM-219\?item=a1$/);

  // An account row opens Accounts on that account.
  await bell.click();
  await panel.getByRole("button", { name: /Sign in claude-legacy/ }).click();
  await expect(page).toHaveURL(/\/accounts\?account=claude-legacy$/);
});
