import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, MAJHI_HOME, test, useHome } from "./fixture.ts";

// What phase1.spec.ts sets up through the UI, seeded: org Acme, its accounts and agents, and the boss.
useHome({ seed: "team" });

const AGENTS_DIR = join(MAJHI_HOME, "agents");

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });
const agentFile = (id: string) => join(AGENTS_DIR, `${id}.md`);
const readAgent = (id: string) => readFileSync(agentFile(id), "utf8");

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

test("Accounts show who uses them, and a file with a missing account appears without a reload", async ({
  page,
}) => {
  await openAccountsPage(page);

  // Usage is read in the background after each sign-in, without spending tokens.
  await expect(accountRow(page, "claude-acme-1")).toContainText("42%");
  await expect(accountRow(page, "claude-acme-1")).toContainText("18%");
  await expect(accountRow(page, "codex-key")).toContainText("API key");

  // The boss shows in its account's details, with a link to its editor.
  await accountRow(page, "claude-personal")
    .getByRole("button", { name: "claude-personal", exact: true })
    .click();
  const details = page.getByRole("region", { name: "Account details" });
  const root = details.getByRole("region", { name: "Used by, Root" });
  await expect(root.getByRole("link")).toHaveCount(1);
  await expect(root).toContainText("Boss");

  // Details group agents by scope.
  await accountRow(page, "claude-acme-1").getByRole("button", { name: "claude-acme-1", exact: true }).click();
  const acme = details.getByRole("region", { name: "Used by, Acme" });
  await expect(acme.getByRole("listitem")).toHaveCount(2);
  await expect(acme).toContainText("@acme-lead");
  await expect(acme).toContainText("@acme-reviewer");
  await expect(details).toContainText("2 agents");
  await expect(details).toContainText("max plan");
  await expect(details).toContainText("5 hours");
  await expect(details).toContainText("42%");
  await expect(details).toContainText("Week, Opus");
  await details.getByRole("button", { name: "Refresh" }).click();
  await expect(details).toContainText("Read just now");
  await shot(page, "health-accounts");

  // Health and usage keeps the checks and the usage overview, and points to Accounts to manage them.
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Health and usage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage accounts" })).toHaveAttribute("href", /\/accounts/);
  // "Run health check" checks every account and the page says so.
  await page.getByRole("button", { name: "Run health check" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Health check finished" })).toHaveCount(1);
  await expect(page.getByText(/Checked just now/)).toBeVisible();
  await page.getByRole("link", { name: "Manage accounts" }).click();
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();

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
  const section = page.getByRole("region", { name: "Model and effort" });
  const model = section.getByRole("combobox", { name: "Model", exact: true });
  const effort = section.getByRole("combobox", { name: "Effort", exact: true });
  // Auto and Account default are always there; the account's own models follow once they load.
  await expect(model.locator("option")).not.toHaveCount(2);

  await model.selectOption("fake-model-c");
  await effort.selectOption("high");
  await section.getByRole("button", { name: "Save Model and effort" }).click();
  await expect(section.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect.poll(() => readAgent("acme-lead")).toMatch(/^model: fake-model-c$/m);
  expect(readAgent("acme-lead")).toMatch(/^effort: high$/m);

  // Reload: what was saved is what comes back.
  await page.reload();
  await expect(model).toHaveValue("fake-model-c");

  // A hand edit shows in the open editor.
  writeFileSync(
    agentFile("acme-lead"),
    readAgent("acme-lead")
      .replace(/^model: .*$/m, "model: fake-model-b")
      .replace(/^effort: .*$/m, "effort: low")
      .concat("\nEdited by hand.\n"),
  );
  await expect(model).toHaveValue("fake-model-b");
  await expect(effort).toHaveValue("low");
  await expect(page.getByRole("textbox", { name: "Instructions" })).toHaveValue(/Edited by hand\./);
});

test("permissions are switches: reading code is always allowed, the rest toggle and save to the file", async ({
  page,
}) => {
  await page.goto("/agents?agent=acme-reviewer");
  await expect(page.getByRole("heading", { name: "@acme-reviewer" })).toBeVisible();
  const section = page.getByRole("region", { name: "Permissions" });
  await expect(section.getByText("Reading code is always allowed.")).toBeVisible();
  const push = section.getByRole("switch", { name: "Push branches" });
  const save = section.getByRole("button", { name: "Save Permissions" });
  await expect(push).toHaveAttribute("aria-checked", "false");
  await push.click();
  await expect(push).toHaveAttribute("aria-checked", "true");
  await save.click();
  await expect.poll(() => readAgent("acme-reviewer")).toMatch(/^perms: \[.*push.*\]/m);
  // Saved shows once the editor has the new file, so the next change is a change again.
  await expect(section.getByRole("status")).toHaveText("Saved");
  await push.click();
  await save.click();
  await expect.poll(() => readAgent("acme-reviewer")).not.toMatch(/^perms: \[.*push.*\]/m);
});

test("removing an account that agents use is refused, and so is removing the boss", async ({
  page,
  request,
}) => {
  await openAccountsPage(page);
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
