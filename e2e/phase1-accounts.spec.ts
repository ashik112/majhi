import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, MAJHI_HOME, test, useHome } from "./fixture.ts";

// What phase1.spec.ts sets up through the UI, seeded: org Acme, its accounts and agents, and the captain.
useHome({ seed: "team" });

const AGENTS_DIR = join(MAJHI_HOME, "agents");

const _shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });
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

test("removing an account that agents use is refused, and so is removing the captain", async ({
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

  // The captain's account is in use too.
  await accountRow(page, "claude-personal")
    .getByRole("button", { name: "claude-personal", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove claude-personal" }).click();
  await page.getByRole("button", { name: "Remove account" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Agents still use claude-personal" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // The editor blocks removing the captain, and the server refuses it too.
  const bossId = readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8").match(/^boss: (\S+)/m)?.[1];
  expect(bossId).toBeTruthy();
  await page.goto(`/agents?agent=${bossId}`);
  await page.getByRole("button", { name: "Agent actions" }).click();
  const remove = page.getByRole("menuitem", { name: /^Remove/ });
  await expect(remove).toBeDisabled();
  await expect(remove).toContainText("the captain cannot be removed");
  const res = await request.post("/api/cmd/agents.remove", { data: { id: bossId } });
  expect(res.ok()).toBe(false);
  expect(await res.text()).toContain("is the captain");
  expect(readAgent(bossId as string)).toContain(`id: ${bossId}`);
});
