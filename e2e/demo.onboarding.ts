import { expect, type Page, test } from "@playwright/test";
import {
  type CloneJob,
  gitAppSetup,
  type OnboardingStatus,
  type OnboardingStepId,
  type RemoteRepo,
  type SignInStatus,
} from "../packages/shared/src/index.ts";

/**
 * The onboarding journey: the river scene and every step, in both themes at 1440x900 and 1100x700,
 * plus the states of git sign-in, remote repos, cloning and a new project. The server is the seeded
 * one (`ui`); the onboarding and git connect commands are stubbed in the browser, since the server
 * answers them 501 until they are built.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.onboarding.config.ts`.
 */
const SHOTS = "/private/tmp/claude-501/onb-demo";
const HOME = "/Users/owner";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const ORDER: OnboardingStepId[] = ["welcome", "account", "workspaces", "git", "projects", "boss", "finish"];

type Git = OnboardingStatus["workspaces"][number]["git"];

interface Scene {
  done: OnboardingStepId[];
  roots: string[];
  /** Git hosts per workspace id. */
  git: Record<string, Git>;
  projects: Record<string, number>;
}

function status(scene: Scene): OnboardingStatus {
  const steps = ORDER.map((id) => ({ id, done: scene.done.includes(id) }));
  return {
    steps,
    next: steps.find((s) => !s.done)?.id ?? null,
    roots: scene.roots,
    hostHelper: true,
    workspaces: [
      { id: "private", name: "Private", git: scene.git.private ?? [], projects: scene.projects.private ?? 0 },
      {
        id: "acme",
        name: "Acme",
        color: "#f0b455",
        git: scene.git.acme ?? [],
        projects: scene.projects.acme ?? 0,
      },
      {
        id: "globex",
        name: "Globex",
        color: "#8ab8f5",
        git: scene.git.globex ?? [],
        projects: scene.projects.globex ?? 0,
      },
    ],
  };
}

const ACME_GITHUB: Git = [{ kind: "github", host: "github.com", account: "acme-dev", signedIn: true }];
const GLOBEX_GITLAB: Git = [{ kind: "gitlab", host: "gitlab.com", account: "globex-ops", signedIn: true }];

function upTo(id: OnboardingStepId): OnboardingStepId[] {
  return ORDER.slice(0, ORDER.indexOf(id));
}

const SCENES: Record<OnboardingStepId, Scene> = {
  welcome: { done: [], roots: [], git: {}, projects: {} },
  account: { done: upTo("account"), roots: [`${HOME}/Work`], git: {}, projects: {} },
  workspaces: { done: upTo("workspaces"), roots: [`${HOME}/Work`], git: {}, projects: {} },
  git: { done: upTo("git"), roots: [`${HOME}/Work`], git: { acme: ACME_GITHUB }, projects: {} },
  projects: {
    done: upTo("projects"),
    roots: [`${HOME}/Work`],
    git: { acme: ACME_GITHUB, globex: GLOBEX_GITLAB },
    projects: {},
  },
  boss: {
    done: ["welcome", "account", "workspaces", "git", "projects"],
    roots: [`${HOME}/Work`],
    git: { acme: ACME_GITHUB, globex: GLOBEX_GITLAB },
    projects: { acme: 2 },
  },
  finish: {
    done: ["welcome", "account", "workspaces", "git", "boss", "finish"],
    roots: [`${HOME}/Work`],
    git: { acme: ACME_GITHUB, globex: GLOBEX_GITLAB },
    projects: {},
  },
};

function repo(owner: string, name: string, extra: Partial<RemoteRepo> = {}): RemoteRepo {
  return {
    fullName: `${owner}/${name}`,
    name,
    owner,
    private: true,
    defaultBranch: "main",
    updatedAt: iso(60 * 5),
    archived: false,
    webUrl: `https://github.com/${owner}/${name}`,
    httpsUrl: `https://github.com/${owner}/${name}.git`,
    here: { state: "none" },
    ...extra,
  };
}

const REPOS: RemoteRepo[] = [
  repo("acme", "billing-api", { description: "Invoices, payment runs and the ledger", updatedAt: iso(40) }),
  repo("acme", "storefront", { description: "The customer web shop", updatedAt: iso(180) }),
  repo("acme", "mobile-app", { description: "iOS and Android app", updatedAt: iso(60 * 26) }),
  repo("acme", "infra", {
    description: "Terraform for every environment",
    here: { state: "registered", project: "acme-infra", org: "acme", path: `${HOME}/Work/acme/infra` },
  }),
  repo("acme-dev", "dotfiles", { private: false, updatedAt: iso(60 * 24 * 9) }),
  repo("acme", "design-tokens", { description: "Colors, type and spacing", updatedAt: iso(60 * 24 * 3) }),
  repo("acme", "data-pipeline", {
    description: "Nightly exports to the warehouse",
    updatedAt: iso(60 * 24 * 12),
  }),
  repo("acme", "new-service", {
    description: "Nothing pushed yet",
    defaultBranch: undefined,
    updatedAt: iso(60 * 24 * 20),
  }),
];

const job = (fullName: string, rest: Partial<CloneJob> & Pick<CloneJob, "state">): CloneJob =>
  ({
    clone: `cl_${fullName
      .replace(/[^a-z]/g, "")
      .padEnd(12, "x")
      .slice(0, 12)}`,
    org: "globex",
    kind: "github",
    host: "github.com",
    fullName,
    path: `${HOME}/Work/globex/${fullName.split("/")[1]}`,
    project: fullName.split("/")[1] ?? "x",
    startedAt: iso(1),
    ...rest,
  }) as CloneJob;

const MIXED_JOBS: CloneJob[] = [
  job("acme/billing-api", { state: "cloning", phase: "receiving", percent: 62 }),
  job("acme/storefront", { state: "queued" }),
  job("acme/mobile-app", { state: "cloning", phase: "resolving", percent: 88 }),
  job("acme/design-tokens", { state: "done", endedAt: iso(0), base: "main" }),
  job("acme/data-pipeline", {
    state: "failed",
    endedAt: iso(0),
    reason: "The folder ~/Work/acme/data-pipeline already has files in it.",
  }),
];

interface Stubs {
  scene: Scene;
  accounts?: unknown[];
  agents?: unknown[];
  signIn?: "device" | "needs-app" | "fail";
  poll?: SignInStatus;
  jobs?: CloneJob[];
  remote?: "ok" | "refused";
  publishFails?: boolean;
}

const SIGN_IN = "si_AcmeExample0001";
const pending: SignInStatus = {
  state: "pending",
  signIn: SIGN_IN,
  org: "globex",
  kind: "github",
  host: "github.com",
  expiresAt: later(14),
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
};

async function stub(page: Page, s: Stubs) {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/cmd/onboarding.status", (r) => r.fulfill(json(status(s.scene))));
  await page.route("**/api/cmd/fs.suggestRoots", (r) =>
    r.fulfill(
      json({
        suggestions: [
          { path: `${HOME}/Work`, repoCount: 6 },
          { path: `${HOME}/Projects`, repoCount: 2 },
        ],
      }),
    ),
  );
  await page.route("**/api/cmd/config.get", async (r) => {
    const res = await r.fetch();
    const body = (await res.json()) as { status: string; config?: { workspaces: string[] } };
    const roots = s.scene.roots;
    r.fulfill(
      json({
        ...body,
        home: HOME,
        file: `${HOME}/.majhi/majhi.yaml`,
        ...(body.config
          ? { config: { ...body.config, workspaces: roots.length > 0 ? roots : body.config.workspaces } }
          : {}),
      }),
    );
  });
  await page.route("**/api/cmd/workspaces.set", (r) => {
    s.scene = { ...s.scene, roots: [`${HOME}/Work`], done: [...s.scene.done, "welcome"] };
    return r.fulfill(
      json({
        state: {
          status: "loaded",
          file: `${HOME}/.majhi/majhi.yaml`,
          home: HOME,
          config: { workspaces: s.scene.roots, tasksDir: `${HOME}/Work/.majhi` },
        },
        unmounted: [],
        remount: "not-needed",
        restartCommand: "make up",
      }),
    );
  });
  if (s.accounts) await page.route("**/api/cmd/accounts.list", (r) => r.fulfill(json(s.accounts)));
  if (s.agents) await page.route("**/api/cmd/agents.list", (r) => r.fulfill(json(s.agents)));
  await page.route("**/api/cmd/accounts.models", (r) =>
    r.fulfill(
      json({
        account: "claude-personal",
        models: [
          { id: "opus-5.5", name: "Opus 5.5" },
          { id: "sonnet-5", name: "Sonnet 5" },
          { id: "haiku-5", name: "Haiku 5" },
        ],
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
        defaultModel: "opus-5.5",
        defaultEffort: "high",
        fetchedAt: iso(1),
      }),
    ),
  );
  await page.route("**/api/cmd/git.logins", (r) =>
    r.fulfill(
      json({
        hosts: [
          {
            host: "github.com",
            logins: [
              { via: "gh", account: "acme-dev" },
              { via: "ssh", account: "globex-bot", alias: "github-globex" },
            ],
          },
        ],
      }),
    ),
  );
  await page.route("**/api/cmd/git.signIn.start", (r) => {
    if (s.signIn === "fail")
      return r.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "GitHub did not answer. Check the connection and try again." }),
      });
    if (s.signIn === "needs-app") {
      return r.fulfill(
        json({
          state: "needs-app",
          kind: "github",
          host: "github.com",
          setup: gitAppSetup("github", "github.com", "http://127.0.0.1:7070"),
        }),
      );
    }
    return r.fulfill(
      json({
        state: "device",
        signIn: SIGN_IN,
        kind: "github",
        host: "github.com",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresAt: later(14),
        opened: true,
      }),
    );
  });
  await page.route("**/api/cmd/git.signIn.poll", (r) => r.fulfill(json(s.poll ?? pending)));
  await page.route("**/api/cmd/git.signIn.cancel", (r) =>
    r.fulfill(json({ ...pending, state: "cancelled" })),
  );
  await page.route("**/api/cmd/git.signIn.confirm", (r) => r.fulfill(json(s.poll ?? pending)));
  await page.route("**/api/cmd/git.signOut", (r) =>
    r.fulfill(
      json({
        org: "acme",
        kind: "github",
        host: "github.com",
        account: "acme-dev",
        removed: true,
        revoke: "local",
        revokeUrl: "https://github.com/settings/applications",
      }),
    ),
  );
  await page.route("**/api/cmd/git.remoteRepos", async (r) => {
    const input = r.request().postDataJSON() as { query?: string; page: number; kind: "github" };
    if (s.remote === "refused")
      return r.fulfill(json({ state: "refused", kind: input.kind, host: "github.com", account: "acme-dev" }));
    const q = (input.query ?? "").toLowerCase();
    const hits = REPOS.filter((x) => x.fullName.includes(q));
    return r.fulfill(
      json({ state: "ok", account: "acme-dev", repos: hits, page: 1, ...(q ? {} : { nextPage: 2 }) }),
    );
  });
  await page.route("**/api/cmd/projects.cloneStatus", (r) => r.fulfill(json({ jobs: s.jobs ?? [] })));
  await page.route("**/api/cmd/projects.clone", (r) => {
    const input = r.request().postDataJSON() as { fullName: string };
    if (input.fullName === "acme/new-service") {
      return r.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            "acme/new-service is empty, so there is nothing to clone. Make a new project, then connect it to this repo.",
        }),
      });
    }
    return r.fulfill(json({ clone: "cl_AcmeExample0001", path: `${HOME}/Work/acme/x`, project: "x" }));
  });
  await page.route("**/api/cmd/repos.scan", (r) =>
    r.fulfill(
      json({
        scannedAt: iso(0),
        durationMs: 120,
        roots: [
          {
            path: `${HOME}/Work`,
            mounted: true,
            repos: [
              {
                name: "billing-api",
                path: `${HOME}/Work/billing-api`,
                relPath: "billing-api",
                branch: "main",
                registered: false,
                remotes: [{ name: "origin", url: "git@github.com:acme/billing-api.git", host: "github" }],
              },
              {
                name: "storefront",
                path: `${HOME}/Work/storefront`,
                relPath: "storefront",
                branch: "develop",
                registered: false,
                remotes: [
                  { name: "origin", url: "https://gitlab.com/globex/storefront.git", host: "gitlab" },
                ],
              },
              {
                name: "notes",
                path: `${HOME}/Work/notes`,
                relPath: "notes",
                branch: "main",
                registered: false,
                remotes: [],
              },
              {
                name: "infra",
                path: `${HOME}/Work/infra`,
                relPath: "infra",
                branch: "main",
                registered: true,
                remotes: [
                  { name: "origin", url: "git@bitbucket.org:northwind/infra.git", host: "bitbucket" },
                ],
              },
            ],
          },
        ],
      }),
    ),
  );
  const project = {
    id: "invoice-parser",
    org: "acme",
    path: `${HOME}/Work/acme/invoice-parser`,
    aliases: [],
    base: "main",
    exists: true,
    remotes: {},
    links: [],
    protected: false,
  };
  await page.route("**/api/cmd/projects.create", (r) => r.fulfill(json({ project, commit: "4f1c2ab" })));
  await page.route("**/api/cmd/projects.publish", (r) =>
    s.publishFails
      ? r.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "acme/new-api already exists on GitHub." }),
        })
      : r.fulfill(
          json({
            project,
            remote: {
              name: "origin",
              url: "git@github.com:acme-dev/new-api.git",
              fullName: "acme-dev/new-api",
              webUrl: "https://github.com/acme-dev/new-api",
            },
            pushed: "main",
          }),
        ),
  );
}

async function open(
  page: Page,
  at: OnboardingStepId,
  theme: "dark" | "light",
  s: Stubs,
  size = { width: 1440, height: 900 },
) {
  await page.setViewportSize(size);
  await page.addInitScript(
    ({ at, theme }) => {
      // Once per tab, so a reload keeps the place the journey saved.
      if (window.sessionStorage.getItem("seeded")) return;
      window.sessionStorage.setItem("seeded", "1");
      window.localStorage.setItem("majhi.onboarding.at", at);
      window.localStorage.setItem("majhi.appearance", JSON.stringify({ theme, accent: "amber" }));
    },
    { at, theme },
  );
  await stub(page, s);
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Setup progress" })).toBeVisible();
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

/** Moves the mouse onto `target` the way a person would, pauses, then clicks it. */
async function press(page: Page, target: ReturnType<Page["locator"]>, pause = 700) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await page.waitForTimeout(pause);
  await target.click();
}

async function typeSlowly(target: ReturnType<Page["locator"]>, text: string) {
  await target.click();
  await target.pressSequentially(text, { delay: 70 });
}

const done = (alsoUsedBy: string[] = []): SignInStatus => ({
  state: "done",
  signIn: SIGN_IN,
  org: "globex",
  kind: "github",
  host: "github.com",
  account: "globex-dev",
  alsoUsedBy,
});

async function startGitHub(page: Page) {
  const globex = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /^Globex/ }) });
  if (!(await globex.getByRole("button", { name: "Sign in with GitHub" }).isVisible()))
    await globex.getByRole("button", { name: /^Globex/ }).click();
  await press(page, globex.getByRole("button", { name: "Sign in with GitHub" }), 900);
}

const THEME = (process.env.DEMO_THEME ?? "dark") as "dark" | "light";

test(`demo: the whole journey (${THEME})`, async ({ page }) => {
  test.setTimeout(240_000);
  const s: Stubs = { scene: structuredClone(SCENES.welcome), signIn: "device" };
  // The live event feed, passed through, so the demo can say "this changed" for stubbed actions
  // the way the server would after a real sign-in, clone or new project.
  let feed: { send: (m: string) => void } | undefined;
  await page.routeWebSocket(/\/api\/events/, (ws) => {
    ws.connectToServer();
    feed = ws;
  });
  const changed = () => feed?.send(JSON.stringify({ type: "changed", topics: ["config"] }));
  const finish = (id: OnboardingStepId) => {
    if (!s.scene.done.includes(id)) s.scene.done = [...s.scene.done, id];
    changed();
  };
  await open(page, "welcome", THEME, s);
  const heading = page.locator("#journey-heading");
  const next = () => page.getByRole("button", { name: "Continue", exact: true }).last();
  await page.waitForTimeout(2500);

  // Welcome: the suggested folder.
  await press(page, page.getByRole("button", { name: "Use ~/Work" }), 1200);
  await expect(heading).toHaveText("Sign in to Claude Code or Codex");
  await page.waitForTimeout(3600);

  // AI account: already signed in on this seeded install.
  finish("account");
  if (await next().isVisible()) await press(page, next(), 1500);
  else await press(page, page.getByRole("button", { name: "Skip for now" }), 1500);
  await expect(heading).toHaveText("Keep each client's work apart");
  await page.waitForTimeout(3600);

  // Workspaces: Acme and Globex are there.
  finish("workspaces");
  await press(page, next(), 1500);
  await expect(heading).toHaveText("Sign each workspace in to git");
  await page.waitForTimeout(3400);

  // Git: sign Globex in to GitHub with a device code.
  await startGitHub(page);
  await expect(page.getByLabel("Sign-in code")).toHaveText("WDJB-MJHT");
  await page.waitForTimeout(3500);
  s.poll = done();
  await expect(page.getByText(/Works as @globex-dev on GitHub/)).toBeVisible();
  s.scene.git = {
    ...s.scene.git,
    globex: [{ kind: "github", host: "github.com", account: "globex-dev", signedIn: true }],
  };
  finish("git");
  await page.waitForTimeout(2600);
  await press(page, next(), 1200);
  await expect(heading).toHaveText("Add the projects agents can work on");
  await page.waitForTimeout(3400);

  // Projects: clone two repos from GitHub, with live progress.
  await press(page, page.getByRole("button", { name: "From GitHub, GitLab or Bitbucket" }));
  await page.waitForTimeout(1800);
  await typeSlowly(page.getByRole("searchbox"), "api");
  await page.waitForTimeout(1200);
  await page.getByRole("searchbox").fill("");
  await page.waitForTimeout(1200);
  await press(page, page.getByRole("checkbox", { name: "Clone acme/billing-api" }), 500);
  await press(page, page.getByRole("checkbox", { name: "Clone acme/storefront" }), 500);
  await page.waitForTimeout(800);
  await press(page, page.getByRole("button", { name: "Clone 2 repos" }), 900);
  const steps: [CloneJob[], number][] = [
    [[job("acme/billing-api", { state: "queued" }), job("acme/storefront", { state: "queued" })], 900],
    [
      [
        job("acme/billing-api", { state: "cloning", phase: "receiving", percent: 18 }),
        job("acme/storefront", { state: "queued" }),
      ],
      900,
    ],
    [
      [
        job("acme/billing-api", { state: "cloning", phase: "receiving", percent: 57 }),
        job("acme/storefront", { state: "cloning", phase: "receiving", percent: 12 }),
      ],
      900,
    ],
    [
      [
        job("acme/billing-api", { state: "cloning", phase: "resolving", percent: 91 }),
        job("acme/storefront", { state: "cloning", phase: "receiving", percent: 64 }),
      ],
      900,
    ],
    [
      [
        job("acme/billing-api", { state: "done", endedAt: iso(0), base: "main" }),
        job("acme/storefront", { state: "cloning", phase: "resolving", percent: 93 }),
      ],
      900,
    ],
    [
      [
        job("acme/billing-api", { state: "done", endedAt: iso(0), base: "main" }),
        job("acme/storefront", { state: "done", endedAt: iso(0), base: "main" }),
      ],
      2400,
    ],
  ];
  for (const [jobs, wait] of steps) {
    s.jobs = jobs;
    feed?.send(JSON.stringify({ type: "changed", topics: ["clones"] }));
    await page.waitForTimeout(wait);
  }

  // And a brand new project.
  await press(page, page.getByRole("button", { name: "New project" }));
  const form = page.getByRole("form", { name: "New project" });
  await typeSlowly(form.getByRole("textbox", { name: "Name" }), "invoice-parser");
  await form.getByRole("combobox", { name: "Workspace" }).selectOption("acme");
  await page.waitForTimeout(500);
  await typeSlowly(form.getByRole("textbox", { name: "Description" }), "Reads supplier PDFs into the ledger");
  await page.waitForTimeout(1500);
  s.scene.projects = { acme: 3 };
  finish("projects");
  await press(page, form.getByRole("button", { name: /^Create/ }), 900);
  await page.waitForTimeout(2600);
  await press(page, next(), 1200);
  await expect(heading).toHaveText("Choose the captain");
  await page.waitForTimeout(3600);

  // Captain.
  finish("boss");
  if (await next().isVisible()) await press(page, next(), 1800);
  else await press(page, page.getByRole("button", { name: "Skip for now" }), 1800);

  // Arrive: the boat reaches the ghat and the lamps light.
  await expect(heading).toHaveText("You have arrived");
  finish("finish");
  await page.waitForTimeout(6500);
  await press(page, page.getByRole("button", { name: "Write the first task" }), 1200);
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(900);
  await page.keyboard.type("Add CSV export to the billing API, from develop", { delay: 55 });
  await page.waitForTimeout(3000);
});
