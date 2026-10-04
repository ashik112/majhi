import type { AutomationAction, PausedReason, ProcessInfo, ScheduleView, TaskStatus } from "@majhi/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../playbooks/catalog.ts";
import { createDb } from "../store/db.ts";
import type { ActionHost } from "./actions.ts";
import { type Automation, createAutomation } from "./index.ts";
import { MAX_WAIT_MS, type Timers } from "./scheduler.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Acme and Globex, each with a project and an agent. Tasks and processes are in memory. */
function fakeHost() {
  const tasks = new Map<string, { org: string; status: TaskStatus; pausedReason?: PausedReason }>();
  const processes = new Map<string, ProcessInfo>();
  let created = 0;
  const log = { started: [] as string[], posted: [] as string[], processes: [] as string[] };
  const host: ActionHost = {
    projects: async () => [
      { id: "acme-api", org: "acme", aliases: [] },
      { id: "globex-web", org: "globex", aliases: [] },
    ],
    agent: async (id) =>
      id === "acme-dev"
        ? { id, scope: "acme", where: ["anywhere"] }
        : id === "globex-dev"
          ? { id, scope: "globex", where: ["globex"] }
          : undefined,
    task: (id) => {
      const t = tasks.get(id);
      return t === undefined
        ? undefined
        : { id, org: t.org, status: t.status, pausedReason: t.pausedReason, team: ["acme-dev"] };
    },
    startTask: async ({ text }) => {
      const id = `ACM-${++created}`;
      tasks.set(id, { org: "acme", status: "running" });
      log.started.push(text.split("\n")[0] ?? "");
      return { id };
    },
    postToTask: async ({ task, text, from }) => {
      log.posted.push(`${task} ${from}: ${text}`);
    },
    startProcess: async ({ task, command }) => {
      const id = `p${processes.size + 1}`;
      processes.set(`${task}/${id}`, { id, task, status: "running", command } as ProcessInfo);
      log.processes.push(command);
      return { id };
    },
    process: (task, id) => processes.get(`${task}/${id}`),
  };
  return { host, tasks, processes, log };
}

const startTask: AutomationAction = {
  kind: "task.start",
  project: "acme-api",
  agent: "acme-dev",
  title: "Nightly check",
  text: "Run the checks and report.",
};

interface World {
  clock: { t: number };
  fake: ReturnType<typeof fakeHost>;
  auto: Automation;
  waits: number[];
}

let w: World;

beforeEach(() => {
  const clock = { t: Date.parse("2026-10-01T10:00:00Z") };
  const fake = fakeHost();
  fake.tasks.set("ACM-9", { org: "acme", status: "running" });
  fake.tasks.set("GLX-1", { org: "globex", status: "running" });
  const waits: number[] = [];
  const timers: Timers = { set: (_fn, ms) => waits.push(ms), clear: () => undefined };
  const { sqlite } = createDb(":memory:");
  const auto = createAutomation({
    db: sqlite,
    catalog: new Catalog(),
    host: fake.host,
    orgIds: async () => new Set(["private", "acme", "globex"]),
    changed: () => undefined,
    now: () => new Date(clock.t),
    timers,
  });
  w = { clock, fake, auto, waits };
});

const create = (
  over: Partial<Parameters<Automation["schedules"]["create"]>[0]> = {},
): Promise<ScheduleView> =>
  w.auto.schedules.create({
    org: "acme",
    name: "Nightly",
    phrase: "every 1 hour",
    action: startTask,
    overlap: "skip",
    ...over,
  });

const advance = async (ms: number) => {
  w.clock.t += ms;
  await w.auto.scheduler.tick();
};

describe("run loop", () => {
  it("runs an interval schedule when it is due, and counts the next slot from the run", async () => {
    const s = await create();
    expect(s.nextRunAt).toBe("2026-10-01T11:00:00.000Z");
    await advance(30 * MINUTE);
    expect(w.fake.log.started).toHaveLength(0);
    await advance(30 * MINUTE);
    expect(w.fake.log.started).toHaveLength(1);
    const after = await w.auto.schedules.get(s.id);
    expect(after.nextRunAt).toBe("2026-10-01T12:00:00.000Z");
    expect(after.lastRun?.status).toBe("running");
  });

  it("sleeps until the next run, but never longer than a minute", async () => {
    w.auto.scheduler.start();
    await w.auto.scheduler.tick();
    await create({ phrase: "every 3 hours" });
    expect(w.waits.at(-1)).toBe(MAX_WAIT_MS);
    await create({ spec: { kind: "once", at: "2026-10-01T10:00:20Z" }, name: "Soon" });
    expect(w.waits.at(-1)).toBe(20_000);
    w.auto.scheduler.stop();
  });

  it("runs a schedule that missed many slots once, then counts from now", async () => {
    const s = await create({ phrase: "every 15 minutes" });
    // Majhi was down for a day: ninety-six slots passed.
    w.clock.t += 24 * HOUR;
    w.auto.scheduler.start();
    await w.auto.scheduler.tick();
    w.auto.scheduler.stop();
    expect(w.fake.log.started).toHaveLength(1);
    expect(w.auto.runner.history.list("schedule", s.id, 10)).toHaveLength(1);
    expect((await w.auto.schedules.get(s.id)).nextRunAt).toBe("2026-10-02T10:15:00.000Z");
  });

  it("runs a cron schedule that missed slots once, on its next real slot afterwards", async () => {
    const s = await create({ phrase: "daily at 9:00", timeZone: "America/New_York" });
    expect(s.nextRunAt).toBe("2026-10-01T13:00:00.000Z");
    w.clock.t = Date.parse("2026-10-06T20:00:00Z");
    await w.auto.scheduler.tick();
    expect(w.fake.log.started).toHaveLength(1);
    expect((await w.auto.schedules.get(s.id)).nextRunAt).toBe("2026-10-07T13:00:00.000Z");
  });

  it("runs a one-off that is past due once and marks it done", async () => {
    const s = await create({ spec: { kind: "once", at: "2026-10-01T14:00" }, timeZone: "Europe/Berlin" });
    expect(s.nextRunAt).toBe("2026-10-01T12:00:00.000Z");
    await advance(HOUR);
    expect(w.fake.log.started).toHaveLength(0);
    // Majhi was down past the time: it runs once on startup.
    await advance(5 * HOUR);
    expect(w.fake.log.started).toHaveLength(1);
    await advance(5 * HOUR);
    expect(w.fake.log.started).toHaveLength(1);
    const after = await w.auto.schedules.get(s.id);
    expect(after.done).toBe(true);
    expect(after.nextRunAt).toBeNull();
    await expect(w.auto.schedules.resume(s.id)).rejects.toThrow(/already ran/);
  });

  it("does not run a paused schedule, and does not replay what it missed when resumed", async () => {
    const s = await create();
    await w.auto.schedules.pause(s.id);
    await advance(5 * HOUR);
    expect(w.fake.log.started).toHaveLength(0);
    const resumed = await w.auto.schedules.resume(s.id);
    expect(resumed.nextRunAt).toBe("2026-10-01T16:00:00.000Z");
    await w.auto.scheduler.tick();
    expect(w.fake.log.started).toHaveLength(0);
  });
});

describe("overlap", () => {
  it("skips a run while the task of the last run is not done, and records why", async () => {
    const s = await create();
    await advance(HOUR);
    await advance(HOUR);
    expect(w.fake.log.started).toHaveLength(1);
    const [skipped, first] = w.auto.runner.history.list("schedule", s.id, 10);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.endedAt).toBe(skipped?.startedAt);
    expect(skipped?.detail).toContain("still going");
    expect(first?.status).toBe("running");
    expect(first?.taskId).toBe("ACM-1");
  });

  it("runs again once the task is done, and ends the old run as ok", async () => {
    const s = await create();
    await advance(HOUR);
    w.fake.tasks.set("ACM-1", { org: "acme", status: "done" });
    await advance(HOUR);
    expect(w.fake.log.started).toHaveLength(2);
    const [second, first] = w.auto.runner.history.list("schedule", s.id, 10);
    expect(first).toMatchObject({ status: "ok", detail: "Task ACM-1 is done." });
    expect(second?.status).toBe("running");
  });

  it("lets the next run start when the task waits for the owner in review or an MR", async () => {
    const s = await create();
    await advance(HOUR);
    w.fake.tasks.set("ACM-1", { org: "acme", status: "review" });
    await advance(HOUR);
    w.fake.tasks.set("ACM-2", { org: "acme", status: "mr" });
    await advance(HOUR);
    expect(w.fake.log.started).toHaveLength(3);
    const [, second, first] = w.auto.runner.history.list("schedule", s.id, 10);
    expect(first).toMatchObject({ status: "ok", detail: "Task ACM-1 is in review." });
    expect(second).toMatchObject({ status: "ok", detail: "Task ACM-2 is in a merge request." });
  });

  it("ends a run as failed when its task paused on an error, and keeps other pauses going", async () => {
    const s = await create();
    await advance(HOUR);
    w.fake.tasks.set("ACM-1", { org: "acme", status: "paused", pausedReason: "limit" });
    await advance(HOUR);
    expect(w.fake.log.started).toHaveLength(1);
    expect((await w.auto.schedules.get(s.id)).lastRun?.status).toBe("skipped");
    w.fake.tasks.set("ACM-1", { org: "acme", status: "paused", pausedReason: "error" });
    await advance(HOUR);
    expect(w.fake.log.started).toHaveLength(2);
    expect(w.auto.runner.history.get(1)).toMatchObject({
      status: "failed",
      detail: "Task ACM-1 paused on an error.",
    });
  });

  it("lets runs overlap when the schedule allows it", async () => {
    const s = await create({ overlap: "allow" });
    await advance(HOUR);
    await advance(HOUR);
    await advance(HOUR);
    expect(w.fake.log.started).toHaveLength(3);
    expect(w.auto.runner.history.running({ kind: "schedule", id: s.id })).toHaveLength(3);
  });

  it("applies the rule to run now, and never counts a room post as still going", async () => {
    const s = await create();
    await w.auto.schedules.runNow(s.id);
    const again = await w.auto.schedules.runNow(s.id);
    expect(again.status).toBe("skipped");
    expect(w.fake.log.started).toHaveLength(1);

    const post = await create({
      name: "Ping",
      action: { kind: "room.post", task: "ACM-9", text: "Status?" },
    });
    expect((await w.auto.schedules.runNow(post.id)).status).toBe("ok");
    expect((await w.auto.schedules.runNow(post.id)).status).toBe("ok");
    expect(w.fake.log.posted).toEqual(["ACM-9 Ping: Status?", "ACM-9 Ping: Status?"]);
  });

  it("counts a process as going until it exits, and records its exit code", async () => {
    const s = await create({ action: { kind: "process.run", task: "ACM-9", command: "pnpm test" } });
    const first = await w.auto.schedules.runNow(s.id);
    expect(first).toMatchObject({ status: "running", taskId: "ACM-9", processId: "p1" });
    expect((await w.auto.schedules.runNow(s.id)).status).toBe("skipped");

    const p = w.fake.processes.get("ACM-9/p1");
    if (p !== undefined) Object.assign(p, { status: "exited", exitCode: 2 });
    const next = await w.auto.schedules.runNow(s.id);
    expect(next.status).toBe("running");
    expect(w.auto.runner.history.get(first.id)).toMatchObject({ status: "failed" });
    expect(w.auto.runner.history.get(first.id)?.detail).toContain("exited with 2");
  });

  it("ends a process run as failed when majhi restarted and the process is gone", async () => {
    const s = await create({ action: { kind: "process.run", task: "ACM-9", command: "pnpm test" } });
    const run = await w.auto.schedules.runNow(s.id);
    w.fake.processes.clear();
    await w.auto.runner.reconcile();
    expect(w.auto.runner.history.get(run.id)?.status).toBe("failed");
  });
});

describe("org boundaries", () => {
  it("refuses a target of another org when the schedule is saved", async () => {
    await expect(create({ action: { ...startTask, project: "globex-web" } })).rejects.toThrow(
      /belongs to org "globex"/,
    );
    await expect(create({ action: { ...startTask, agent: "globex-dev" } })).rejects.toThrow(/may not work/);
    await expect(create({ action: { kind: "room.post", task: "GLX-1", text: "Hi" } })).rejects.toThrow(
      /belongs to org "globex"/,
    );
    await expect(create({ action: { kind: "process.run", task: "GLX-1", command: "ls" } })).rejects.toThrow(
      /belongs to org "globex"/,
    );
  });

  it("checks again at run time and records a failed run without starting anything", async () => {
    const s = await create({ action: { kind: "room.post", task: "ACM-9", text: "Status?" } });
    // The task moved to another org after the schedule was saved.
    w.fake.tasks.set("ACM-9", { org: "globex", status: "running" });
    const run = await w.auto.schedules.runNow(s.id);
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("belongs to org");
    expect(w.fake.log.posted).toHaveLength(0);
  });

  it("refuses an action that holds a secret, without repeating it", async () => {
    const key = "sk-ant-api03-Zq8xV2mK9pL4nR7tY1wB5cD0eF3gH6jA";
    const attempts = [
      { ...startTask, text: `Deploy with ${key}` },
      { kind: "room.post", task: "ACM-9", text: `token ${key}` },
      {
        kind: "process.run",
        task: "ACM-9",
        command: `curl -H "Authorization: Bearer ${key}" https://example.com`,
      },
    ] as const;
    for (const action of attempts) {
      const err = await create({ action }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/looks like a secret/);
      expect((err as Error).message).not.toContain(key);
    }
  });

  it("takes task text that names another project: only the schedule's project joins the task", async () => {
    await expect(
      create({ action: { ...startTask, text: "Compare with globex-web." } }),
    ).resolves.toBeDefined();
  });
});

describe("history and views", () => {
  it("keeps every run, newest first, and shows the last one on the schedule", async () => {
    const s = await create({ overlap: "allow" });
    await advance(HOUR);
    await advance(HOUR);
    const runs = await w.auto.schedules.runs(s.id, 10);
    expect(runs.map((r) => r.id)).toEqual([2, 1]);
    expect(runs.every((r) => r.sourceKind === "schedule" && r.sourceId === s.id && r.org === "acme")).toBe(
      true,
    );
    const view = await w.auto.schedules.get(s.id);
    expect(view.lastRun?.id).toBe(2);
    expect(await w.auto.schedules.runs(s.id, 1)).toHaveLength(1);
  });

  it("records a failed start with its reason", async () => {
    const s = await create({ action: { kind: "process.run", task: "ACM-9", command: "pnpm test" } });
    w.fake.host.startProcess = async () => {
      throw new Error("This task already runs 5 processes");
    };
    const run = await w.auto.schedules.runNow(s.id);
    expect(run).toMatchObject({ status: "failed", detail: "This task already runs 5 processes" });
    expect(run.endedAt).not.toBeNull();
  });

  it("uses UTC when no time zone is sent, and shows the zone it used", async () => {
    const s = await create({ phrase: "daily at 18:30" });
    expect(s.timeZone).toBe("UTC");
    expect(s.nextRunAt).toBe("2026-10-01T18:30:00.000Z");
  });

  it("deletes a schedule with its history", async () => {
    const s = await create();
    await w.auto.schedules.runNow(s.id);
    await w.auto.schedules.delete(s.id);
    await expect(w.auto.schedules.get(s.id)).rejects.toThrow(/does not exist/);
    expect(w.auto.runner.history.list("schedule", s.id, 10)).toEqual([]);
  });
});
