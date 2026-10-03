import { test } from "@playwright/test";
import type { OrgView, TrackerStatus } from "../packages/shared/src/index.ts";

/**
 * The Tracker section of an org, with a Jira tracker, its last pull and two items that wait for a
 * project. The server is the seeded one (`ui`); the tracker and its status are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.trackers.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/tracker-shots";
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const STATUS: TrackerStatus = {
  last: { org: "acme", created: ["ACM-14"], updated: [], seen: 4, at: at(12) },
  unrouted: [
    {
      key: "ACME-231",
      title: "Export invoices as CSV",
      url: "https://acme.atlassian.net/browse/ACME-231",
      why: "No project picked",
    },
    {
      key: "ACME-240",
      title: "Session expires too early on mobile",
      url: "https://acme.atlassian.net/browse/ACME-240",
      why: "No project picked",
    },
  ],
};

test("tracker section", async ({ page }) => {
  await page.route("**/api/cmd/orgs.list", async (r) => {
    const res = await r.fetch();
    const orgs = (await res.json()) as OrgView[];
    const json = orgs.map((o) =>
      o.id === "acme"
        ? {
            ...o,
            tracker: {
              type: "jira",
              site: "acme.atlassian.net",
              email: "owner@acme.example",
              token: "secret:jira-acme",
              project: "ACME",
            },
          }
        : o,
    );
    await r.fulfill({ response: res, json });
  });
  await page.route("**/api/cmd/trackers.status", (r) => r.fulfill({ json: STATUS }));
  await page.goto("/orgs");
  await page.getByText("Acme", { exact: true }).first().click();
  const section = page.getByRole("region", { name: "Tracker" });
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: `${SHOTS}/tracker-section.png` });
  await page.screenshot({ path: `${SHOTS}/tracker-page.png` });
});
