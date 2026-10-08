import type { OpsIncident, Task, TaskId } from "@majhi/shared";
import { describe, expect, it, vi } from "vitest";
import { RoomService } from "../room/service.ts";
import { Store } from "../store/index.ts";
import { IncidentEngine, type IncidentSource } from "./engine.ts";
import { IncidentFacts } from "./facts.ts";

/**
 * The incident engine on a real store and room. Only the task service, the watch and the findings are small stand-ins:
 * what is asserted is what the owner sees (the task, its project, what waits for them, when it closes).
 */

const MIN = 60_000;

function setup(options: { starts?: "captain" | "owner"; projects?: string[]; soakMin?: number } = {}) {
  const store = new Store(":memory:");
  const room = new RoomService(store);
  const clock = { now: new Date("2026-10-08T10:00:00.000Z") };
  const incidents = new Map<number, OpsIncident>();
  const findingTask = new Map<number, string>();
  let counter = 0;
  const started: string[] = [];
  const closed: string[] = [];
  const create = async (input: {
    title: string;
    text: string;
    org: string;
    kind: "code" | "ops";
    repos?: { project: string }[] | undefined;
    provenance: { origin: Task["origin"] };
  }): Promise<Task> => {
    counter += 1;
    const at = clock.now.toISOString();
    const task: Task = {
      id: `ACM-${counter}`,
      title: input.title,
      brief: input.text,
      kind: input.kind,
      typing: { type: "incident", by: "captain" },
      ...(input.provenance.origin === undefined ? {} : { origin: input.provenance.origin }),
      org: input.org,
      status: "inbox",
      folder: `/tmp/majhi-incident-${counter}`,
      repos: (input.repos ?? []).map((r) => ({
        project: r.project,
        source: `/Users/owner/${r.project}`,
        base: "main",
        branch: `fix/${counter}`,
        createdBranch: true,
      })),
      team: [],
      mode: "lead",
      overrides: {},
      links: [],
      attachments: [],
      createdAt: at,
      updatedAt: at,
    };
    store.tasks.insert(task);
    return task;
  };
  const projects = (options.projects ?? ["storefront"]).map((id) => ({ id, name: id, envs: 1 }));
  const facts = new IncidentFacts({
    store,
    findings: {
      ofTask: (task) => [...findingTask].filter(([, t]) => t === task).map(([id]) => ({ id }) as never),
    },
    watch: {
      incident: (id) => incidents.get(id),
      incidentOfFinding: (finding) => [...incidents.values()].find((i) => i.finding === finding),
    },
    settings: async () => ({ soakMin: options.soakMin ?? 15, cadenceMin: 30 }),
    envs: async () => 1,
    now: () => clock.now,
  });
  const reopen = vi.fn(async (id: string) => {
    store.raw.prepare("UPDATE tasks SET status = 'inbox' WHERE id = ?").run(id);
    return store.tasks.get(id) as Task;
  });
  const engine = new IncidentEngine({
    store,
    facts,
    room,
    findings: {
      adopt: (id, task) => {
        findingTask.set(id, task);
        return {} as never;
      },
      ofTask: (task) => [...findingTask].filter(([, t]) => t === task).map(([id]) => ({ id }) as never),
      get: (id) => ({ id, task: findingTask.get(id) }) as never,
    },
    watch: {
      openIncidents: () => [...incidents.values()].filter((i) => i.status === "open"),
      incident: (id) => incidents.get(id),
    },
    watchProject: () => "storefront",
    tasks: {
      create: create as never,
      start: async (id) => {
        started.push(id);
        store.raw.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);
        return store.tasks.get(id) as Task;
      },
      close: async (id) => {
        closed.push(id);
        store.raw
          .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
          .run(clock.now.toISOString(), id);
        return store.tasks.get(id) as Task;
      },
      reopen,
      attachProject: async () => ({}) as Task,
    },
    deploys: { rollback: async () => undefined },
    projects: async () => projects,
    starts: async () => options.starts ?? "owner",
    changed: () => undefined,
    now: () => clock.now,
  });
  const watchIncident = (over: Partial<OpsIncident> = {}): OpsIncident => {
    const inc: OpsIncident = {
      id: 7,
      org: "acme",
      title: "Database usage is over 90%",
      severity: "high",
      status: "open",
      finding: 3,
      openedAt: clock.now.toISOString(),
      flaps: 0,
      timeline: [],
      watch: "wch-abcd1234",
      ...over,
    };
    incidents.set(inc.id, inc);
    return inc;
  };
  const deploy = (task: string, state: string, at: Date) => {
    store.raw
      .prepare(
        `INSERT INTO deploys (org, project, env, commit_sha, state, task, by, runs, seq, attempt, created_at, updated_at, finished_at)
         VALUES ('acme', 'storefront', 'production', ?, ?, ?, 'owner', '[]', 0, 1, ?, ?, ?)`,
      )
      .run(
        `abcdef${Math.random().toString(16).slice(2, 10)}`,
        state,
        task,
        at.toISOString(),
        at.toISOString(),
        at.toISOString(),
      );
  };
  return { store, engine, clock, incidents, watchIncident, started, closed, reopen, findingTask, deploy };
}

const watchSource = (inc: OpsIncident): IncidentSource => ({
  kind: "watch",
  org: "acme",
  incident: inc,
  project: "storefront",
  evidence: ["db: 93% used"],
});

describe("an incident from each source is a startable task on the right project", () => {
  it("a firing watch, a failed deploy and a client claim each open one incident task on the project", async () => {
    const t = setup();
    const fromWatch = await t.engine.open(watchSource(t.watchIncident()));
    const task = t.store.tasks.get(fromWatch.task) as Task;
    expect(task.typing?.type).toBe("incident");
    expect(task.kind).toBe("code");
    expect(task.repos.map((r) => r.project)).toEqual(["storefront"]);
    expect(task.status).toBe("inbox");
    expect(task.origin).toMatchObject({ kind: "watch", incident: 7 });

    const t2 = setup();
    const fromDeploy = await t2.engine.open({
      kind: "deploy",
      org: "acme",
      record: { id: 4, project: "storefront", env: "production" } as never,
      title: "Deploy of storefront to production failed",
      text: "It failed.",
    });
    expect(t2.store.tasks.get(fromDeploy.task)?.repos.map((r) => r.project)).toEqual(["storefront"]);
    expect(t2.store.tasks.get(fromDeploy.task)?.origin).toMatchObject({ kind: "deploy", deploy: 4 });

    const t3 = setup();
    const fromClient = await t3.engine.open({
      kind: "client",
      org: "acme",
      room: "ACM-50",
      item: "m1",
      finding: 9,
      project: "storefront",
      text: "server is down",
      facts: ["Database usage is over 90%"],
    });
    expect(t3.store.tasks.get(fromClient.task)?.origin).toMatchObject({ kind: "client", room: "ACM-50" });
    expect(t3.store.tasks.get(fromClient.task)?.repos.map((r) => r.project)).toEqual(["storefront"]);
  });

  it("starts at once when Start is the captain's, else waits as one Start card for the owner", async () => {
    const captain = setup({ starts: "captain" });
    const a = await captain.engine.open(watchSource(captain.watchIncident()));
    expect(a.started).toBe(true);
    expect(captain.started).toEqual([a.task]);

    const owner = setup({ starts: "owner" });
    const b = await owner.engine.open(watchSource(owner.watchIncident()));
    expect(b.started).toBe(false);
    await owner.engine.sweep();
    const cards = owner.engine.decisions(() => "Acme");
    expect(cards.map((c) => c.title)).toEqual([expect.stringContaining(`Start incident ${b.task}`)]);
    expect(cards[0]?.options.map((o) => o.id)).toEqual(["start"]);
    await owner.engine.answer("start", b.task, "start");
    expect(owner.started).toEqual([b.task]);
  });

  it("with several projects and no evidence of which, asks the owner instead of guessing", async () => {
    const t = setup({ projects: ["storefront", "ledger"] });
    const out = await t.engine.open({
      kind: "client",
      org: "acme",
      room: "ACM-50",
      item: "m1",
      finding: 9,
      text: "server is down",
      facts: [],
    });
    expect(out.projectUnknown).toBe(true);
    await t.engine.sweep();
    const card = t.engine.decisions(() => undefined)[0];
    expect(card?.title).toContain("Which project");
    expect(card?.options.map((o) => o.id)).toEqual(["storefront", "ledger"]);
  });
});

describe("one incident, not two", () => {
  it("a client claim and a watch on the same project join the open incident", async () => {
    const t = setup();
    const first = await t.engine.open(watchSource(t.watchIncident()));
    const second = await t.engine.open({
      kind: "client",
      org: "acme",
      room: "ACM-50",
      item: "m1",
      finding: 9,
      project: "storefront",
      text: "server is down",
      facts: [],
    });
    expect(second.joined).toBe(true);
    expect(second.task).toBe(first.task);
    expect(t.store.tasks.list(true).filter((x) => x.typing?.type === "incident")).toHaveLength(1);
  });

  it("a watch firing again after its incident was closed opens that same task again", async () => {
    const t = setup();
    const inc = t.watchIncident();
    const first = await t.engine.open(watchSource(inc));
    t.store.raw.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first.task);
    const again = await t.engine.open(watchSource({ ...inc, flaps: 1 }));
    expect(again.joined).toBe(true);
    expect(again.task).toBe(first.task);
    expect(t.reopen).toHaveBeenCalledWith(first.task);
    // The finding keeps its task: no second fix task can appear.
    expect(t.findingTask.get(3)).toBe(first.task);
  });
});

describe("resolution", () => {
  it("closes the task only when the fix is live and the watch stayed green for the soak", async () => {
    const t = setup();
    const inc = t.watchIncident();
    const { task } = await t.engine.open(watchSource(inc));
    const at = (m: number) => new Date(t.clock.now.getTime() + m * MIN);
    // The fix is live at +20, the watch went green at +25: the soak ends at +40.
    t.deploy(task, "live", at(20));
    t.incidents.set(7, { ...inc, status: "resolved", resolvedAt: at(25).toISOString() });
    t.clock.now = at(30);
    await t.engine.sweep();
    expect(t.closed).toEqual([]);
    t.clock.now = at(41);
    await t.engine.sweep();
    expect(t.closed).toEqual([task]);
  });

  it("a watch that went green with nothing shipped stays open and asks the owner to close it", async () => {
    const t = setup();
    const inc = t.watchIncident();
    const { task } = await t.engine.open(watchSource(inc));
    t.incidents.set(7, {
      ...inc,
      status: "resolved",
      resolvedAt: new Date(t.clock.now.getTime() + 5 * MIN).toISOString(),
    });
    t.clock.now = new Date(t.clock.now.getTime() + 600 * MIN);
    await t.engine.sweep();
    expect(t.closed).toEqual([]);
    const card = t.engine.decisions(() => undefined).find((c) => c.id.startsWith("iask:recovered"));
    expect(card?.title).toContain("recovered on its own");
    expect(card?.options.map((o) => o.label)).toEqual(["Close: it recovered", "Let the lead continue"]);
    await t.engine.answer("recovered", task, "close");
    expect(t.closed).toEqual([task]);
    await t.engine.sweep();
    expect(t.engine.decisions(() => undefined).some((c) => c.id.startsWith("iask:recovered"))).toBe(false);
  });
});

describe("a paused watch", () => {
  it("is never a recovery: the incident stays open and no recovered card appears", async () => {
    const t = setup();
    const inc = t.watchIncident();
    await t.engine.open(watchSource(inc));
    t.incidents.set(7, {
      ...inc,
      status: "resolved",
      resolvedAt: new Date(t.clock.now.getTime() + 5 * MIN).toISOString(),
      timeline: [
        { at: t.clock.now.toISOString(), kind: "resolved", closedBy: "stopped", text: "You paused the watch." },
      ],
    });
    t.clock.now = new Date(t.clock.now.getTime() + 600 * MIN);
    await t.engine.sweep();
    expect(t.closed).toEqual([]);
    expect(t.engine.decisions(() => undefined).some((c) => c.id.startsWith("iask:recovered"))).toBe(false);
  });
});

describe("a failed deploy", () => {
  it("shows in Needs you with its reason until the owner has seen it", async () => {
    const t = setup({ starts: "captain" });
    const { task } = await t.engine.open({
      kind: "deploy",
      org: "acme",
      record: { id: 4, project: "storefront", env: "production" } as never,
      title: "Deploy failed",
      text: "x",
    });
    t.store.raw
      .prepare(
        `INSERT INTO deploys (id, org, project, env, commit_sha, state, task, by, reason, runs, seq, attempt, incident, created_at, updated_at)
         VALUES (4, 'acme', 'storefront', 'production', 'abcdef1234567', 'rolled-back', NULL, 'owner', 'The pipeline failed', '[]', 0, 1, ?, ?, ?)`,
      )
      .run(task, t.clock.now.toISOString(), t.clock.now.toISOString());
    const [card] = t.engine.decisions(() => undefined);
    expect(card?.title).toBe("Production deploy failed: The pipeline failed");
    expect(card?.sentence).toContain("rolled back");
    await t.engine.answer("deploy", "4", "ack");
    expect(t.engine.decisions(() => undefined)).toEqual([]);
    void (task as TaskId);
  });
});
