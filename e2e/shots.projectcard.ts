import { expect, type Page, test } from "@playwright/test";
import type { ProjectCard } from "../packages/shared/src/index.ts";

/**
 * The knowledge card on the Projects page: what the repo is, readiness with its checklist, stack,
 * commands, structure, conventions, CI and remotes. The server is the seeded one (`ui`); the card is
 * stubbed in the browser, with long values.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.projectcard.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/projectcard-shots";

function card(project: string, org: string, over: Partial<ProjectCard> = {}): ProjectCard {
  return {
    project,
    org,
    commit: "a1b2c3d4e5f6",
    base: "develop",
    refreshedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    whatItIs:
      "The Globex orders API: accepts storefront checkouts, reserves stock and hands paid orders to the fulfilment service. TypeScript on Fastify with a Postgres schema managed by migrations.",
    whatItIsBy: "model",
    stack: [
      "TypeScript 5.4.0",
      "Node 20",
      "pnpm 9.1.0",
      "Fastify 4.26.0",
      "Vitest 1.6.0",
      "Prisma 5.12.0",
      "monorepo (workspaces)",
    ],
    commands: {
      install: "pnpm install",
      run: "pnpm run dev",
      build: "pnpm run build",
      test: "pnpm run test",
      lint: "pnpm run lint --max-warnings=0 --report-unused-disable-directives-severity=error",
      typecheck: "pnpm run typecheck",
    },
    structure: [
      { path: "apps/", note: "Apps" },
      {
        path: "apps/orders-service-with-a-long-name/",
        note: "Orders, checkout and stock reservation for every storefront channel",
      },
      { path: "packages/", note: "Shared packages" },
      { path: "packages/shared/", note: "Schemas shared by the apps" },
      { path: "docs/", note: "Documentation" },
      { path: ".github/", note: "GitHub settings and workflows" },
    ],
    conventions: [
      "Keep modules small and typed; no any without a comment explaining why.",
      "Tests only for crucial logic: money, auth, data loss.",
      "TypeScript strict mode",
      "Linted with ESLint",
    ],
    ci: { provider: "GitHub Actions", workflows: ["ci.yml", "release.yml"] },
    deploy: ["Docker image (Dockerfile)", "Fly.io (fly.toml)"],
    remotes: [
      {
        name: "origin",
        url: "https://host.example.com/globex/orders-api-with-a-very-long-repository-name.git",
      },
    ],
    aliases: ["orders"],
    readiness: {
      score: 3,
      max: 5,
      items: [
        { id: "base", label: "Known base branch", ok: true, detail: "Merges go into develop." },
        { id: "test", label: "Test command", ok: true, detail: "`pnpm run test`" },
        {
          id: "checks",
          label: "Lint or typecheck",
          ok: true,
          detail: "`pnpm run lint`, `pnpm run typecheck`",
        },
        { id: "ci", label: "CI", ok: true, detail: "GitHub Actions, 2 workflow file(s)." },
        {
          id: "docs",
          label: "Agent docs",
          ok: false,
          detail: "No CLAUDE.md or AGENTS.md.",
          fix: "Write an AGENTS.md with the run, test and lint commands and the repo's rules.",
        },
        {
          id: "worktree",
          label: "Builds in a fresh worktree",
          ok: false,
          detail: "A fresh worktree needs submodules and an env file copied from .env.example by hand.",
          fix: "Make setup automatic: document the steps in the install script so a new worktree needs none.",
        },
      ],
    },
    ...over,
  };
}

async function open(page: Page, w: number, h: number, theme: string, cards: ProjectCard[]) {
  await page.setViewportSize({ width: w, height: h });
  await page.route("**/api/cmd/projects.cards", (r) => r.fulfill({ json: cards }));
  await page.route("**/api/cmd/projects.cardRefresh", (r) => r.fulfill({ json: cards[0] }));
  await page.goto("/projects?project=alpha-api");
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(700);
}

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`card ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme, [card("alpha-api", "globex")]);
      await expect(page.getByRole("region", { name: "Knowledge card" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Readiness checklist" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/card-${w}-${theme}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBe(0);
    });
  }
}

test("empty card and refresh", async ({ page }) => {
  await open(page, 1440, 900, "dark", []);
  await expect(page.getByText("No card yet.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/card-empty-1440-dark.png` });
  await page.getByRole("button", { name: "Refresh the card of alpha-api" }).click();
});
