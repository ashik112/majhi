import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeOptions, TurnUsage } from "@majhi/acp";
import { type WikiPage, wikiPageId } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeSettings } from "../config/settings.ts";
import { Housekeeper } from "../memory/housekeeper.ts";
import { Store } from "../store/index.ts";
import { fakeRuntime } from "../testing/fakeRuntime.ts";
import type { UsageRecorder } from "../usage/recorder.ts";
import { type WikiReader, WikiService, type WikiServiceDeps } from "./service.ts";

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

let root: string;
let repoDir: string;
let store: Store;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wiki-service-"));
  repoDir = join(root, "api");
  await mkdir(repoDir, { recursive: true });
  git(repoDir, "init", "--quiet", "--initial-branch", "main");
  await files({
    "app/main.py":
      "def sign_in(request):\n    return check(request)\n\ndef check(request):\n    return True\n",
    "app/util.py": "def helper():\n    return 1\n\ndef other():\n    return 2\n",
    "web/index.js": "export function signIn() {\n  return fetch('/signin');\n}\n",
  });
  commit("first");
  store = new Store(":memory:");
});
afterEach(async () => {
  prompts.length = 0;
  store.close();
  await rm(root, { recursive: true, force: true });
});

async function files(entries: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(entries)) {
    await mkdir(dirname(join(repoDir, path)), { recursive: true });
    await writeFile(join(repoDir, path), text);
  }
}
function commit(message: string): string {
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "--quiet", "-m", message);
  return git(repoDir, "rev-parse", "HEAD");
}

/** The reader the sealed container would be: one route in `app/main.py`, and a graph that is always fresh. */
const reader: WikiReader = {
  async readFacts(_export, cache) {
    const route = {
      method: "GET",
      path: "/signin",
      file: "app/main.py",
      line: 1,
      protocol: "http",
      techs: [],
    };
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, "reader.json"),
      JSON.stringify({ v: 1, files: 3, routes: [route], entries: [], calls: [], errors: [] }),
    );
    return { ok: true, ms: 1 };
  },
  async updateGraph() {
    return { ok: true, ms: 1 };
  },
};

const turn = (extra: Partial<TurnUsage> = {}): TurnUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reported: true,
  ...extra,
});

/** What the writer says for the page named in the prompt: each page cites a different file, so a change shows which pages it moves. */
const CITES: Record<string, string> = {
  Overview: "app/main.py",
  "Infra and deploy": "app/util.py",
  "Sign in": "web/index.js",
  Deploys: ".github/workflows/deploy.yml",
};
/** Every prompt the writer was sent, in order. */
const prompts: string[] = [];
function reply(prompt: string): string {
  if (prompt.includes("You choose the main flows")) {
    const lead = prompt.split("\n").find((l) => l.startsWith("api:entry:"));
    const id = lead?.split(" | ")[0];
    return JSON.stringify({
      flows: [{ slug: "sign-in", title: "Sign in", trigger: "a person signs in", facts: [id] }],
    });
  }
  if (prompt.includes("You reword sentences")) {
    const body = prompt.split("<sentences>\n")[1]?.split("\n</sentences>")[0] ?? "{}";
    return body;
  }
  prompts.push(prompt);
  const title = prompt.split("## Page: ")[1]?.split("\n")[0] ?? "";
  const path = CITES[title] ?? "app/main.py";
  return JSON.stringify({
    summary: [`This page is about ${title}.`],
    items: ["API", "Database"].map((actor) => ({
      text: `${title} lives in the code (${actor}).`,
      citations: [{ path, lines: [1, 2] }],
      status: "proven",
      actor,
      section: "environments",
    })),
  });
}

interface World {
  service: WikiService;
  sessions: () => number;
  /** Holds every writer turn until released. */
  gate: { hold: boolean; release: () => void };
}

function world(
  extra: Partial<WikiServiceDeps> = {},
  options: { turn?: Partial<TurnUsage>; models?: string[] } = {},
): World {
  const runtime = fakeRuntime();
  let release: () => void = () => {};
  let held: Promise<void> = Promise.resolve();
  const gate = {
    hold: false,
    release: () => release(),
  };
  runtime.onSession = (session) => {
    session.models = {
      ...session.models,
      models: (options.models ?? ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5"]).map((id) => ({
        id,
        name: id,
      })),
    };
    session.script = async (t) => {
      if (gate.hold) {
        held = new Promise<void>((resolve) => {
          release = resolve;
        });
        gate.hold = false;
      }
      await held;
      t.emit({ type: "text", messageId: "m", text: reply(t.text) });
      t.emit({ type: "turn", usage: turn(options.turn) });
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
  const service = new WikiService({
    repo: store.wiki,
    enabled: async () => true,
    projects: async () => [{ id: "api", org: "acme", path: repoDir, base: "main", exists: true }],
    tasksDir: async () => join(root, "tasks"),
    reader,
    housekeeper,
    rest: async () => undefined,
    unavailable: async () => undefined,
    price: async () => undefined,
    changed: () => {},
    ...extra,
  });
  return { service, sessions: () => runtime.starts.length, gate };
}

const ids = () =>
  store.wiki
    .pages("acme", "api")
    .map((p) => p.id)
    .sort();

/** The pages a model wrote: the Deploys page of a repo with no deploy file is made by code, at no cost. */
const byModel = (written: readonly string[] | undefined) => (written ?? []).filter((id) => id !== "deploys");

describe("limits", () => {
  it("stops starting pages at the cost cap and says which are left", async () => {
    const { service } = world({ capUsd: 0.5 }, { turn: { costUsd: 0.6 } });
    const [report] = await service.update("acme", "api");
    expect(report?.stopped).toContain("cost cap of $0.50");
    expect(byModel(report?.written).length).toBe(1);
    expect(report?.left.length).toBe(2);
    expect(store.wiki.state("acme", "api").lastError).toContain("Stopped: reached the cost cap");
    expect(store.wiki.state("acme", "api").lastError).toContain("2 pages were not written");
  });

  it("stops at the token cap when the model has no price", async () => {
    // The dollar cap cannot see a model with no price, so only the token cap holds.
    const { service } = world(
      { capTokens: 1500 },
      { models: ["mystery-1", "mystery-2", "mystery-3"], turn: { inputTokens: 1000, outputTokens: 200 } },
    );
    const [report] = await service.update("acme", "api");
    expect(report?.usd).toBe(0);
    expect(report?.stopped).toContain("1,500 tokens");
    expect(byModel(report?.written).length).toBe(2);
    expect(report?.left.length).toBe(1);
  });

  it("writes nothing while the workspace's budget has no room", async () => {
    const { service, sessions } = world({ rest: async () => "Acme used its daily budget" });
    const [report] = await service.update("acme", "api");
    expect(byModel(report?.written)).toEqual([]);
    expect(report?.stopped).toContain("Acme used its daily budget");
    // The flows are still chosen: that is one cheap question and it is not a page. No page session was opened.
    expect(sessions()).toBeLessThanOrEqual(2);
    expect(ids()).toEqual(["deploys", "gaps"]);
  });
});

describe("notes on the Deploys page", () => {
  const deploys = wikiPageId({ kind: "deploys" });
  const note = "acme first, then the rest";

  it("survive every rewrite, reach the writer, and belong to one page of one project", async () => {
    await files({
      ".github/workflows/deploy.yml":
        "name: Deploy\non:\n  workflow_dispatch:\n    inputs:\n      version: {}\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps: []\n",
    });
    commit("deploy workflow");
    const { service } = world();
    await service.update("acme", "api");
    store.wiki.addNote("acme", { project: "api", page: deploys, text: note });
    store.wiki.addNote("acme", { project: "other", page: deploys, text: "another project's note" });
    await service.update("acme", "api", { page: deploys });
    expect(prompts.filter((p) => p.includes("## Page: Deploys")).at(-1)).toContain(
      `<corrections>\n${note}\n</corrections>`,
    );
    for (let again = 0; again < 2; again++) {
      const stored = store.wiki.page("acme", "api", deploys);
      expect(stored?.page.body).not.toContain(note);
      expect(store.wiki.shown(stored?.page as WikiPage).body).toContain(`## Owner notes\n- ${note}`);
      expect(store.wiki.shown(stored?.page as WikiPage).body).not.toContain("another project");
      await service.update("acme", "api", { page: deploys });
    }
  });
});
