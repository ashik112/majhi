import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, MAJHI_HOME, test, useHome } from "./fixture.ts";

useHome({ seed: "team" });

const FAKE_KEY = "sk-test-fake-0000";
const AGENTS_DIR = join(MAJHI_HOME, "agents");

const agentFile = (id: string) => join(AGENTS_DIR, `${id}.md`);
const _readAgent = (id: string) => readFileSync(agentFile(id), "utf8");

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

/** Types a code into the embedded terminal once the fake Claude login asks for it. */
async function signInThroughTerminal(page: Page) {
  const terminal = page.getByRole("region", { name: "Sign-in terminal" });
  await expect(terminal).toContainText("Paste code here");
  await terminal.click();
  await page.keyboard.type("fake-code");
  await page.keyboard.press("Enter");
}

/** Fills the add-account form for a Claude login account and signs in. */
async function _addClaudeLogin(page: Page, id: string, org?: string) {
  const form = page.getByRole("form", { name: "Add an account" });
  await expect(form.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  if (org) await form.getByRole("combobox", { name: "Belongs to" }).selectOption({ label: org });
  await form.getByRole("textbox", { name: "Account id" }).fill(id);
  await form.getByRole("button", { name: "Add account and sign in" }).click();
  await signInThroughTerminal(page);
  await expect(page.getByRole("status").filter({ hasText: `${id} is signed in and healthy` })).toBeVisible();
}

async function waitForHelper(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const res = await request.post("/api/cmd/host.status", { data: {} });
      return ((await res.json()) as { connected: boolean }).connected;
    })
    .toBe(true);
}

async function openAccountsPage(page: Page) {
  await page.goto("/accounts");
  await expect(page.getByRole("navigation", { name: "Accounts" })).toBeVisible();
}

const accountRow = (page: Page, id: string) =>
  page
    .getByRole("navigation", { name: "Accounts" })
    .getByRole("listitem")
    .filter({
      has: page.getByRole("button", { name: id, exact: true }),
    });

async function _openHealthCheck(page: Page, title: string) {
  await page.getByRole("button", { name: "Health check", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog.getByText("Health check passed")).toBeVisible();
  // The CLI starts, it is signed in, the ACP session opens, and the model is available.
  await expect(dialog.getByRole("list", { name: "Health check steps" }).getByRole("listitem")).toHaveCount(4);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
}

test("an API-key account passes its health check and the key is never stored in the clear or sent back", async ({
  page,
  request,
}) => {
  await waitForHelper(request);
  const traffic = recordTraffic(page);
  await openAccountsPage(page);
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const form = page.getByRole("form", { name: "Add an account" });
  await form.getByRole("radio", { name: "Codex" }).click();
  await form.getByRole("radio", { name: "API key" }).click();
  await form.getByRole("textbox", { name: "Account id" }).fill("codex-extra");
  await form.getByRole("textbox", { name: "OpenAI API key" }).fill(FAKE_KEY);
  await form.getByRole("button", { name: "Add account and check it" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "codex-extra is signed in and healthy" }),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Health check steps" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Close add account" }).click();
  const row = accountRow(page, "codex-extra");
  await expect(row).toContainText("API key");
  await expect(row).toContainText("Healthy");

  // The account list and the health check ran again after the key was sent; none of it echoes the key.
  await row.getByRole("button", { name: "codex-extra", exact: true }).click();
  await page.getByRole("button", { name: "Health check codex-extra" }).click();
  await expect(
    page.getByRole("dialog", { name: "Health check: codex-extra" }).getByText("Health check passed"),
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
  expect(history).toContain("codex-extra");
  expect(history).not.toContain(FAKE_KEY);
});
