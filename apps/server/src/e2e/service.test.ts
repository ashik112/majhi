import { type E2eMode, type E2eRunResult, E2eSettingsSchema } from "@majhi/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { HostJobError, HostOfflineError } from "../host/link.ts";
import { Store } from "../store/index.ts";
import { E2eRepo } from "./repo.ts";
import { type E2eDeps, E2eService, taskOfSubject } from "./service.ts";

const PROJECT = { id: "majhi", org: "private", path: "/Users/owner/Work/majhi", base: "main", exists: true };
const green: E2eRunResult = {
  outcome: "passed",
  durationMs: 252_000,
  passed: 40,
  failed: 0,
  failedSpecs: [],
  traces: [],
};
const red = (specs: string[]): E2eRunResult => ({
  outcome: "failed",
  durationMs: 120_000,
  passed: 30,
  failed: specs.length,
  failedSpecs: specs,
  traces: [{ spec: specs[0] ?? "", file: "e2e/traces/r/1-a.zip" }],
});

interface World {
  service: E2eService;
  repo: E2eRepo;
  said: Array<{ task: string; level: string; text: string }>;
  created: Array<{ project: string; title: string; text: string; attachments: string[] }>;
  tip: { value: string };
  connected: { value: boolean };
  /** What the helper answers to each e2e.run call, in order. A function can hold the call. */
  answers: Array<E2eRunResult | Error | (() => Promise<E2eRunResult>)>;
  calls: Array<{ runId: string; repo: string; commit: string }>;
  /** `e2e.projects`. The world starts with majhi in `merge` mode. */
  modes: { value: Record<string, E2eMode> };
  schedule: { dailyAt: string; tz: string };
  clock: { value: Date };
}

function world(): World {
  const store = new Store(":memory:");
  const repo = new E2eRepo(store.raw);
  const w: World = {
    repo,
    said: [],
    created: [],
    tip: { value: "a".repeat(40) },
    connected: { value: true },
    answers: [],
    calls: [],
    modes: { value: { majhi: "merge" } },
    schedule: { dailyAt: "03:00", tz: "UTC" },
    clock: { value: new Date("2026-10-02T12:00:00.000Z") },
    service: undefined as unknown as E2eService,
  };
  let n = 0;
  const deps: E2eDeps = {
    repo,
    host: {
      isConnected: () => w.connected.value,
      call: async (_method, params) => {
        w.calls.push(params);
        const answer = w.answers.shift();
        if (answer === undefined) throw new Error("no answer planned");
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer() : answer;
      },
    },
    projects: async () => [PROJECT],
    settings: async () => ({ projects: w.modes.value, ...w.schedule }),
    git: {
      tip: async () => w.tip.value,
      subject: async (_p, commit) => `subject of ${commit.slice(0, 7)}`,
      between: async (_p, from, to) => [`${to.slice(0, 7)} newer`, `${from.slice(0, 7)} older`],
    },
    say: (task, _id, level, text) => w.said.push({ task, level, text }),
    taskExists: (id) => id.startsWith("PRV-"),
    createTask: async (input) => {
      w.created.push(input);
      return { id: `PRV-${100 + w.created.length}` };
    },
    uploadTrace: async () => "11111111-1111-4111-8111-111111111111",
    newId: () => `run-${++n}`,
    now: () => w.clock.value,
    log: () => undefined,
  };
  w.service = new E2eService(deps);
  return w;
}

const sha = (c: string) => c.repeat(40);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("background e2e", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("runs after a merge Ship made and tells the merging task in one quiet line", async () => {
    w.tip.value = sha("b");
    w.answers.push(green);
    await w.service.onMerged({ project: "majhi", task: "PRV-72", into: "main" });
    await settle();
    expect(w.calls).toEqual([{ runId: "run-1", repo: PROJECT.path, commit: sha("b"), timeoutMs: 5_400_000 }]);
    expect(w.repo.getRun("run-1")).toMatchObject({
      status: "passed",
      commit: sha("b"),
      task: "PRV-72",
      passed: 40,
    });
    expect(w.said).toEqual([
      {
        task: "PRV-72",
        level: "info",
        text: "Background e2e on majhi at bbbbbbb: passed (40 tests, 4m 12s).",
      },
    ]);
  });

  it("queues on merge only in merge mode, and only for a merge into the base branch", async () => {
    await w.service.onMerged({ project: "majhi", task: "PRV-72", into: "develop" });
    for (const mode of ["off", "daily"] as const) {
      w.modes.value = { majhi: mode };
      await w.service.onMerged({ project: "majhi", task: "PRV-72", into: "main" });
    }
    await settle();
    expect(w.repo.queued()).toEqual([]);
    expect(w.calls).toEqual([]);
    w.modes.value = { majhi: "merge" };
    w.answers.push(green);
    await w.service.onMerged({ project: "majhi", task: "PRV-72", into: "main" });
    await settle();
    expect(w.calls).toHaveLength(1);
  });

  it("is off by default for every project, majhi too: a merge queues nothing", async () => {
    w.modes.value = {};
    expect((await w.service.status()).projects).toEqual([{ id: "majhi", mode: "off" }]);
    w.tip.value = sha("1");
    await w.service.onMerged({ project: "majhi", task: "PRV-72", into: "main" });
    await w.service.tick();
    w.tip.value = sha("2");
    await w.service.tick();
    await settle();
    expect(w.repo.queued()).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  it("in daily mode runs once a day after daily_at, and only when the base tip moved", async () => {
    w.modes.value = { majhi: "daily" };
    w.tip.value = sha("1");
    // Before 03:00: nothing. A merge queues nothing either.
    w.clock.value = new Date("2026-10-02T02:59:00.000Z");
    await w.service.tick();
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();
    expect(w.repo.queued()).toEqual([]);
    expect(w.calls).toEqual([]);

    // After 03:00: one run at the tip.
    w.clock.value = new Date("2026-10-02T03:01:00.000Z");
    w.answers.push(green);
    await w.service.tick();
    await settle();
    expect(w.calls.map((c) => c.commit)).toEqual([sha("1")]);

    // The same day, even after a merge: no second run.
    w.tip.value = sha("2");
    w.clock.value = new Date("2026-10-02T15:00:00.000Z");
    await w.service.tick();
    await settle();
    expect(w.calls).toHaveLength(1);

    // The next day: the newest tip.
    w.clock.value = new Date("2026-10-03T03:00:00.000Z");
    w.answers.push(green);
    await w.service.tick();
    await w.service.tick();
    await settle();
    expect(w.calls.map((c) => c.commit)).toEqual([sha("1"), sha("2")]);

    // The day after, nothing merged: no run.
    w.clock.value = new Date("2026-10-04T04:00:00.000Z");
    await w.service.tick();
    await settle();
    expect(w.calls).toHaveLength(2);
    expect(w.repo.queued()).toEqual([]);
  });

  it("reads daily_at in the owner's zone", async () => {
    w.modes.value = { majhi: "daily" };
    // 03:00 in Tokyo (UTC+9) is 18:00 UTC the day before.
    w.schedule = { dailyAt: "03:00", tz: "Asia/Tokyo" };
    w.connected.value = false;
    w.clock.value = new Date("2026-10-02T17:59:00.000Z");
    await w.service.tick();
    expect(w.repo.queued()).toEqual([]);
    w.clock.value = new Date("2026-10-02T18:00:00.000Z");
    await w.service.tick();
    expect(w.repo.queued().map((r) => r.commit)).toEqual([sha("a")]);
  });

  it("runs now in any mode, and answers with the run already waiting at that commit", async () => {
    w.modes.value = {};
    w.connected.value = false;
    w.tip.value = sha("1");
    const first = await w.service.runNow("majhi");
    expect(first).toMatchObject({ queued: true, run: { id: "run-1", commit: sha("1"), status: "queued" } });
    const again = await w.service.runNow("majhi");
    expect(again).toMatchObject({ queued: false, run: { id: "run-1" } });
    expect(w.repo.queued()).toHaveLength(1);

    // A newer tip replaces the waiting run.
    w.tip.value = sha("2");
    expect(await w.service.runNow("majhi")).toMatchObject({ queued: true, run: { id: "run-2" } });
    expect(w.repo.getRun("run-1")?.status).toBe("replaced");

    // While it runs, Run now answers with it; once it finished, Run now runs that commit again.
    let finish: (r: E2eRunResult) => void = () => undefined;
    w.answers.push(
      () =>
        new Promise<E2eRunResult>((resolve) => {
          finish = resolve;
        }),
      green,
    );
    w.connected.value = true;
    await w.service.tick();
    await settle();
    expect(await w.service.runNow("majhi")).toMatchObject({
      queued: false,
      run: { id: "run-2", status: "running" },
    });
    finish(green);
    await settle();
    expect(await w.service.runNow("majhi")).toMatchObject({
      queued: true,
      run: { id: "run-3", commit: sha("2") },
    });
    await settle();
    expect(w.calls.map((c) => c.commit)).toEqual([sha("2"), sha("2")]);

    await expect(w.service.runNow("globex")).rejects.toThrow("There is no project globex.");
  });

  it("reads the old true or false switches of majhi.yaml as merge and off", () => {
    expect(E2eSettingsSchema.parse({ projects: { majhi: true, acme: false, globex: "daily" } })).toEqual({
      projects: { majhi: "merge", acme: "off", globex: "daily" },
      daily_at: "03:00",
    });
    expect(E2eSettingsSchema.safeParse({ projects: { acme: "weekly" } }).success).toBe(false);
    expect(E2eSettingsSchema.safeParse({ daily_at: "3am" }).success).toBe(false);
  });

  it("runs one at a time, and a newer merge replaces a queued run that has not started", async () => {
    let finish: (r: E2eRunResult) => void = () => undefined;
    w.answers.push(
      () =>
        new Promise<E2eRunResult>((resolve) => {
          finish = resolve;
        }),
      green,
    );
    w.tip.value = sha("1");
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();
    expect(w.repo.running()?.commit).toBe(sha("1"));
    // Two merges while the first runs: the second replaces the first's queued successor.
    w.tip.value = sha("2");
    await w.service.onMerged({ project: "majhi", task: "PRV-2", into: "main" });
    w.tip.value = sha("3");
    await w.service.onMerged({ project: "majhi", task: "PRV-3", into: "main" });
    expect(w.repo.queued().map((r) => r.commit)).toEqual([sha("3")]);
    expect(w.said).toContainEqual({
      task: "PRV-2",
      level: "info",
      text: "Background e2e at 2222222 did not start: 3333333 replaced it, and covers it.",
    });
    expect(w.calls).toHaveLength(1);

    finish(green);
    await settle();
    expect(w.calls.map((c) => c.commit)).toEqual([sha("1"), sha("3")]);
    expect(w.repo.getRun("run-2")?.status).toBe("replaced");
  });

  it("opens one task per break, with the specs, the last green commit and the trace", async () => {
    w.tip.value = sha("1");
    w.answers.push(green);
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();

    w.tip.value = sha("2");
    w.answers.push(red(["board.spec.ts > Board > shows a card", "room.spec.ts > sends"]));
    await w.service.onMerged({ project: "majhi", task: "PRV-2", into: "main" });
    await settle();
    expect(w.created).toHaveLength(1);
    const task = w.created[0];
    expect(task?.title).toBe("Fix e2e break on main: board.spec.ts");
    expect(task?.text).toContain("board.spec.ts > Board > shows a card");
    expect(task?.text).toContain("room.spec.ts > sends");
    expect(task?.text).toContain(`Last green commit: ${sha("1")}`);
    expect(task?.text).toContain("The merge that triggered the run: PRV-2.");
    expect(task?.attachments).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(w.said.find((s) => s.task === "PRV-2")?.text).toContain(
      "failed, 2 failing tests in 2m 0s. Fix task PRV-101.",
    );

    // Still red on the next merge: no second task, a line in the first.
    w.tip.value = sha("3");
    w.answers.push(red(["board.spec.ts > Board > shows a card"]));
    await w.service.onMerged({ project: "majhi", task: "PRV-3", into: "main" });
    await settle();
    expect(w.created).toHaveLength(1);
    expect(w.said).toContainEqual({
      task: "PRV-101",
      level: "warn",
      text: "Background e2e is still red at 3333333: 1 failing test.",
    });
    expect(w.repo.getRun("run-3")?.breakTask).toBe("PRV-101");

    // Green closes the break; red again is a new break and a new task.
    w.tip.value = sha("4");
    w.answers.push(green);
    await w.service.onMerged({ project: "majhi", task: "PRV-4", into: "main" });
    await settle();
    expect(w.said).toContainEqual({
      task: "PRV-101",
      level: "info",
      text: "Background e2e is green again at 4444444.",
    });
    expect(w.repo.openBreak("majhi")).toBeUndefined();
    w.tip.value = sha("5");
    w.answers.push(red(["a.spec.ts > x"]));
    await w.service.onMerged({ project: "majhi", task: "PRV-5", into: "main" });
    await settle();
    expect(w.created).toHaveLength(2);
    expect(w.created[1]?.text).toContain(`Last green commit: ${sha("4")}`);
  });

  it("opens no task when the suite could not run", async () => {
    w.answers.push({
      outcome: "errored",
      durationMs: 0,
      passed: 0,
      failed: 0,
      failedSpecs: [],
      traces: [],
      error: "pnpm install failed in the e2e worktree.",
    });
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();
    expect(w.created).toEqual([]);
    expect(w.repo.getRun("run-1")?.status).toBe("errored");
    expect(w.said[0]?.level).toBe("warn");
  });

  it("starts nothing while the helper is away, and runs when it is back", async () => {
    w.connected.value = false;
    w.answers.push(green);
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();
    expect(w.repo.queued()).toHaveLength(1);
    expect(w.calls).toEqual([]);
    w.connected.value = true;
    await w.service.tick();
    await settle();
    expect(w.calls).toHaveLength(1);
    expect(w.repo.getRun("run-1")?.status).toBe("passed");
  });

  it("puts a run back in the queue when the helper is still busy with an earlier one", async () => {
    w.answers.push(new HostJobError("An e2e run is already in progress on this computer."), green);
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();
    expect(w.repo.getRun("run-1")?.status).toBe("queued");
    await w.service.tick();
    await settle();
    expect(w.repo.getRun("run-1")?.status).toBe("passed");
  });

  it("records a helper that did not answer as errored", async () => {
    w.answers.push(new HostOfflineError("The host helper did not answer within 5460 seconds."));
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();
    expect(w.repo.getRun("run-1")).toMatchObject({
      status: "errored",
      error: "The host helper did not answer within 5460 seconds.",
    });
  });

  it("sees a merge it did not make: the first sight is a baseline, a moved tip queues a run", async () => {
    w.tip.value = sha("1");
    await w.service.tick();
    await settle();
    expect(w.repo.queued()).toEqual([]);
    expect(w.calls).toEqual([]);

    w.tip.value = sha("2");
    w.answers.push(green);
    await w.service.tick();
    await settle();
    expect(w.calls.map((c) => c.commit)).toEqual([sha("2")]);

    // A merge that names its task tells that task's room; the same tip again queues nothing.
    w.tip.value = sha("3");
    w.answers.push(green);
    await w.service.tick();
    await w.service.tick();
    await settle();
    expect(w.calls).toHaveLength(2);
  });

  it("reads the task of a merge commit from its subject", () => {
    expect(taskOfSubject("Merge branch 'task/prv-72-background-e2e' into main")).toBe("PRV-72");
    expect(taskOfSubject("Merge PRV-72: Background e2e")).toBeUndefined();
    expect(taskOfSubject("fix typo")).toBeUndefined();
  });

  it("answers status with the latest run per project, the run in progress and the queue", async () => {
    w.answers.push(green);
    await w.service.onMerged({ project: "majhi", task: "PRV-1", into: "main" });
    await settle();
    const status = await w.service.status();
    expect(status.latest.map((r) => [r.project, r.status])).toEqual([["majhi", "passed"]]);
    expect(status.recent).toHaveLength(1);
    expect(status.running).toBeUndefined();
    expect(status.queued).toEqual([]);
  });
});
