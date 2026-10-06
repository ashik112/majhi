import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeOptions, TurnUsage } from "@majhi/acp";
import { CommitShaSchema, type WikiPage, wikiPageId } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../commands/handlers.ts";
import { mergeSettings } from "../config/settings.ts";
import { Housekeeper } from "../memory/housekeeper.ts";
import { Store } from "../store/index.ts";
import { fakeRuntime } from "../testing/fakeRuntime.ts";
import type { UsageRecorder } from "../usage/recorder.ts";
import { wikiHandlers } from "./handlers.ts";
import { type WikiReader, WikiService } from "./service.ts";
import { checkWorkspacePage } from "./writer/workspace.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Acme Dev",
  GIT_AUTHOR_EMAIL: "dev@acme.example",
  GIT_COMMITTER_NAME: "Acme Dev",
  GIT_COMMITTER_EMAIL: "dev@acme.example",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const API_ROUTES = "def items():\n    return []\n\ndef login():\n    return 1\n";
const WEB_CLIENT =
  "fetch('/api/v1/items');\nfetch('/api/v1/login', { method: 'POST' });\nfetch('/api/v1/legacy');\n";

let root: string;
let store: Store;
const repos: Record<string, string> = {};

async function repoWith(name: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, name);
  repos[name] = dir;
  await mkdir(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch", "main");
  await put(name, files);
  commit(name, "first");
}
async function put(name: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repos[name] as string, path)), { recursive: true });
    await writeFile(join(repos[name] as string, path), text);
  }
}
function commit(name: string, message: string): string {
  git(repos[name] as string, "add", "-A");
  git(repos[name] as string, "commit", "--quiet", "-m", message);
  return git(repos[name] as string, "rev-parse", "HEAD");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wiki-workspace-"));
  await repoWith("acme-api", { "app/routes.py": API_ROUTES });
  await repoWith("acme-web", { "src/client.ts": WEB_CLIENT });
  store = new Store(":memory:");
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

/** What the sealed reader would find in each repo, told apart by a file only one of them has. */
const reader: WikiReader = {
  async readFacts(exportDir, cache) {
    const isApi = (await import("node:fs")).existsSync(join(exportDir, "app/routes.py"));
    const out = isApi
      ? {
          routes: [
            {
              method: "GET",
              path: "/api/v1/items",
              file: "app/routes.py",
              line: 1,
              protocol: "http",
              techs: [],
            },
            {
              method: "POST",
              path: "/api/v1/login",
              file: "app/routes.py",
              line: 4,
              protocol: "http",
              techs: [],
            },
          ],
          requests: [],
        }
      : {
          routes: [],
          requests: [
            { file: "src/client.ts", line: 1, method: "GET", path: "/api/v1/items" },
            { file: "src/client.ts", line: 2, method: "POST", path: "/api/v1/login" },
            { file: "src/client.ts", line: 3, method: "GET", path: "/api/v1/legacy" },
          ],
        };
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, "reader.json"),
      JSON.stringify({ v: 1, files: 1, entries: [], calls: [], errors: [], ...out }),
    );
    return { ok: true, ms: 1 };
  },
  async updateGraph() {
    return { ok: true, ms: 1 };
  },
};

const turn: TurnUsage = {
  inputTokens: 1000,
  outputTokens: 200,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reported: true,
};

const cites = (...c: [string, string, number, number][]) =>
  c.map(([repo, path, a, b]) => ({ repo, path, lines: [a, b] as [number, number] }));

/** The writer's answer for the page the prompt names. Every page cites real lines of both repos. */
function reply(prompt: string): string {
  if (prompt.includes("You reword sentences")) {
    return prompt.split("<sentences>\n")[1]?.split("\n</sentences>")[0] ?? "{}";
  }
  if (prompt.includes("You choose the main cross-repository flows")) {
    const lead = prompt.split("<links>\n")[1]?.split("\n")[0]?.split(" | ")[0];
    return JSON.stringify({
      flows: [
        { slug: "sign-in", title: "Sign in", trigger: "a person signs in on the web app", facts: [lead] },
      ],
    });
  }
  if (prompt.includes("You choose the main flows")) return JSON.stringify({ flows: [] });
  const title = prompt.split("## Page: ")[1]?.split("\n")[0] ?? "";
  if (title === "System overview") {
    return JSON.stringify({
      summary: ["The web app calls the API."],
      repos: [
        {
          project: "acme-web",
          role: "frontend",
          tech: "React",
          text: "The web app is the browser client.",
          citations: cites(["acme-web", "src/client.ts", 1, 2]),
          status: "proven",
        },
        {
          project: "acme-api",
          role: "backend",
          tech: "FastAPI",
          text: "The API answers the web app.",
          citations: cites(["acme-api", "app/routes.py", 1, 5]),
          status: "guessed",
        },
      ],
      items: [
        {
          text: "The web app signs people in through the API.",
          citations: cites(["acme-web", "src/client.ts", 2, 2], ["acme-api", "app/routes.py", 4, 5]),
          status: "proven",
        },
      ],
      guessed_links: [{ from: "acme-api", to: "acme-web", label: "pushes events", why: "a guess" }],
    });
  }
  const own = title === "Sign in" ? "web" : "";
  return JSON.stringify({
    summary: [`This page is about ${title}.`],
    items: ["Browser", "API"].map((actor) => ({
      text: `${title} happens in the code (${actor}).`,
      citations:
        own === "web"
          ? cites(["acme-web", "src/client.ts", 2, 2], ["acme-api", "app/routes.py", 4, 5])
          : [{ path: prompt.includes("acme-web") ? "src/client.ts" : "app/routes.py", lines: [1, 2] }],
      status: "proven",
      actor,
      label: "call",
    })),
  });
}

function world(extra: { sessions?: { count: number } } = {}) {
  const runtime = fakeRuntime();
  runtime.onSession = (session) => {
    if (extra.sessions !== undefined) extra.sessions.count += 1;
    session.models = {
      ...session.models,
      models: ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5"].map((id) => ({ id, name: id })),
    };
    session.script = async (t) => {
      t.emit({ type: "text", messageId: "m", text: reply(t.text) });
      t.emit({ type: "turn", usage: turn });
      return "end_turn";
    };
  };
  const housekeeper = new Housekeeper({
    config: {
      settings: async () => mergeSettings({}),
      sections: async () => ({
        boss: "acme-writer",
        accounts: { main: { tool: "claude", auth: "login", org: "private" } },
      }),
      file: join(root, "majhi.yaml"),
    } as never,
    agents: {
      get: async () => ({
        ok: true,
        agent: { frontmatter: { id: "acme-writer", account: "main", scope: "root", where: ["anywhere"] } },
      }),
    } as never,
    secrets: {} as never,
    runtime,
    options: {} as RuntimeOptions,
    majhiHome: join(root, "home"),
    usage: { record: async () => {} } as unknown as UsageRecorder,
  });
  const projects = [
    { id: "acme-api", org: "acme", path: repos["acme-api"] as string, base: "main", exists: true },
    { id: "acme-web", org: "acme", path: repos["acme-web"] as string, base: "main", exists: true },
    { id: "globex-api", org: "globex", path: repos["acme-api"] as string, base: "main", exists: true },
  ];
  const service = new WikiService({
    repo: store.wiki,
    enabled: async () => true,
    projects: async () => projects,
    tasksDir: async () => join(root, "tasks"),
    reader,
    housekeeper,
    rest: async () => undefined,
    unavailable: async () => undefined,
    price: async () => undefined,
    changed: () => {},
  });
  const handlers = wikiHandlers({
    repo: store.wiki,
    enabled: async () => true,
    orgs: async () => ["acme", "globex"],
    projects: async (org) => projects.filter((p) => p.org === org).map((p) => p.id),
    service,
    asker: { answer: async () => ({ answer: "", sources: [], pages: [], found: false }) },
    lanes: {} as never,
    store: {} as never,
  });
  const owner = (command: string) =>
    ({ command, meta: { actor: { kind: "owner" } } }) as unknown as CommandContext;
  return { service, handlers, owner };
}

const workspacePages = (org = "acme") => store.wiki.loaded(org, undefined);
const body = (page: WikiPage | undefined) => page?.body ?? "";

describe("the workspace wiki", () => {
  it("writes the overview and the cross-repo flow from the links, and lists the call that links nowhere", async () => {
    const { service } = world();
    await service.update("acme");
    const pages = workspacePages();
    expect(pages.map((p) => p.id).sort()).toEqual(["flow:sign-in", "gaps", "overview"]);

    const overview = pages.find((p) => p.id === "overview") as WikiPage;
    expect(Object.keys(overview.builtFrom).sort()).toEqual(["acme-api", "acme-web"]);
    expect(overview.project).toBeUndefined();
    // The picture is drawn from the links: a solid line per proven pair, the writer's guess dashed.
    const edges = overview.diagrams[0]?.edges ?? [];
    expect(edges.map((e) => [e.from, e.to, e.type ?? e.style])).toEqual([
      ["acme-web", "acme-api", "http"],
      ["acme-api", "acme-web", "dashed"],
    ]);
    expect(edges[0]?.label).toBe("GET /api/v1/items +1 (exact)");
    expect(overview.diagrams[0]?.nodes.map((n) => [n.id, n.kind])).toEqual([
      ["acme-api", "backend"],
      ["acme-web", "frontend"],
    ]);

    // Gaps is built by code: the call that matches no route, with its file and line, and the guessed link.
    const gaps = body(pages.find((p) => p.id === "gaps"));
    expect(gaps).toContain("GET /api/v1/legacy at `src/client.ts:3` (acme-web)");
    expect(gaps).toContain("acme-api to acme-web");
    // Every project's own Gaps page lists its unlinked calls too.
    expect(body(store.wiki.page("acme", "acme-web", wikiPageId({ kind: "gaps" }))?.page)).toContain(
      "## Not linked calls",
    );
    expect(body(store.wiki.page("acme", "acme-api", wikiPageId({ kind: "gaps" }))?.page)).not.toContain(
      "Not linked calls",
    );
  });

  it("a second update on the same commits asks the writer nothing", async () => {
    const sessions = { count: 0 };
    const { service } = world({ sessions });
    await service.update("acme");
    const asked = sessions.count;
    await service.update("acme");
    expect(sessions.count).toBe(asked);
  });

  it("a project update rewrites only the workspace pages that cite a file that changed there", async () => {
    const { service } = world();
    await service.update("acme");
    const before = store.wiki.versionCount("acme", undefined, wikiPageId({ kind: "overview" }));
    // A file no workspace page cites: nothing is rewritten.
    await put("acme-api", { "README.md": "notes\n" });
    commit("acme-api", "notes");
    await service.update("acme", "acme-api");
    expect(store.wiki.versionCount("acme", undefined, wikiPageId({ kind: "overview" }))).toBe(before);
    // A file the overview and the flow cite: both are written again, nothing else.
    await put("acme-web", { "src/client.ts": `${WEB_CLIENT}// v2\n` });
    commit("acme-web", "touch the client");
    const reports = await service.update("acme", "acme-web");
    expect(reports.flatMap((r) => r.written).sort()).toContain("overview");
    expect(store.wiki.versionCount("acme", undefined, wikiPageId({ kind: "overview" }))).toBe(before + 1);
  });
});

describe("updating one page", () => {
  it("writes only that page and leaves the commit and the other stale pages as they were", async () => {
    const { service } = world();
    await service.update("acme");
    const built = store.wiki.state("acme", "acme-api").builtCommit;
    await put("acme-api", { "app/routes.py": `${API_ROUTES}# v2\n` });
    const next = commit("acme-api", "touch the routes");

    const [report] = await service.update("acme", "acme-api", { page: wikiPageId({ kind: "infra" }) });
    expect(report?.written).toEqual(["infra"]);
    expect(store.wiki.state("acme", "acme-api").builtCommit).toBe(built);
    expect(store.wiki.page("acme", "acme-api", wikiPageId({ kind: "infra" }))?.page.builtFrom).toEqual({
      "acme-api": next,
    });
    // The overview is still behind, so a full update writes it.
    const again = await service.update("acme", "acme-api");
    expect(again.flatMap((r) => r.written)).toContain("overview");
    expect(store.wiki.state("acme", "acme-api").builtCommit).toBe(next);
  });

  it("writes one workspace page even when it is not stale, and refuses a project that was never built", async () => {
    const { service } = world();
    await expect(
      service.update("acme", "acme-api", { page: wikiPageId({ kind: "overview" }) }),
    ).rejects.toThrow(/no wiki yet/);
    await service.update("acme");
    const before = store.wiki.versionCount("acme", undefined, wikiPageId({ kind: "overview" }));
    const reports = await service.update("acme", undefined, { page: wikiPageId({ kind: "overview" }) });
    expect(reports.flatMap((r) => r.written)).toEqual(["overview"]);
    expect(
      store.wiki.versionCount("acme", undefined, wikiPageId({ kind: "overview" })),
    ).toBeGreaterThanOrEqual(before);
  });
});

describe("owner answers", () => {
  it("redraw the links at once, and still hold after the next update", async () => {
    const { service, handlers, owner } = world();
    await service.update("acme");
    const call = (await service.system("acme")).facts.find(
      (f) => f.kind === "call" && f.path === "/api/v1/legacy",
    );
    expect(call?.id).toBeDefined();

    const view = await handlers["wiki.answer"](
      {
        org: "acme",
        question: { kind: "call", call: call?.id as never },
        to: { kind: "project", project: "acme-api" },
      },
      owner("wiki.answer"),
    );
    expect(view.unlinked).toEqual([]);
    expect(view.links.map((l) => [l.basis, l.label])).toContainEqual(["owner", "GET /api/v1/legacy (owner)"]);
    // The pages are drawn again with no model: the project's gaps no longer list the call.
    expect(body(store.wiki.page("acme", "acme-web", wikiPageId({ kind: "gaps" }))?.page)).not.toContain(
      "Not linked calls",
    );
    expect(body(store.wiki.page("acme", undefined, wikiPageId({ kind: "gaps" }))?.page)).not.toContain(
      "GET /api/v1/legacy",
    );

    await put("acme-web", { "src/client.ts": `${WEB_CLIENT}// v2\n` });
    commit("acme-web", "touch the client");
    await service.update("acme");
    const again = await service.system("acme");
    expect(again.view.links.map((l) => l.basis)).toContain("owner");
    expect(again.view.unlinked).toEqual([]);
  });

  it("never name a project of another workspace, and never apply across workspaces", async () => {
    const { service, handlers, owner } = world();
    await service.update("acme");
    await expect(
      handlers["wiki.answer"](
        {
          org: "acme",
          question: { kind: "address", host: "api.example.test" },
          to: { kind: "project", project: "globex-api" },
        },
        owner("wiki.answer"),
      ),
    ).rejects.toThrow(/not a project of workspace "acme"/);
    await handlers["wiki.answer"](
      { org: "acme", question: { kind: "address", host: "api.example.test" }, to: { kind: "outside" } },
      owner("wiki.answer"),
    );
    expect(store.wiki.answers("acme")).toHaveLength(1);
    expect(store.wiki.answers("globex")).toEqual([]);
  });
});

describe("role choices", () => {
  const overview = (org: string, role: "backend" | "database" = "backend"): WikiPage => ({
    id: wikiPageId({ kind: "overview" }),
    org,
    project: "acme-api",
    kind: "overview",
    title: "Overview",
    body: "The API serves the web app [1].",
    claims: [{ n: 1, text: "The API serves the web app.", proven: false, facts: [], sources: [] }],
    roles: [{ role, where: "app", tech: "FastAPI", claim: 1 }],
    dropped: [],
    diagrams: [],
    builtFrom: { "acme-api": CommitShaSchema.parse("a".repeat(40)) },
    v: 1,
  });

  it("survive the next update, and show as the owner's on read", async () => {
    const { service, handlers, owner } = world();
    await service.update("acme", "acme-api");
    const id = wikiPageId({ kind: "overview" });
    const written = store.wiki.page("acme", "acme-api", id)?.page as WikiPage;
    // The fake writer gives an overview with no role tiles: put one the way a real update would, then decide on it.
    store.wiki.save({ ...overview("acme"), builtFrom: written.builtFrom });

    const decided = await handlers["wiki.setRole"](
      { org: "acme", project: "acme-api", role: "backend", where: "app", choice: "database" },
      owner("wiki.setRole"),
    );
    expect(decided.page.roles).toMatchObject([{ role: "database", basis: "owner" }]);
    // The Gaps page stops listing it as a guess.
    expect(body(store.wiki.page("acme", "acme-api", wikiPageId({ kind: "gaps" }))?.page)).not.toContain(
      "Guessed roles",
    );

    // The writer gives the same guess again on the next update: the decision still stands.
    store.wiki.save({
      ...overview("acme"),
      builtFrom: written.builtFrom,
      body: "The API serves the web app [1]. Again.",
    });
    const read = await handlers["wiki.page"]({ org: "acme", project: "acme-api", id }, owner("wiki.page"));
    expect(read.page.roles).toMatchObject([{ role: "database", basis: "owner" }]);

    // Taking it back returns the writer's own tile.
    const undone = await handlers["wiki.setRole"](
      { org: "acme", project: "acme-api", role: "database", where: "app", choice: "undo" },
      owner("wiki.setRole"),
    );
    expect(undone.page.roles).toMatchObject([{ role: "backend" }]);
    expect(undone.page.roles[0]?.basis).toBeUndefined();
    expect(body(store.wiki.page("acme", "acme-api", wikiPageId({ kind: "gaps" }))?.page)).toContain(
      "Guessed roles",
    );
  });

  it("apply to the workspace that made them and to no other", async () => {
    const { handlers, owner } = world();
    store.wiki.save(overview("acme"));
    store.wiki.save(overview("globex"));
    await handlers["wiki.setRole"](
      { org: "acme", project: "acme-api", role: "backend", where: "app", choice: "confirm" },
      owner("wiki.setRole"),
    );
    const id = wikiPageId({ kind: "overview" });
    const acme = await handlers["wiki.page"]({ org: "acme", project: "acme-api", id }, owner("wiki.page"));
    const globex = await handlers["wiki.page"](
      { org: "globex", project: "acme-api", id },
      owner("wiki.page"),
    );
    expect(acme.page.roles[0]?.basis).toBe("owner");
    expect(globex.page.roles[0]?.basis).toBeUndefined();
  });
});

describe("workspace citations are checked per repo", () => {
  it("proves a claim only against the export of the repo it cites", async () => {
    const api = join(root, "export-api");
    const web = join(root, "export-web");
    await mkdir(join(api, "app"), { recursive: true });
    await mkdir(join(web, "src"), { recursive: true });
    await writeFile(join(api, "app/routes.py"), API_ROUTES);
    await writeFile(join(web, "src/client.ts"), WEB_CLIENT);
    const sha = "b".repeat(40);
    const repoRefs = [
      { project: "acme-api", commit: sha, root: api },
      { project: "acme-web", commit: sha, root: web },
    ];
    const claim = (text: string, ...c: [string, string, number, number][]) => ({
      text,
      proven: true,
      facts: [],
      citations: cites(...c),
    });
    const page = await checkWorkspacePage(
      {
        id: wikiPageId({ kind: "flow", slug: "sign-in" }),
        kind: "flow",
        org: "acme",
        title: "Sign in",
        summary: ["Sign in."],
        claims: [
          claim("Both sides.", ["acme-web", "src/client.ts", 2, 2], ["acme-api", "app/routes.py", 4, 5]),
          // A path that exists in the other repo only does not prove this one.
          claim("Wrong repo.", ["acme-api", "src/client.ts", 1, 1]),
          // A repo the workspace does not have proves nothing, even with a real path.
          claim("Another workspace.", ["globex-api", "app/routes.py", 1, 1]),
          // The path leaves the export.
          claim("Escape.", ["acme-api", "../export-web/src/client.ts", 1, 1]),
        ],
        roles: [],
        guessedLinks: [],
        couldNot: [],
      },
      repoRefs,
      { links: [] },
      "acme",
    );
    expect(page.claims.map((c) => c.text)).toEqual(["Both sides."]);
    expect(page.claims[0]?.sources.map((s) => `${s.repo}:${s.path}:${s.lines[0]}`)).toEqual([
      "acme-web:src/client.ts:2",
      "acme-api:app/routes.py:4",
    ]);
    expect(page.dropped.map((d) => [d.text, d.reason])).toEqual([
      ["Wrong repo.", "missing-file"],
      ["Another workspace.", "outside-export"],
      ["Escape.", "outside-export"],
    ]);
    expect(page.project).toBeUndefined();
    expect(Object.keys(page.builtFrom).sort()).toEqual(["acme-api", "acme-web"]);
  });
});
