import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { MAJHI_HOME } from "./fixture.ts";

// One server, one majhi home: each test builds on the state the previous one left.
// Phase 0's tests leave roots configured, so the first test starts over from first run.
test.describe.configure({ mode: "serial" });

const FAKE_KEY = "sk-test-fake-0000";
const AGENTS_DIR = join(MAJHI_HOME, "agents");

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });
const agentFile = (id: string) => join(AGENTS_DIR, `${id}.md`);
const readAgent = (id: string) => readFileSync(agentFile(id), "utf8");

/** Everything the page received from majhi: command responses and socket frames. */
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
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => seen.push(String(frame.payload)));
  });
  return seen;
}

async function waitForHelper(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const res = await request.post("/api/cmd/host.status", { data: {} });
      return ((await res.json()) as { connected: boolean }).connected;
    })
    .toBe(true);
}

/** Types a code into the embedded terminal once the fake Claude login asks for it. */
async function signInThroughTerminal(page: Page) {
  const terminal = page.getByRole("region", { name: "Sign-in terminal" });
  await expect(terminal).toContainText("Paste code here");
  await terminal.click();
  await page.keyboard.type("fake-code");
  await page.keyboard.press("Enter");
}

/** Fills the add-account form for a Claude login account and signs in. */
async function addClaudeLogin(page: Page, id: string, org?: string) {
  const form = page.getByRole("form", { name: "Add an account" });
  await expect(form.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  if (org) await form.getByRole("combobox", { name: "Belongs to" }).selectOption({ label: org });
  await form.getByRole("textbox", { name: "Account id" }).fill(id);
  await form.getByRole("button", { name: "Add account and sign in" }).click();
  await signInThroughTerminal(page);
  await expect(page.getByRole("status").filter({ hasText: `${id} is signed in and healthy` })).toBeVisible();
}

async function openHealthPage(page: Page) {
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Health and usage" })).toBeVisible();
}

const accountRow = (page: Page, id: string) =>
  page
    .getByRole("list", { name: "Accounts" })
    .getByRole("listitem")
    .filter({
      has: page.getByRole("button", { name: id, exact: true }),
    });

async function openHealthCheck(page: Page, title: string) {
  await page.getByRole("button", { name: "Health check", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog.getByText("Health check passed")).toBeVisible();
  // The CLI starts, it is signed in, the ACP session opens, and the model is available.
  await expect(dialog.getByRole("list", { name: "Health check steps" }).getByRole("listitem")).toHaveCount(4);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

test("fresh install: roots, first account, boss, and onboarding does not come back", async ({
  page,
  request,
}) => {
  rmSync(join(MAJHI_HOME, "majhi.yaml"), { force: true });
  await waitForHelper(request);
  await page.goto("/");

  // Step 1
  await expect(page.getByRole("heading", { name: "Pick your workspace roots" })).toBeVisible();
  await page
    .getByRole("list", { name: "Suggested" })
    .getByRole("button", { name: /^~\/Work/ })
    .click();
  await page.getByRole("button", { name: /Save roots/ }).click();

  // Step 2: sign in through the terminal
  const progress = page.getByRole("navigation", { name: "Setup progress" });
  await expect(page.getByRole("heading", { name: "Add your first account" })).toBeVisible();
  await expect(progress).toContainText("Step 2 of 4");
  await page.getByRole("textbox", { name: "Account id" }).fill("claude-personal");
  await page.getByRole("button", { name: "Add account and sign in" }).click();
  await expect(page.getByRole("region", { name: "Sign-in terminal" })).toContainText("Paste code here");
  await shot(page, "add-account-terminal");
  await signInThroughTerminal(page);
  await expect(
    page.getByRole("status").filter({ hasText: "claude-personal is signed in and healthy" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Health check steps" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: the boss, with the suggested defaults
  await expect(page.getByRole("heading", { name: "Choose the boss" })).toBeVisible();
  await expect(progress).toContainText("Step 3 of 4");
  const form = page.getByRole("form", { name: "Boss agent" });
  await expect(form.getByRole("button", { name: /^claude-personal/, pressed: true })).toBeVisible();
  // The account's default model is picked, not "Account default".
  await expect(form.getByRole("group", { name: "Model" }).getByRole("button", { pressed: true })).toHaveText(
    /fake-model/,
  );
  await form.getByRole("button", { name: "Create boss" }).click();
  await expect(form.getByText("Health check passed")).toBeVisible();
  await shot(page, "onboarding-boss");
  await form.getByRole("button", { name: "Continue" }).click();

  // Step 4: the boss answers a first message.
  await expect(page.getByRole("heading", { name: "Finish with the boss" })).toBeVisible();
  await expect(progress).toContainText("Step 4 of 4");
  await expect(
    page.getByRole("log", { name: "Room messages" }).getByText(/^echo: Hi\. I just finished/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open majhi" }).click();
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add your first account" })).toHaveCount(0);

  const bossFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  expect(bossFiles).toHaveLength(1);
  expect(readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8")).toMatch(/^boss: /m);
});

test("Health and Agents: an org, two Claude accounts, three agents, each health check passes", async ({
  page,
}) => {
  await openHealthPage(page);
  await expect(accountRow(page, "claude-personal")).toBeVisible();

  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const form = page.getByRole("form", { name: "Add an account" });
  await form.getByRole("combobox", { name: "Belongs to" }).selectOption({ label: "New org..." });
  const orgForm = page.getByRole("form", { name: "New org" });
  await orgForm.getByRole("textbox", { name: "Org name" }).fill("Acme");
  await expect(orgForm.getByRole("textbox", { name: "Org id" })).toHaveValue("acme");
  await orgForm.getByRole("button", { name: "Create org" }).click();
  await expect(orgForm).toBeHidden();
  await expect(form.getByRole("combobox", { name: "Belongs to" })).toHaveValue("acme");

  await addClaudeLogin(page, "claude-acme-1");
  await page.getByRole("button", { name: "Add another account" }).click();
  await addClaudeLogin(page, "claude-acme-2", "Acme");

  // Agent 1, through "Create an agent on this account": the Acme tab opens with that account chosen.
  await page.getByRole("link", { name: "Create an agent on this account" }).click();
  const newAgent = page.getByRole("form", { name: "New agent" });
  await expect(page.getByRole("tab", { name: /^Acme/ })).toHaveAttribute("aria-selected", "true");
  await expect(newAgent.getByRole("button", { name: /^claude-acme-2/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await newAgent.getByRole("textbox", { name: "Agent id" }).fill("acme-builder");
  await newAgent.getByRole("button", { name: "Builder", exact: true }).click();
  await newAgent.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name: "@acme-builder" })).toBeVisible();
  await openHealthCheck(page, "Health check: @acme-builder");

  // Agents 2 and 3, from the list's "New agent" button.
  const agentList = page.getByRole("navigation", { name: "Agents in scope" });
  for (const [id, role, account] of [
    ["acme-lead", "Lead", "claude-acme-1"],
    ["acme-reviewer", "Reviewer", "claude-acme-1"],
  ] as const) {
    await agentList.getByRole("button", { name: "New agent in Acme" }).click();
    await expect(newAgent).toBeVisible();
    await newAgent.getByRole("textbox", { name: "Agent id" }).fill(id);
    await newAgent.getByRole("button", { name: role, exact: true }).click();
    await newAgent.getByRole("button", { name: new RegExp(`^${account}`) }).click();
    await newAgent.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByRole("heading", { name: `@${id}` })).toBeVisible();
    await openHealthCheck(page, `Health check: @${id}`);
  }

  await expect(agentList.getByRole("button", { name: /^@acme-/ })).toHaveCount(3);
  await expect(page.getByRole("tab", { name: /^Acme/ })).toContainText("3");
  expect(readAgent("acme-lead")).toContain("account: claude-acme-1");
  expect(readAgent("acme-builder")).toContain("account: claude-acme-2");
  await shot(page, "agents-editor");
});

test("an API-key account passes its health check and the key is never stored in the clear or sent back", async ({
  page,
}) => {
  const traffic = recordTraffic(page);
  await openHealthPage(page);
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const form = page.getByRole("form", { name: "Add an account" });
  await form.getByRole("radio", { name: "Codex" }).click();
  await form.getByRole("radio", { name: "API key" }).click();
  await form.getByRole("textbox", { name: "Account id" }).fill("codex-key");
  await form.getByRole("textbox", { name: "OpenAI API key" }).fill(FAKE_KEY);
  await form.getByRole("button", { name: "Add account and check it" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "codex-key is signed in and healthy" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Health check steps" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Close add account" }).click();
  const row = accountRow(page, "codex-key");
  await expect(row).toContainText("API key");
  await expect(row).toContainText("Healthy");
  await expect(row).toContainText("Tokens and cost show after the first run");

  // The account list and the health check ran again after the key was sent; none of it echoes the key.
  await row.getByRole("button", { name: "codex-key", exact: true }).click();
  await page.getByRole("button", { name: "Health check codex-key" }).click();
  await expect(
    page.getByRole("dialog", { name: "Health check: codex-key" }).getByText("Health check passed"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Account details" })).toContainText(
    "Tokens and cost show after the first run",
  );

  expect(traffic.length).toBeGreaterThan(3);
  expect(traffic.filter((body) => body.includes(FAKE_KEY))).toEqual([]);
  expect(readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8")).not.toContain(FAKE_KEY);
  expect(readFileSync(join(MAJHI_HOME, "secrets.age")).includes(FAKE_KEY)).toBe(false);
  const history = execFileSync("git", ["-C", MAJHI_HOME, "log", "-p", "--all"], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  expect(history).toContain("codex-key");
  expect(history).not.toContain(FAKE_KEY);
});

test("Accounts show who uses them, and a file with a missing account appears without a reload", async ({
  page,
}) => {
  await openHealthPage(page);

  await expect(accountRow(page, "claude-acme-1")).toContainText("2 agents");
  await expect(accountRow(page, "claude-acme-2")).toContainText("1 agent");
  await expect(accountRow(page, "codex-key")).toContainText("0 agents");

  // Usage is read in the background after each sign-in, without spending tokens.
  await expect(accountRow(page, "claude-acme-1")).toContainText("42%");
  await expect(accountRow(page, "claude-acme-1")).toContainText("18%");
  await expect(accountRow(page, "codex-key")).toContainText("Tokens and cost show after the first run");

  // The boss shows in its account's details, with a link to its editor.
  await accountRow(page, "claude-personal")
    .getByRole("button", { name: "claude-personal", exact: true })
    .click();
  const details = page.getByRole("complementary", { name: "Account details" });
  const root = details.getByRole("region", { name: "Used by, Root" });
  await expect(root.getByRole("link")).toHaveCount(1);
  await expect(root).toContainText("Boss");

  // Details group agents by scope.
  await accountRow(page, "claude-acme-1").getByRole("button", { name: "claude-acme-1", exact: true }).click();
  const acme = details.getByRole("region", { name: "Used by, Acme" });
  await expect(acme.getByRole("listitem")).toHaveCount(2);
  await expect(acme).toContainText("@acme-lead");
  await expect(acme).toContainText("@acme-reviewer");
  await expect(details).toContainText("Plan: max");
  await expect(details).toContainText("Current window");
  await expect(details).toContainText("42%");
  await expect(details).toContainText("Week, Opus");
  await details.getByRole("button", { name: "Refresh" }).click();
  await expect(details).toContainText("Read just now");
  await shot(page, "health-accounts");
  await page.getByRole("button", { name: "Close account details" }).click();

  // "Run health check" checks every account and the page says so.
  await page.getByRole("button", { name: "Run health check" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Health check finished" })).toHaveCount(1);
  await expect(page.getByText(/Checked just now/)).toBeVisible();

  // A hand-written agent file naming an account that does not exist.
  await expect(page.getByRole("region", { name: "Missing accounts" })).toHaveCount(0);
  const ghost = readAgent("acme-lead")
    .replace(/^id: .*$/m, "id: ghost")
    .replace(/^account: .*$/m, "account: claude-gone");
  writeFileSync(agentFile("ghost"), ghost);
  const missing = page.getByRole("region", { name: "Missing accounts" });
  await expect(missing).toContainText("claude-gone");
  await expect(missing).toContainText("@ghost");
  rmSync(agentFile("ghost"));
  await expect(missing).toBeHidden();
});

test("the agent editor saves model and effort to the file, and follows a hand edit", async ({ page }) => {
  await page.goto("/agents?agent=acme-lead");
  await expect(page.getByRole("heading", { name: "@acme-lead" })).toBeVisible();
  const model = page.getByRole("group", { name: "Model" });
  const effort = page.getByRole("group", { name: "Effort" });
  // Account default and Auto are always there; the account's own models follow once they load.
  await expect(model.getByRole("button")).not.toHaveCount(2);

  await model.getByRole("button", { name: "fake-model-c" }).click();
  await effort.getByRole("button", { name: "high", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect.poll(() => readAgent("acme-lead")).toMatch(/^model: fake-model-c$/m);
  expect(readAgent("acme-lead")).toMatch(/^effort: high$/m);

  // Reload: what was saved is what comes back.
  await page.reload();
  await expect(model.getByRole("button", { name: "fake-model-c" })).toHaveAttribute("aria-pressed", "true");

  // A hand edit shows in the open editor.
  writeFileSync(
    agentFile("acme-lead"),
    readAgent("acme-lead")
      .replace(/^model: .*$/m, "model: fake-model-b")
      .replace(/^effort: .*$/m, "effort: low")
      .concat("\nEdited by hand.\n"),
  );
  await expect(model.getByRole("button", { name: "fake-model-b" })).toHaveAttribute("aria-pressed", "true");
  await expect(effort.getByRole("button", { name: "low", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue(/Edited by hand\./);
});

test("permissions are tiles: Read code is always allowed, the rest toggle and save to the file", async ({
  page,
}) => {
  await page.goto("/agents?agent=acme-reviewer");
  await expect(page.getByRole("heading", { name: "@acme-reviewer" })).toBeVisible();
  await expect(page.getByText("Read code")).toBeVisible();
  const push = page.getByRole("button", { name: "Push branches: Off" });
  await push.click();
  await expect(page.getByRole("button", { name: "Push branches: Allowed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => readAgent("acme-reviewer")).toMatch(/^perms: \[.*push.*\]/m);
  await page.getByRole("button", { name: "Push branches: Allowed" }).click();
  await expect.poll(() => readAgent("acme-reviewer")).not.toMatch(/^perms: \[.*push.*\]/m);
});

test("removing an account that agents use is refused, and so is removing the boss", async ({
  page,
  request,
}) => {
  await openHealthPage(page);
  await accountRow(page, "claude-acme-1").getByRole("button", { name: "claude-acme-1", exact: true }).click();
  await page.getByRole("button", { name: "Remove claude-acme-1" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove claude-acme-1?" });
  await dialog.getByRole("button", { name: "Remove account" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Agents still use claude-acme-1");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "claude-acme-1", exact: true })).toBeVisible();

  // The boss's account is in use too.
  await accountRow(page, "claude-personal")
    .getByRole("button", { name: "claude-personal", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove claude-personal" }).click();
  await page.getByRole("button", { name: "Remove account" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Agents still use claude-personal" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // The editor blocks removing the boss, and the server refuses it too.
  const bossId = readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8").match(/^boss: (\S+)/m)?.[1];
  expect(bossId).toBeTruthy();
  await page.goto(`/agents?agent=${bossId}`);
  await page.getByRole("button", { name: "Agent actions" }).click();
  const remove = page.getByRole("menuitem", { name: /^Remove/ });
  await expect(remove).toBeDisabled();
  await expect(remove).toContainText("the boss cannot be removed");
  const res = await request.post("/api/cmd/agents.remove", { data: { id: bossId } });
  expect(res.ok()).toBe(false);
  expect(await res.text()).toContain("is the boss");
  expect(readAgent(bossId as string)).toContain(`id: ${bossId}`);
});
