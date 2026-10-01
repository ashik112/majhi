import { expect, test, useHome } from "./fixture.ts";

// It asks questions and reads the answer. No Laya is installed in the fixture, so the chain skips it
// and the rules answer, which is what this checks.
useHome({ seed: "roots" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("majhi.setup.skipped", "1"));
});

test("Hub setup: the Decisions section shows the providers and answers a question", async ({ page }) => {
  await page.goto("/setup?section=decisions");
  const section = page.getByRole("region", { name: "Decisions" });
  await expect(section).toBeVisible();
  const order = section.getByRole("list", { name: "Provider order" });
  await expect(order.getByRole("listitem")).toHaveCount(3);
  await expect(order.getByRole("listitem").first()).toContainText("Laya");
  await expect(order.getByRole("listitem").last()).toContainText("Rules");

  const ask = section.getByRole("form", { name: "Ask the decision model" });
  await ask.getByLabel("Text").fill("Rename the button label on the login page");
  await ask.getByLabel("Question").fill("Which model fits?");
  await ask.getByLabel("Options, separated by commas").fill("haiku, sonnet, opus");
  await ask.getByRole("button", { name: "Ask" }).click();
  await expect(ask.getByRole("status")).toContainText("haiku, confidence 0.30, Rules");

  await expect(section.getByRole("list", { name: "Recent decisions" })).toContainText("pick=haiku");
  await expect(section.getByLabel("Jev API key")).toHaveAttribute("type", "password");
});
