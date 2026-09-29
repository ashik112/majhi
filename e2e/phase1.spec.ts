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
  await expect(progress).toContainText("Step 2 of 3");
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
  await expect(progress).toContainText("Step 3 of 3");
  const form = page.getByRole("form", { name: "Boss agent" });
  await expect(form.getByRole("combobox", { name: "Account" })).toHaveValue("claude-personal");
  await expect(form.getByRole("combobox", { name: "Model" })).not.toHaveValue("");
  await form.getByRole("button", { name: "Create boss" }).click();
  await expect(form.getByText("Health check passed")).toBeVisible();
  await shot(page, "onboarding-boss");
  await form.getByRole("button", { name: "Open majhi" }).click();
  await expect(page.getByRole("heading", { name: "Repos", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Repos", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add your first account" })).toHaveCount(0);

  const bossFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  expect(bossFiles).toHaveLength(1);
  expect(readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8")).toMatch(/^boss: /m);
});

test("Studio: an org, two Claude accounts, three agents, each health check passes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Studio" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = page.getByRole("table", { name: "Accounts" });
  await expect(accounts.getByRole("button", { name: "claude-personal", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add account" }).click();
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

  // Agent 1, through "Create an agent on this account".
  await page.getByRole("button", { name: "Create an agent on this account" }).click();
  const newAgent = page.getByRole("form", { name: "New agent" });
  await expect(newAgent.getByRole("combobox", { name: "Scope" })).toHaveValue("acme");
  await expect(newAgent.getByRole("combobox", { name: "Account" })).toHaveValue("claude-acme-2");
  await newAgent.getByRole("textbox", { name: "Agent id" }).fill("acme-builder");
  await newAgent.getByRole("combobox", { name: "Role" }).selectOption("Builder");
  await newAgent.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name: "@acme-builder" })).toBeVisible();
  await openHealthCheck(page, "Health check: @acme-builder");

  // Agents 2 and 3, from the group's "New" button.
  const agentList = page.getByRole("navigation", { name: "Agents" });
  for (const [id, role, account] of [
    ["acme-lead", "Lead", "claude-acme-1"],
    ["acme-reviewer", "Reviewer", "claude-acme-1"],
  ] as const) {
    await agentList.getByRole("button", { name: "New agent in Acme" }).click();
    await expect(newAgent).toBeVisible();
    await newAgent.getByRole("textbox", { name: "Agent id" }).fill(id);
    await newAgent.getByRole("combobox", { name: "Role" }).selectOption(role);
    await newAgent.getByRole("combobox", { name: "Account" }).selectOption(account);
    await newAgent.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByRole("heading", { name: `@${id}` })).toBeVisible();
    await openHealthCheck(page, `Health check: @${id}`);
  }

  await expect(agentList.getByRole("region", { name: "Acme" }).getByRole("button")).toHaveCount(4);
  expect(readAgent("acme-lead")).toContain("account: claude-acme-1");
  expect(readAgent("acme-builder")).toContain("account: claude-acme-2");
  await shot(page, "studio-agents");
});

test("an API-key account passes its health check and the key is never stored in the clear or sent back", async ({
  page,
}) => {
  const traffic = recordTraffic(page);
  await page.goto("/studio/accounts");
  await page.getByRole("button", { name: "Add account" }).click();
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
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: "codex-key", exact: true }) });
  await expect(row).toContainText("API key");
  await expect(row).toContainText("Healthy");

  // The account list and the health check ran again after the key was sent; none of it echoes the key.
  await page.getByRole("button", { name: "Health check codex-key" }).click();
  await expect(
    page.getByRole("dialog", { name: "Health check: codex-key" }).getByText("Health check passed"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

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
  await page.goto("/studio/accounts");
  const accountRow = (id: string) =>
    page.getByRole("row").filter({ has: page.getByRole("button", { name: id, exact: true }) });

  const acme1 = accountRow("claude-acme-1").getByRole("list", { name: "Used by" });
  await expect(acme1.getByRole("link")).toHaveText(["@acme-lead", "@acme-reviewer"]);
  await expect(
    accountRow("claude-acme-2").getByRole("list", { name: "Used by" }).getByRole("link"),
  ).toHaveText(["@acme-builder"]);
  await expect(accountRow("codex-key")).toContainText("Not used");

  const personal = accountRow("claude-personal").getByRole("list", { name: "Used by" });
  const boss = personal.getByRole("link", { name: /, boss$/ });
  await expect(boss).toHaveCount(1);
  await expect(boss).toContainText("boss");

  // Details group agents by scope.
  await accountRow("claude-acme-1").getByRole("button", { name: "claude-acme-1", exact: true }).click();
  const details = page.getByRole("complementary", { name: "Account details" });
  const acme = details.getByRole("region", { name: "Used by, Acme" });
  await expect(acme.getByRole("listitem")).toHaveCount(2);
  await expect(acme).toContainText("@acme-lead");
  await expect(acme).toContainText("@acme-reviewer");
  await shot(page, "studio-accounts");
  await page.getByRole("button", { name: "Close account details" }).click();

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
  await page.goto("/studio/agents?agent=acme-lead");
  await expect(page.getByRole("heading", { name: "@acme-lead" })).toBeVisible();
  const model = page.getByRole("combobox", { name: "Model" });
  const effort = page.getByRole("combobox", { name: "Effort" });
  await expect(model.locator("option")).not.toHaveCount(1);

  await model.selectOption("fake-model-c");
  await effort.selectOption("high");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect.poll(() => readAgent("acme-lead")).toMatch(/^model: fake-model-c$/m);
  expect(readAgent("acme-lead")).toMatch(/^effort: high$/m);

  // Reload: what was saved is what comes back.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("fake-model-c");

  // A hand edit shows in the open editor.
  writeFileSync(
    agentFile("acme-lead"),
    readAgent("acme-lead")
      .replace(/^model: .*$/m, "model: fake-model-b")
      .replace(/^effort: .*$/m, "effort: low")
      .concat("\nEdited by hand.\n"),
  );
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("fake-model-b");
  await expect(page.getByRole("combobox", { name: "Effort" })).toHaveValue("low");
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue(/Edited by hand\./);
});

test("removing an account that agents use is refused, and so is removing the boss", async ({
  page,
  request,
}) => {
  await page.goto("/studio/accounts");
  await page.getByRole("button", { name: "Remove claude-acme-1" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove claude-acme-1?" });
  await dialog.getByRole("button", { name: "Remove account" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Agents still use claude-acme-1");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "claude-acme-1", exact: true })).toBeVisible();

  // The boss's account is in use too.
  await page.getByRole("button", { name: "Remove claude-personal" }).click();
  await page.getByRole("button", { name: "Remove account" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Agents still use claude-personal" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // The editor blocks removing the boss, and the server refuses it too.
  const bossId = readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8").match(/^boss: (\S+)/m)?.[1];
  expect(bossId).toBeTruthy();
  await page.goto(`/studio/agents?agent=${bossId}`);
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
  await expect(page.getByText("The boss cannot be removed")).toBeVisible();
  const res = await request.post("/api/cmd/agents.remove", { data: { id: bossId } });
  expect(res.ok()).toBe(false);
  expect(await res.text()).toContain("is the boss");
  expect(readAgent(bossId as string)).toContain(`id: ${bossId}`);
});
