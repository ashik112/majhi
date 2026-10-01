import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutomationAction,
  type PausedReason,
  type ProcessInfo,
  parseTaskText,
  type TaskStatus,
  type TriggerCreateInput,
  type UsageTotals,
} from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../store/db.ts";
import type { ActionHost } from "../actions.ts";
import { type Automation, createAutomation } from "../index.ts";
import { TICK_MS, withEvent } from "./engine.ts";
import type { WatchHost } from "./observe.ts";
import { pathPrint } from "./probe.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

interface FakeTask {
  org: string;
  status: TaskStatus;
  pausedReason?: PausedReason;
  mr?: {
    number: number;
    state: "open" | "merged" | "closed";
    ci: "none" | "pending" | "passing" | "failing";
  };
}

/** Acme and Globex in memory: tasks, processes, a branch, a path, a page and a usage figure. */
function fakeWorld() {
  const tasks = new Map<string, FakeTask>([
    ["ACM-1", { org: "acme", status: "running" }],
    ["ACM-2", { org: "acme", status: "running" }],
    ["GLX-1", { org: "globex", status: "running" }],
  ]);
  const processes = new Map<string, ProcessInfo>();
  const projects = [
    { id: "acme-api", org: "acme", path: "/work/acme-api" },
    { id: "globex-web", org: "globex", path: "/work/globex-web" },
  ];
  const state = {
    branch: "a1b2c3d4e5" as string | undefined,
    path: "file 10 1",
    page: "200 aaaa",
    cost: 0,
    failUrl: false,
  };
  const log = { started: [] as string[], posted: [] as string[], commands: [] as string[] };
  let created = 0;
  const actionHost: ActionHost = {
    projects: async () => projects.map((p) => ({ id: p.id, org: p.org, aliases: [] })),
    agent: async (id) => (id === "acme-dev" ? { id, scope: "acme", where: ["anywhere"] } : undefined),
    task: (id) => {
      const t = tasks.get(id);
      return t === undefined
        ? undefined
        : { id, org: t.org, status: t.status, pausedReason: t.pausedReason, team: ["acme-dev"] };
    },
    startTask: async ({ text }) => {
      const id = `ACM-${10 + ++created}`;
      tasks.set(id, { org: "acme", status: "running" });
      log.started.push(text);
      return { id };
    },
    postToTask: async ({ task, text }) => {
      log.posted.push(`${task}: ${text}`);
    },
    startProcess: async ({ task, command }) => {
      const id = `p${processes.size + 1}`;
      processes.set(`${task}/${id}`, {
        id,
        task,
        name: command,
        status: "running",
        command,
        tail: [],
      } as unknown as ProcessInfo);
      log.commands.push(command);
      return { id };
    },
    process: (task, id) => processes.get(`${task}/${id}`),
  };
  const watch: WatchHost = {
    projects: async () => projects,
    tasks: () =>
      [...tasks].map(([id, t]) => ({
        id,
        org: t.org,
        status: t.status,
        pausedReason: t.pausedReason,
        mrs: () => (t.mr === undefined ? [] : [{ project: "acme-api", mr: { url: "u", ...t.mr } }]),
      })),
    processes: (task) => [...processes.values()].filter((p) => p.task === task),
    process: (task, id) => processes.get(`${task}/${id}`),
    usage: () => ({ costUsd: state.cost, totalTokens: 0 }) as UsageTotals,
    branchTip: async () => state.branch,
    pathPrint: async () => state.path,
    urlPrint: async () => {
      if (state.failUrl) throw new Error("connect ECONNREFUSED");
      return state.page;
    },
    startProcess: (input) => actionHost.startProcess(input),
  };
  return { tasks, processes, projects, state, log, actionHost, watch };
}

type World = ReturnType<typeof fakeWorld>;

const post = (text = "{{event}}"): AutomationAction => ({ kind: "room.post", task: "ACM-1", text });
const startTask: AutomationAction = {
  kind: "task.start",
  project: "acme-api",
  agent: "acme-dev",
  title: "Follow up",
  text: "Look into it: {{event}}",
};

let clock: { t: number };
let world: World;
let sqlite: ReturnType<typeof createDb>["sqlite"];

function build(): Automation {
  return createAutomation({
    db: sqlite,
    host: world.actionHost,
    watch: world.watch,
    orgIds: async () => new Set(["private", "acme", "globex"]),
    changed: () => undefined,
    triggersChanged: () => undefined,
    now: () => new Date(clock.t),
    timers: { set: () => undefined, clear: () => undefined },
  });
}

let auto: Automation;

beforeEach(() => {
  clock = { t: Date.parse("2026-10-01T10:00:00Z") };
  world = fakeWorld();
  sqlite = createDb(":memory:").sqlite;
  auto = build();
});

const create = async (over: Partial<TriggerCreateInput> = {}) => {
  const trigger = await auto.triggers.create({
    org: "acme",
    name: "Watch",
    watch: { kind: "task.status", task: "ACM-1", to: "done" },
    action: post(),
    overlap: "skip",
    settleSeconds: 0,
    cooldownSeconds: 0,
    ...over,
  });
  await auto.triggerEngine.tick(); // the first look
  return trigger;
};

const advance = async (ms: number) => {
  clock.t += ms;
  await auto.triggerEngine.tick();
};

describe("a task status watch", () => {
  it("does not fire for what was already so, and fires once when the task turns done", async () => {
    world.tasks.set("ACM-1", { org: "acme", status: "done" });
    await create();
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(0);

    world.tasks.set("ACM-1", { org: "acme", status: "running" });
    await advance(MINUTE);
    world.tasks.set("ACM-1", { org: "acme", status: "done" });
    await advance(MINUTE);
    expect(world.log.posted).toEqual(["ACM-1: task ACM-1 reached done"]);
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(1);
  });

  it("watches every task of its org, and none of another", async () => {
    await create({ watch: { kind: "task.status", to: "needs-you" } });
    world.tasks.set("GLX-1", { org: "globex", status: "review" });
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(0);
    world.tasks.set("ACM-2", { org: "acme", status: "review" });
    await advance(MINUTE);
    expect(world.log.posted).toEqual(["ACM-1: task ACM-2 reached needs-you"]);
  });

  it("counts a task paused on an error as failed, and as needing the owner", async () => {
    await create({ watch: { kind: "task.status", task: "ACM-2", to: "failed" } });
    await create({ watch: { kind: "task.status", task: "ACM-2", to: "needs-you" }, name: "Needs" });
    world.tasks.set("ACM-2", { org: "acme", status: "paused", pausedReason: "limit" });
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(1);
    world.tasks.set("ACM-2", { org: "acme", status: "paused", pausedReason: "error" });
    await advance(MINUTE);
    // `failed` fires now; `needs-you` was on already.
    expect(world.log.posted).toHaveLength(2);
  });
});

describe("cooldown", () => {
  it("holds a change that comes too soon and fires it once when the cooldown is over", async () => {
    const t = await create({
      watch: { kind: "branch.changed", project: "acme-api", branch: "main" },
      cooldownSeconds: 300,
    });
    world.state.branch = "bbbbbbbb11";
    await advance(MINUTE);
    expect(world.log.posted).toEqual(["ACM-1: ref main moved to bbbbbbbb"]);

    // Three more moves inside the cooldown fire nothing, and the trigger shows it waits.
    for (const tip of ["cccccccc22", "dddddddd33", "eeeeeeee44"]) {
      world.state.branch = tip;
      await advance(30 * SECOND);
    }
    expect(world.log.posted).toHaveLength(1);
    expect((await auto.triggers.get(t.id)).pending).toBe(true);

    await advance(5 * MINUTE);
    expect(world.log.posted).toHaveLength(2);
    expect(world.log.posted[1]).toBe("ACM-1: ref main moved to eeeeeeee");
    expect((await auto.triggers.get(t.id)).pending).toBe(false);
    await advance(10 * MINUTE);
    expect(world.log.posted).toHaveLength(2);
  });

  it("forgets a change that undid itself during the cooldown", async () => {
    await create({
      watch: { kind: "url.changed", url: "https://status.example.com" },
      cooldownSeconds: 300,
      pollSeconds: 60,
    });
    world.state.page = "200 bbbb";
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(1);
    world.state.page = "500 cccc";
    await advance(MINUTE);
    world.state.page = "200 bbbb";
    await advance(10 * MINUTE);
    expect(world.log.posted).toHaveLength(1);
  });
});

describe("settle time", () => {
  it("fires only after a change has held still", async () => {
    await create({
      watch: { kind: "path.changed", project: "acme-api", path: "src" },
      settleSeconds: 60,
      pollSeconds: 30,
    });
    world.state.path = "dir 3 aaa";
    await advance(30 * SECOND);
    world.state.path = "dir 4 bbb"; // still being written
    await advance(30 * SECOND);
    world.state.path = "dir 5 ccc";
    await advance(30 * SECOND);
    expect(world.log.posted).toHaveLength(0);
    await advance(30 * SECOND);
    expect(world.log.posted).toHaveLength(0);
    await advance(30 * SECOND);
    expect(world.log.posted).toEqual(["ACM-1: path src changed"]);
  });
});

describe("restarts and pauses", () => {
  it("fires once for a change made while majhi was down, and never twice", async () => {
    await create({ watch: { kind: "branch.changed", project: "acme-api", branch: "main" } });
    auto.triggerEngine.stop();

    // A new process over the same database: the baseline comes from it.
    world.state.branch = "ffffffff55";
    clock.t += 3 * 60 * MINUTE;
    auto = build();
    await auto.triggerEngine.tick();
    expect(world.log.posted).toHaveLength(1);
    auto = build();
    await auto.triggerEngine.tick();
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(1);
  });

  it("does not fire for what changed while it was paused", async () => {
    const t = await create({ watch: { kind: "branch.changed", project: "acme-api", branch: "main" } });
    await auto.triggers.pause(t.id);
    world.state.branch = "99999999aa";
    await advance(MINUTE);
    await auto.triggers.resume(t.id);
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(0);
    world.state.branch = "88888888bb";
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(1);
  });
});

describe("overlap", () => {
  it("skips a firing while the task it started still goes, and records why", async () => {
    const t = await create({
      watch: { kind: "branch.changed", project: "acme-api", branch: "main" },
      action: startTask,
    });
    world.state.branch = "11111111aa";
    await advance(MINUTE);
    world.state.branch = "22222222bb";
    await advance(MINUTE);
    expect(world.log.started).toHaveLength(1);
    const runs = await auto.triggers.runs(t.id, 10);
    expect(runs.map((r) => r.status)).toEqual(["skipped", "running"]);
    expect(runs[0]?.detail).toContain("still going");

    // The started task is done: the next firing runs.
    world.tasks.set("ACM-11", { org: "acme", status: "done" });
    world.state.branch = "33333333cc";
    await advance(MINUTE);
    expect(world.log.started).toHaveLength(2);
  });

  it("lets firings overlap when the trigger allows it", async () => {
    await create({
      watch: { kind: "branch.changed", project: "acme-api", branch: "main" },
      action: startTask,
      overlap: "allow",
    });
    world.state.branch = "11111111aa";
    await advance(MINUTE);
    world.state.branch = "22222222bb";
    await advance(MINUTE);
    expect(world.log.started).toHaveLength(2);
  });
});

describe("secrets", () => {
  it("refuses a watched command that holds a secret", async () => {
    await expect(
      create({
        watch: {
          kind: "command.changed",
          task: "ACM-1",
          command: "curl -H 'x-key: sk-ant-api03-Zq8xV2mK9pL4nR7tY1wB5cD0eF3gH6jA' https://example.com",
        },
      }),
    ).rejects.toThrow(/looks like a secret/);
  });
});

describe("org boundaries", () => {
  it("refuses to save a watch or an action that names another org", async () => {
    await expect(create({ watch: { kind: "task.status", task: "GLX-1", to: "done" } })).rejects.toThrow(
      /belongs to org "globex"/,
    );
    await expect(
      create({ watch: { kind: "branch.changed", project: "globex-web", branch: "main" } }),
    ).rejects.toThrow(/belongs to org "globex"/);
    await expect(create({ action: { kind: "room.post", task: "GLX-1", text: "hi" } })).rejects.toThrow(
      /belongs to org "globex"/,
    );
  });

  it("stops looking, and shows why, when a project moves to another org", async () => {
    const t = await create({ watch: { kind: "branch.changed", project: "acme-api", branch: "main" } });
    const project = world.projects[0];
    if (project === undefined) throw new Error("no project");
    project.org = "globex";
    world.state.branch = "44444444dd";
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(0);
    expect((await auto.triggers.get(t.id)).checkError).toContain('belongs to org "globex"');
  });

  it("does not fire when a look fails, and fires after it works again", async () => {
    const t = await create({
      watch: { kind: "url.changed", url: "https://status.example.com" },
      pollSeconds: 60,
    });
    world.state.failUrl = true;
    world.state.page = "200 bbbb";
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(0);
    expect((await auto.triggers.get(t.id)).checkError).toContain("ECONNREFUSED");
    world.state.failUrl = false;
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(1);
    expect((await auto.triggers.get(t.id)).checkError).toBeNull();
  });
});

describe("other watches", () => {
  it("fires once each time usage crosses the limit", async () => {
    await create({
      watch: { kind: "usage.over", metric: "costUsd", period: "month", limit: 50 },
    });
    world.state.cost = 49;
    await advance(MINUTE);
    world.state.cost = 51;
    await advance(MINUTE);
    world.state.cost = 60;
    await advance(MINUTE);
    expect(world.log.posted).toEqual(["ACM-1: cost this month is 51.00, above 50"]);
    world.state.cost = 0; // a new month
    await advance(MINUTE);
    world.state.cost = 52;
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(2);
  });

  it("fires for a process that fails, not one that succeeds", async () => {
    const proc = (id: string, over: Partial<ProcessInfo>) =>
      world.processes.set(`ACM-1/${id}`, {
        id,
        task: "ACM-1",
        name: id,
        status: "running",
        tail: [],
        ...over,
      } as ProcessInfo);
    proc("p1", {});
    proc("p2", {});
    await create({ watch: { kind: "process.exit", task: "ACM-1", on: "failure" } });
    proc("p1", { status: "exited", exitCode: 0 });
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(0);
    proc("p2", { status: "exited", exitCode: 2 });
    await advance(MINUTE);
    expect(world.log.posted).toEqual(["ACM-1: process p2 of ACM-1 exited with code 2"]);
  });

  it("fires when a merge request opens or its checks change", async () => {
    await create({ watch: { kind: "mr.changed", task: "ACM-2" } });
    world.tasks.set("ACM-2", { org: "acme", status: "mr", mr: { number: 7, state: "open", ci: "pending" } });
    await advance(MINUTE);
    expect(world.log.posted).toEqual(["ACM-1: merge request 7 in task ACM-2 is open, checks pending"]);
    world.tasks.set("ACM-2", { org: "acme", status: "mr", mr: { number: 7, state: "open", ci: "passing" } });
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(2);
  });

  it("runs a command as a process and fires when its output changes", async () => {
    await create({
      watch: { kind: "command.changed", task: "ACM-1", command: "git status --short" },
      pollSeconds: 60,
    });
    const finish = (tail: string[]) => {
      const proc = [...world.processes.values()].at(-1);
      if (proc === undefined) throw new Error("no process");
      world.processes.set(`ACM-1/${proc.id}`, { ...proc, status: "exited", exitCode: 0, tail });
    };
    // The first look starts the command; the next one reads it and sets the baseline.
    expect(world.log.commands).toHaveLength(1);
    finish([" M a.ts"]);
    await advance(MINUTE);
    await advance(MINUTE); // starts it again
    finish([" M a.ts"]);
    await advance(MINUTE);
    expect(world.log.posted).toHaveLength(0);
    await advance(MINUTE);
    finish([" M a.ts", " M b.ts"]);
    await advance(MINUTE);
    expect(world.log.posted).toEqual(["ACM-1: output of the command in ACM-1 changed"]);
  });
});

describe("the event line", () => {
  it("never changes what the task parser reads from a started task's text", () => {
    const ctx = {
      projects: [
        { id: "acme-api", org: "acme", aliases: [] },
        { id: "globex-web", org: "globex", aliases: [] },
      ],
      agents: [{ id: "acme-dev" }],
    };
    const lines = [
      "ref feature/on-call_fix moved to a1b2c3d4",
      "path docs/from_here_base.md changed",
      "merge request 7 in task ACM-2 is open, checks pending",
      "process p2 of ACM-1 exited with code 2",
      "cost this month is 51.00, above 50",
    ];
    if (startTask.kind !== "task.start") throw new Error("not a task action");
    const plain = parseTaskText(`${startTask.title}\n\nLook into it: \n\nProject: acme-api`, ctx);
    for (const line of lines) {
      const filled = withEvent(startTask, line);
      if (filled.kind !== "task.start") throw new Error("not a task action");
      const parsed = parseTaskText(`${filled.title}\n\n${filled.text}\n\nProject: ${filled.project}`, ctx);
      expect(parsed.repos).toEqual(plain.repos);
      expect(parsed.warnings).toEqual(plain.warnings);
    }
  });

  it("is never put into a command", () => {
    const action: AutomationAction = { kind: "process.run", task: "ACM-1", command: "echo {{event}}" };
    expect(withEvent(action, "x; rm -rf /")).toEqual(action);
  });
});

describe("path fingerprint", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-path-"));
    await mkdir(join(dir, "project", "src"), { recursive: true });
    await writeFile(join(dir, "project", "src", "a.ts"), "one");
    await writeFile(join(dir, "secret.txt"), "outside");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("changes with a file, and says when it is gone", async () => {
    const root = join(dir, "project");
    const before = await pathPrint(root, "src");
    await writeFile(join(root, "src", "b.ts"), "two");
    expect(await pathPrint(root, "src")).not.toBe(before);
    expect(await pathPrint(root, "nope")).toBe("missing");
  });

  it("refuses a path that leaves the project, by dots or by a link", async () => {
    const root = join(dir, "project");
    await expect(pathPrint(root, "../secret.txt")).rejects.toThrow(/outside the project/);
    await symlink(join(dir, "secret.txt"), join(root, "link.txt"));
    await expect(pathPrint(root, "link.txt")).rejects.toThrow(/outside the project/);
  });
});

describe("the engine's pace", () => {
  it("looks at a trigger no more often than its interval", async () => {
    await create({ watch: { kind: "branch.changed", project: "acme-api", branch: "main" } });
    world.state.branch = "55555555ee";
    await advance(TICK_MS); // the default is 30 seconds
    expect(world.log.posted).toHaveLength(0);
    await advance(30 * SECOND);
    expect(world.log.posted).toHaveLength(1);
  });
});
