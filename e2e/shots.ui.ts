import { expect, type Page, test } from "@playwright/test";

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/ui-${name}.png` });

test("agents", async ({ page }) => {
  await page.goto("/agents?agent=globex-builder");
  await expect(page.getByRole("heading", { name: "@globex-builder" })).toBeVisible();
  await page.waitForTimeout(700);
  await shot(page, "agents");
});

test("health", async ({ page }) => {
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Health and usage" })).toBeVisible();
  await page.waitForTimeout(900);
  await shot(page, "health");
});

test("orgs", async ({ page }) => {
  await page.goto("/orgs");
  await expect(page.getByRole("heading", { name: "Orgs and accounts" })).toBeVisible();
  await page.waitForTimeout(700);
  await shot(page, "orgs");
});

test("projects", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects and links" })).toBeVisible();
  await page.waitForTimeout(700);
  await shot(page, "projects");
});

test("setup", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Hub setup" })).toBeVisible();
  await page.waitForTimeout(700);
  await shot(page, "setup");
});

test("skills", async ({ page }) => {
  await page.goto("/skills");
  await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, "skills");
});

test("agents: errors, new agent", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("tab", { name: /Files with errors/ }).click();
  await expect(page.getByText("This file has errors and did not load.")).toBeVisible();
  await shot(page, "agents-errors");
  await page.getByRole("tab", { name: /^Acme/ }).click();
  await page.getByRole("button", { name: "New agent in Acme" }).click();
  await expect(page.getByRole("form", { name: "New agent" })).toBeVisible();
  await shot(page, "agents-new");
});

test("health: account drawer and add account", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /^Health and usage/ }).click();
  await page.getByRole("button", { name: "claude-northwind" }).click();
  await expect(page.getByRole("complementary", { name: "Account details" })).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, "health-details");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("complementary", { name: "Add an account" })).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, "health-add");
});

test("orgs: edit in place", async ({ page }) => {
  await page.goto("/orgs");
  await page.getByRole("button", { name: "Edit Acme" }).click();
  await expect(page.getByRole("form", { name: "Edit Acme" })).toBeVisible();
  await shot(page, "orgs-edit");
});

test("projects: register", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "Register delta-app" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "projects-register");
});
