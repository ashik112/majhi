import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, MAJHI_HOME, test, useHome } from "./fixture.ts";

// From first run. Each test builds on the state the previous one left.
useHome({ seed: "empty" });
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

async function openAccountsPage(page: Page) {
  await page.goto("/accounts");
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
}

const accountRow = (page: Page, id: string) =>
  page
    .getByRole("navigation", { name: "Accounts" })
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

test("fresh install: roots, first account, boss, and onboarding does not come back", {
  tag: "@smoke",
}, async ({ page, request }) => {
  await waitForHelper(request);
  await page.goto("/");

  // Step 1
  await expect(page.getByRole("heading", { name: "Pick your project folders" })).toBeVisible();
  await page
    .getByRole("list", { name: "Suggested" })
    .getByRole("button", { name: /^~\/Work/ })
    .click();
  await page.getByRole("button", { name: /Save folders/ }).click();

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

  // Step 3: the captain, with the suggested defaults
  await expect(page.getByRole("heading", { name: "Choose the captain" })).toBeVisible();
  await expect(progress).toContainText("Step 3 of 4");
  const form = page.getByRole("form", { name: "Captain agent" });
  await expect(form.getByRole("button", { name: /^claude-personal/, pressed: true })).toBeVisible();
  // The account's default model is picked, not "Account default".
  await expect(form.getByRole("group", { name: "Model" }).getByRole("button", { pressed: true })).toHaveText(
    /fake-model/,
  );
  await form.getByRole("button", { name: "Create captain" }).click();
  await expect(form.getByText("Health check passed")).toBeVisible();
  await shot(page, "onboarding-boss");
  await form.getByRole("button", { name: "Continue" }).click();

  // Step 4: the captain answers a first message.
  await expect(page.getByRole("heading", { name: "Finish with the captain" })).toBeVisible();
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

test("Accounts and Agents: an org, two Claude accounts, three agents, each health check passes", async ({
  page,
}) => {
  await openAccountsPage(page);
  await expect(accountRow(page, "claude-personal")).toBeVisible();

  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const form = page.getByRole("form", { name: "Add an account" });
  // With no other org, the account starts in Private.
  await expect(form.getByRole("combobox", { name: "Belongs to" })).toHaveValue("private");
  await form.getByRole("combobox", { name: "Belongs to" }).selectOption({ label: "New workspace..." });
  const orgForm = page.getByRole("form", { name: "New workspace" });
  await orgForm.getByRole("textbox", { name: "Workspace name" }).fill("Acme");
  await expect(orgForm.getByRole("textbox", { name: "Workspace id" })).toHaveValue("acme");
  await orgForm.getByRole("button", { name: "Create workspace" }).click();
  await expect(orgForm).toBeHidden();
  await expect(form.getByRole("combobox", { name: "Belongs to" })).toHaveValue("acme");

  await addClaudeLogin(page, "claude-acme-1");
  await page.getByRole("button", { name: "Add another account" }).click();
  await addClaudeLogin(page, "claude-acme-2", "Acme");

  // Agent 1, through "Create an agent on this account": the form opens in Acme with that account chosen.
  await page.getByRole("link", { name: "Create an agent on this account" }).click();
  const newAgent = page.getByRole("form", { name: "New agent" });
  await expect(newAgent.getByRole("heading", { name: "New agent in Acme" })).toBeVisible();
  await expect(newAgent.getByRole("combobox", { name: "Account" })).toHaveValue("claude-acme-2");
  await newAgent.getByRole("textbox", { name: "Agent id" }).fill("acme-builder");
  await newAgent.getByRole("button", { name: "Builder", exact: true }).click();
  await newAgent.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("heading", { name: "@acme-builder" })).toBeVisible();
  await openHealthCheck(page, "Health check: @acme-builder");

  // Agents 2 and 3, from the list's "New agent" button.
  const agentList = page.getByRole("navigation", { name: "Agents" });
  for (const [id, role, account] of [
    ["acme-lead", "Lead", "claude-acme-1"],
    ["acme-reviewer", "Reviewer", "claude-acme-1"],
  ] as const) {
    await agentList.getByRole("button", { name: "New agent in Acme" }).click();
    await expect(newAgent).toBeVisible();
    await newAgent.getByRole("textbox", { name: "Agent id" }).fill(id);
    await newAgent.getByRole("button", { name: role, exact: true }).click();
    await newAgent.getByRole("combobox", { name: "Account" }).selectOption(account);
    await newAgent.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByRole("heading", { name: `@${id}` })).toBeVisible();
    await openHealthCheck(page, `Health check: @${id}`);
  }

  await expect(agentList.getByRole("button", { name: /^@acme-/ })).toHaveCount(3);
  await expect(agentList.getByRole("region", { name: "Acme", exact: true })).toContainText("3");
  expect(readAgent("acme-lead")).toContain("account: claude-acme-1");
  expect(readAgent("acme-builder")).toContain("account: claude-acme-2");
  await shot(page, "agents-editor");
});

test("an API-key account passes its health check and the key is never stored in the clear or sent back", async ({
  page,
}) => {
  const traffic = recordTraffic(page);
  await openAccountsPage(page);
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

  // The account list and the health check ran again after the key was sent; none of it echoes the key.
  await row.getByRole("button", { name: "codex-key", exact: true }).click();
  await page.getByRole("button", { name: "Health check codex-key" }).click();
  await expect(
    page.getByRole("dialog", { name: "Health check: codex-key" }).getByText("Health check passed"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("region", { name: "Account details" })).toContainText(
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
