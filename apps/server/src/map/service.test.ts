import { rm } from "node:fs/promises";
import type { MapView } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { writeFixtures } from "./fixtures.ts";
import { MapRepo } from "./repo.ts";
import { type Ask, MapService } from "./service.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const NOW = new Date("2026-10-06T10:00:00.000Z");

/** An answer from the model that names a real line of a file it was sent. */
const jobsReply: Ask = async (_task, prompt, parse) => {
  const parsed = parse(
    JSON.stringify({
      nodes: [{ id: "outside:replicate", label: "Replicate" }],
      edges: [
        {
          from: "acme-api",
          to: "store:redis",
          type: "queue",
          label: "puts image-jobs",
          file: "src/jobs.py",
          line: 7,
        },
        // A line the file does not have: dropped.
        {
          from: "acme-api",
          to: "outside:replicate",
          type: "http",
          label: "makes images",
          file: "src/jobs.py",
          line: 99,
        },
        // Another project's file: dropped.
        {
          from: "acme-api",
          to: "outside:replicate",
          type: "http",
          label: "makes images",
          file: "src/other.py",
          line: 1,
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.problem);
  expect(prompt).toContain("src/jobs.py");
  return { value: parsed.value };
};

async function setup(
  opts: {
    ask?: Ask | undefined;
    spent?: () => number;
    cap?: number;
    extra?: Record<string, Record<string, string>>;
  } = {},
) {
  const { root, projects } = await writeFixtures(opts.extra);
  roots.push(root);
  const store = new Store(":memory:");
  const repo = new MapRepo(store.raw);
  const all = [
    ...projects.map((p) => ({ id: p.id, org: "acme", path: p.path, exists: true })),
    { id: "globex-site", org: "globex", path: projects[0]?.path ?? "", exists: true },
  ];
  let changes = 0;
  const build = () =>
    new MapService({
      repo,
      projects: async () => all,
      tasks: () => [],
      ask: opts.ask,
      unavailable: async () => undefined,
      price: async () => ({ input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 }),
      spent: opts.spent ?? (() => 0),
      changed: () => {
        changes += 1;
      },
      now: () => NOW,
      remotes: async () => [],
      ...(opts.cap === undefined ? {} : { cap: opts.cap }),
    });
  const service = build();
  // A restart: the same stored map, nothing remembered of what the model read.
  return { service, restarted: build, repo, store, changes: () => changes };
}

const idsOf = (v: MapView) => v.map.edges.map((e) => e.id);

describe("one map per workspace", () => {
  it("keeps each workspace's map and projects apart", async () => {
    const { service } = await setup();
    const acme = await service.update("acme");
    expect(acme.map.nodes.map((n) => n.id)).toContain("acme-api");
    // Another workspace reads nothing of it, and its own project list holds only its own.
    const globex = await service.view("globex");
    expect(globex.map).toEqual({ v: 1, nodes: [], edges: [], removed: [] });
    expect(globex.updatedAt).toBeUndefined();
    expect(globex.projects.map((p) => p.id)).toEqual(["globex-site"]);
    expect((await service.view("acme")).projects.map((p) => p.id)).not.toContain("globex-site");
    // An update of one never touches the other.
    await service.update("globex");
    expect((await service.view("acme")).map.nodes.map((n) => n.id)).not.toContain("globex-site");
  });

  it("counts only the workspace's own merges, since the last update", async () => {
    const { service, store } = await setup();
    const log = store.raw.prepare(
      "INSERT INTO audit (task, agent, kind, title, decision, by, at, org) VALUES (?, 'owner', ?, 'x', ?, 'owner', ?, ?)",
    );
    log.run("ACM-1", "merge", "done", "2026-10-01T00:00:00.000Z", "acme");
    log.run("ACM-1", "merge", "done", "2026-10-01T00:01:00.000Z", "acme");
    log.run("ACM-2", "merge", "failed", "2026-10-01T00:02:00.000Z", "acme");
    log.run("GLX-1", "merge", "done", "2026-10-01T00:03:00.000Z", "globex");
    log.run("ACM-3", "push", "done", "2026-10-01T00:04:00.000Z", "acme");
    expect((await service.view("acme")).mergesSince).toBe(1);
    expect((await service.view("globex")).mergesSince).toBe(1);
    expect((await service.stale("acme")).stale).toBe(true);
    await service.update("acme");
    expect((await service.view("acme")).mergesSince).toBe(0);
    expect((await service.stale("acme")).stale).toBe(false);
    // A merge after the update makes it stale again, only in that workspace.
    log.run("ACM-4", "merge", "done", "2026-10-07T00:00:00.000Z", "acme");
    expect((await service.stale("acme")).merges).toBe(1);
    expect((await service.stale("globex")).stale).toBe(true);
  });
});

describe("removed lines", () => {
  it("are never added again, by the config pass or by the model", async () => {
    const { service, restarted } = await setup({ ask: jobsReply });
    const first = await service.update("acme");
    expect(idsOf(first)).toContain("acme-web>acme-api:http");
    expect(idsOf(first)).toContain("acme-api>store:redis:queue");
    await service.removeEdge("acme", "acme-web>acme-api:http");
    await service.removeEdge("acme", "acme-api>store:redis:queue");
    // After a restart the model reads the same files again and proposes the line again.
    const again = await restarted().update("acme");
    expect(idsOf(again)).not.toContain("acme-web>acme-api:http");
    expect(idsOf(again)).not.toContain("acme-api>store:redis:queue");
    expect(again.map.removed).toHaveLength(2);
    // Other lines stay.
    expect(idsOf(again)).toContain("acme-worker>worker-kit:lib");
  });
});

describe("the code pass", () => {
  it("lands proposed lines as new, with the real line as proof, and drops guesses", async () => {
    const { service } = await setup({ ask: jobsReply });
    const view = await service.update("acme");
    const line = view.map.edges.find((e) => e.id === "acme-api>store:redis:queue");
    expect(line).toMatchObject({
      source: "agent",
      state: "new",
      label: "puts image-jobs",
      evidence: [
        { project: "acme-api", file: "src/jobs.py", line: 7, excerpt: 'queue.lpush("image-jobs", payload)' },
      ],
    });
    expect(view.map.edges.some((e) => e.id === "acme-api>outside:replicate:http")).toBe(false);
    expect(view.report?.fresh).toBe(1);
    // The owner checks it once; a later update keeps it checked.
    await service.confirmEdge("acme", "acme-api>store:redis:queue");
    const again = await service.update("acme");
    expect(again.map.edges.find((e) => e.id === "acme-api>store:redis:queue")?.state).toBe("confirmed");
  });

  it("with no model, the update is config and history only, and says so", async () => {
    const { service } = await setup();
    const view = await service.update("acme");
    expect(idsOf(view)).toContain("acme-web>acme-api:http");
    expect(view.report?.note).toMatch(/No model/);
    expect(view.report?.fresh).toBe(0);
  });

  it("a model that fails keeps what the files showed, and the report says why", async () => {
    const down: Ask = async () => {
      throw new Error("The model is down.");
    };
    const { service } = await setup({ ask: down });
    const view = await service.update("acme");
    expect(idsOf(view)).toContain("acme-worker>worker-kit:lib");
    expect(view.report?.note).toContain("The model is down.");
  });

  it("stops at the cost cap and says how many projects were left", async () => {
    let asked = 0;
    const ask: Ask = async (task, prompt, parse) => {
      asked += 1;
      return jobsReply(task, prompt, parse);
    };
    // Every call already cost more than the cap: only the first project is ever read.
    const { service } = await setup({
      ask,
      spent: () => (asked >= 1 ? 1 : 0),
      cap: 0.5,
      extra: { "acme-worker": { "src/producer.ts": "export const send = () => fetch('http://x');\n" } },
    });
    const view = await service.update("acme");
    expect(asked).toBe(1);
    expect(view.report?.note).toMatch(/Stopped at the cost cap of \$0\.50/);
  });

  it("two updates at once share one run", async () => {
    let asked = 0;
    const ask: Ask = async (task, prompt, parse) => {
      asked += 1;
      return jobsReply(task, prompt, parse);
    };
    const { service } = await setup({ ask });
    const [a, b] = await Promise.all([service.update("acme"), service.update("acme")]);
    expect(a).toEqual(b);
    expect(asked).toBe(1);
  });

  it("estimates the files and the cost before anything runs", async () => {
    const { service } = await setup({ ask: jobsReply });
    const e = await service.estimate("acme");
    expect(e.files).toBe(1);
    expect(e.tokens).toBeGreaterThan(0);
    expect(e.usd).toBeGreaterThan(0);
    expect(e.usd).toBeLessThan(e.cap);
  });
});
