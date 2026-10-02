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
const SHOTS = "/private/tmp/claude-501/onb-shots";
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
    org: "acme",
    kind: "github",
    host: "github.com",
    fullName,
    path: `${HOME}/Work/acme/${fullName.split("/")[1]}`,
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
    id: "new-api",
    org: "acme",
    path: `${HOME}/Work/acme/new-api`,
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

const NO_ACCOUNTS: unknown[] = [];

for (const id of ORDER) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1100, height: 700 },
  ]) {
    for (const theme of ["dark", "light"] as const) {
      test(`step ${id} ${size.width} ${theme}`, async ({ page }) => {
        await open(
          page,
          id,
          theme,
          {
            scene: SCENES[id],
            ...(id === "account" ? { accounts: NO_ACCOUNTS } : {}),
            ...(id === "boss" ? { agents: [] } : {}),
          },
          size,
        );
        await expect(page.locator('[aria-current="step"]')).toBeVisible();
        await page.waitForTimeout(id === "finish" ? 3400 : 900);
        await page.screenshot({ path: `${SHOTS}/step-${id}-${size.width}-${theme}.png` });
        await noPageScroll(page);
      });
    }
  }
}

// Key states --------------------------------------------------------------------------------

const done = (alsoUsedBy: string[] = [], account = "globex-dev"): SignInStatus => ({
  state: "done",
  signIn: SIGN_IN,
  org: "globex",
  kind: "github",
  host: "github.com",
  account,
  alsoUsedBy,
});

async function startGitHub(page: Page) {
  const globex = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /^Globex/ }) });
  await globex.getByRole("button", { name: "Sign in with GitHub" }).click();
}

for (const theme of ["dark", "light"] as const) {
  test(`git: device code, then signed in (${theme})`, async ({ page }) => {
    const s: Stubs = { scene: SCENES.git, signIn: "device" };
    await open(page, "git", theme, s);
    await startGitHub(page);
    await expect(page.getByRole("status").filter({ hasText: "Waiting for GitHub" })).toBeVisible();
    await expect(page.getByLabel("Sign-in code")).toHaveText("WDJB-MJHT");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/git-device-waiting-${theme}.png` });
    s.poll = done();
    await expect(page.getByText(/Works as @globex-dev on GitHub/)).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/git-signed-in-${theme}.png` });
  });
}

test("git: the same account in two workspaces asks to confirm", async ({ page }) => {
  const s: Stubs = {
    scene: SCENES.git,
    signIn: "device",
    poll: {
      state: "confirm",
      signIn: SIGN_IN,
      org: "globex",
      kind: "github",
      host: "github.com",
      account: "acme-dev",
      alsoUsedBy: ["acme"],
      expiresAt: later(10),
    },
  };
  await open(page, "git", "dark", s);
  await startGitHub(page);
  await expect(page.getByText(/is already used by Acme/)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/git-reused-confirm.png` });
  s.poll = done(["acme"], "acme-dev");
  await page.getByRole("button", { name: "Use it for Globex too" }).click();
  await expect(page.getByText(/Works as @acme-dev on GitHub/)).toBeVisible();
});

test("git: signing out shows where to finish it at the host", async ({ page }) => {
  await open(page, "git", "dark", { scene: SCENES.git });
  await page.getByRole("button", { name: /^Acme/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: /Remove majhi on GitHub/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/git-signed-out.png` });
});

test("git: the host needs majhi registered once", async ({ page }) => {
  await open(page, "git", "dark", { scene: SCENES.git, signIn: "needs-app" });
  await startGitHub(page);
  await expect(page.getByRole("heading", { name: "Register majhi on GitHub once" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/git-needs-app.png` });
  await page.getByRole("region", { name: "Register majhi on GitHub once" }).scrollIntoViewIfNeeded();
  await page.getByRole("textbox", { name: "Client ID" }).fill("Ov23liAcmeExample01");
  await page.getByRole("textbox", { name: "Client ID" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/git-needs-app-filled.png` });
});

test("git: a failed start says why", async ({ page }) => {
  await open(page, "git", "dark", { scene: SCENES.git, signIn: "fail" });
  await startGitHub(page);
  await expect(page.getByRole("alert")).toContainText("GitHub did not answer");
  await page.screenshot({ path: `${SHOTS}/error-git-start.png` });
});

for (const theme of ["dark", "light"] as const) {
  test(`projects: remote repos with search (${theme})`, async ({ page }) => {
    await open(page, "projects", theme, { scene: SCENES.projects });
    await page.getByRole("button", { name: "From GitHub, GitLab or Bitbucket" }).click();
    await expect(page.getByRole("list", { name: "Repos on GitHub" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Clone acme/billing-api" }).check();
    await page.getByRole("checkbox", { name: "Clone acme/storefront" }).check();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/remote-list-${theme}.png` });
    await page.getByRole("searchbox").fill("api");
    await expect(page.getByRole("list", { name: "Repos on GitHub" }).getByRole("listitem")).toHaveCount(1);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/remote-search-${theme}.png` });
  });
}

test("projects: cloning at mixed stages", async ({ page }) => {
  await open(page, "projects", "dark", { scene: SCENES.projects, jobs: MIXED_JOBS });
  await page.getByRole("button", { name: "From GitHub, GitLab or Bitbucket" }).click();
  await expect(page.getByText("Receiving")).toBeVisible();
  await expect(page.getByText("Waiting for the host helper")).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/cloning-mixed.png` });
});

test("projects: an empty repo cannot be cloned", async ({ page }) => {
  await open(page, "projects", "dark", { scene: SCENES.projects });
  await page.getByRole("button", { name: "From GitHub, GitLab or Bitbucket" }).click();
  await page.getByRole("checkbox", { name: "Clone acme/new-service" }).check();
  await page.getByRole("button", { name: "Clone 1 repo" }).click();
  await expect(page.getByText(/is empty, so there is nothing to clone/)).toBeVisible();
  await page.getByText(/is empty, so there is nothing to clone/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/error-clone-empty.png` });
  await page.getByRole("button", { name: "Start a new project instead" }).click();
  await expect(page.getByRole("form", { name: "New project" })).toBeVisible();
});

test("projects: a refused sign-in on the remote tab", async ({ page }) => {
  await open(page, "projects", "dark", { scene: SCENES.projects, remote: "refused" });
  await page.getByRole("button", { name: "From GitHub, GitLab or Bitbucket" }).click();
  await expect(page.getByRole("alert")).toContainText("no longer accepts");
  await page.screenshot({ path: `${SHOTS}/error-remote-refused.png` });
});

for (const theme of ["dark", "light"] as const) {
  test(`projects: new project, also on GitHub (${theme})`, async ({ page }) => {
    const s: Stubs = { scene: SCENES.projects };
    await open(page, "projects", theme, s);
    await page.getByRole("button", { name: "New project" }).click();
    const form = page.getByRole("form", { name: "New project" });
    await form.getByRole("textbox", { name: "Name" }).fill("new-api");
    await form.getByRole("combobox", { name: "Workspace" }).selectOption("acme");
    await form.getByRole("textbox", { name: "Description" }).fill("Billing API for the new checkout");
    await form.getByRole("checkbox", { name: "Also create it on GitHub" }).check();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/new-project-remote-${theme}.png` });
    await form.getByRole("button", { name: "Create and publish on GitHub" }).click();
    await expect(page.getByText("acme-dev/new-api")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/new-project-published-${theme}.png` });
  });
}

test("projects: publishing fails, the project stays", async ({ page }) => {
  await open(page, "projects", "dark", { scene: SCENES.projects, publishFails: true });
  await page.getByRole("button", { name: "New project" }).click();
  const form = page.getByRole("form", { name: "New project" });
  await form.getByRole("textbox", { name: "Name" }).fill("new-api");
  await form.getByRole("combobox", { name: "Workspace" }).selectOption("acme");
  await form.getByRole("checkbox", { name: "Also create it on GitHub" }).check();
  await form.getByRole("button", { name: "Create and publish on GitHub" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists on GitHub");
  await page.screenshot({ path: `${SHOTS}/error-publish.png` });
});

// Motion ------------------------------------------------------------------------------------

test("the boat glides to the next stop", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: `${SHOTS}/video`, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  await open(page, "workspaces", "dark", { scene: SCENES.workspaces });
  const boat = page.locator("[data-boat]");
  await page.waitForTimeout(800);
  const before = await boat.getAttribute("transform");
  await page
    .getByRole("navigation", { name: "Setup progress" })
    .getByRole("button", { name: /Git accounts/ })
    .click();
  const fps = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = (now: number) => {
          frames += 1;
          if (now - start < 2000) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (now - start));
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`frames per second while the boat glides: ${(await fps).toFixed(1)}`);
  const scene = page.locator(".rv-scene");
  for (let i = 0; i < 12; i += 1) {
    await scene.screenshot({ path: `${SHOTS}/frames/boat-${String(i).padStart(2, "0")}.png` });
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(1200);
  const after = await boat.getAttribute("transform");
  expect(after).not.toEqual(before);
  await context.close();
});

test("reduced motion: the scene stands still and the boat moves at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "workspaces", "dark", { scene: SCENES.workspaces });
  const flow = page.locator(".rv-bob").first();
  expect(await flow.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  const boat = page.locator("[data-boat]");
  const before = await boat.getAttribute("transform");
  await page
    .getByRole("navigation", { name: "Setup progress" })
    .getByRole("button", { name: /Git accounts/ })
    .click();
  await page.waitForTimeout(60);
  const soon = await boat.getAttribute("transform");
  await page.waitForTimeout(1200);
  expect(soon).not.toEqual(before);
  expect(await boat.getAttribute("transform")).toEqual(soon);
  await page.screenshot({ path: `${SHOTS}/reduced-motion.png` });
});

// Click tests -------------------------------------------------------------------------------

test("the whole journey with stubs: welcome to arrive, then the board with the new-task box", async ({
  page,
}) => {
  const s: Stubs = { scene: { ...SCENES.welcome }, agents: [] };
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, s);
  await page.goto("/");
  const heading = page.locator("#journey-heading");
  await expect(heading).toHaveText(/Welcome to majhi/);
  await page.getByRole("button", { name: "Use ~/Work" }).click();
  await expect(heading).toHaveText("Sign in to Claude Code or Codex");
  // The stubbed status never marks the account done, so this journey skips it.
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(heading).toHaveText("Keep each client's work apart");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(heading).toHaveText("Sign each workspace in to git");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(heading).toHaveText("Add the projects agents can work on");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(heading).toHaveText("Choose the captain");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(heading).toHaveText("You have arrived");
  await expect(
    page.getByRole("navigation", { name: "Setup progress" }).getByRole("button", { name: /Git accounts/ }),
  ).toContainText("Skipped");
  await page.getByRole("button", { name: "Write the first task" }).click();
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/arrive-board.png` });
});

test("a skipped step comes back from Hub setup, and a reload keeps the place", async ({ page }) => {
  const s: Stubs = { scene: SCENES.git };
  await open(page, "git", "dark", s);
  const heading = page.locator("#journey-heading");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(heading).toHaveText("Add the projects agents can work on");

  // A reload keeps the place.
  await page.reload();
  await expect(heading).toHaveText("Add the projects agents can work on");

  // Put the rest off, then reopen the skipped step from Hub setup.
  await page.getByRole("button", { name: "Finish later" }).click();
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await page.goto("/setup");
  const steps = page.getByRole("list", { name: "First-time setup steps" });
  await expect(steps.getByRole("listitem").filter({ hasText: "Git accounts" })).toContainText("Skipped");
  await steps
    .getByRole("listitem")
    .filter({ hasText: "Git accounts" })
    .getByRole("button", { name: "Open" })
    .click();
  await expect(heading).toHaveText("Sign each workspace in to git");
  await page.reload();
  await expect(heading).toHaveText("Sign each workspace in to git");
});

test("the scene keeps its frame rate while the boat glides", async ({ page }) => {
  await open(page, "workspaces", "dark", { scene: SCENES.workspaces });
  await page.waitForTimeout(600);
  await page
    .getByRole("navigation", { name: "Setup progress" })
    .getByRole("button", { name: /Arrive/ })
    .click();
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = (now: number) => {
          frames += 1;
          if (now - start < 2500) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (now - start));
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`frames per second while the boat glides (no recording): ${fps.toFixed(1)}`);
  expect(fps).toBeGreaterThan(40);
});
