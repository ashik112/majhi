import { type AutomationAction, type ProcessInfo, WatchDefSchema } from "@majhi/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActionHost, ActionRunner } from "../../automation/actions.ts";
import { RunHistory } from "../../automation/history.ts";
import { MIN, type OpsWorld, opsWorld } from "../testing.ts";

/** A watch's action is run by the same guarded runner schedules use: the owner's boundaries hold. */

const processes = new Map<string, ProcessInfo>();
const started: string[] = [];

const host: ActionHost = {
  resumeLimited: async () => [],
  projects: async () => [{ id: "acme-api", org: "acme", aliases: [] }],
  agent: async () => undefined,
  task: (id) =>
    id === "ACM-9"
      ? { id, org: "acme", status: "running", pausedReason: undefined, team: ["acme-dev"] }
      : id === "GLX-1"
        ? { id, org: "globex", status: "running", pausedReason: undefined, team: ["globex-dev"] }
        : undefined,
  startTask: async () => ({ id: "ACM-10" }),
  postToTask: async () => undefined,
  startProcess: async ({ task, command }) => {
    started.push(command);
    const id = `p${started.length}`;
    processes.set(`${task}/${id}`, { id, task, status: "running", command } as ProcessInfo);
    return { id };
  },
  process: (task, id) => processes.get(`${task}/${id}`),
};

let prints: string[] = [];
let w: OpsWorld;

beforeEach(() => {
  processes.clear();
  started.length = 0;
  prints = ["file 10 1"];
});

function pathDef(action: AutomationAction | undefined) {
  return WatchDefSchema.parse({
    name: "Acme docs",
    spec: { kind: "path", project: "acme-api", path: "docs" },
    condition: { type: "changed" },
    everyMin: 1,
    fire: { alert: { on: false, phone: false }, ...(action === undefined ? {} : { run: action }) },
  });
}

const runTests: AutomationAction = { kind: "process.run", task: "ACM-9", command: "pnpm test" };

async function look(minutes = 1): Promise<void> {
  w.advance(minutes * MIN);
  await w.ops.engine.tick();
}

describe("a watch that runs a process when a path changes", () => {
  beforeEach(() => {
    const first = opsWorld();
    w = opsWorld({
      db: first.db,
      wiring: {
        projectCheckout: async (id) =>
          id === "acme-api" ? { org: "acme", path: "/Users/owner/acme-api" } : undefined,
        watchPorts: { pathPrint: async () => prints[0] ?? "missing" },
        action: (() => {
          const history = new RunHistory(first.db);
          const runner = new ActionRunner(host, history);
          return {
            validate: (org: string, action: AutomationAction) => runner.validate(org, action),
            run: (...args: Parameters<ActionRunner["run"]>) => runner.run(...args),
            runs: (id: string, limit: number) => history.list("watch", id, limit),
            forget: (id: string) => history.deleteFor("watch", id),
          };
        })(),
      },
    });
  });

  it("fires once per change, never on the first look, and records the run on the watch", async () => {
    const view = await w.ops.engine.save({ org: "acme", def: pathDef(runTests) });
    expect(started).toEqual([]);
    await look();
    expect(started).toEqual([]);
    prints = ["file 11 2"];
    await look();
    expect(started).toEqual(["pnpm test"]);
    // Nothing new: no second run, and no incident was opened for it.
    await look();
    expect(started).toHaveLength(1);
    expect(w.ops.watch.openIncidents()).toEqual([]);
    const after = (await w.ops.engine.overview("acme")).watches.find((x) => x.id === view.id);
    expect(after?.runs.map((r) => r.status)).toEqual(["running"]);
    expect(after?.runs[0]?.processId).toBe("p1");
  });

  it("skips a change while the last run still goes, and says so", async () => {
    const view = await w.ops.engine.save({ org: "acme", def: pathDef(runTests) });
    await look();
    prints = ["file 11 2"];
    await look();
    prints = ["file 12 3"];
    await look();
    expect(started).toHaveLength(1);
    const runs = (await w.ops.engine.overview("acme")).watches.find((x) => x.id === view.id)?.runs ?? [];
    expect(runs.map((r) => r.status)).toEqual(["skipped", "running"]);
  });

  it("refuses an action that names another workspace's task, or holds a secret, when it is saved", async () => {
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: pathDef({ kind: "process.run", task: "GLX-1", command: "pnpm test" }),
      }),
    ).rejects.toThrow(/belongs to org/);
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: pathDef({
          kind: "process.run",
          task: "ACM-9",
          command: "curl -H 'x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'",
        }),
      }),
    ).rejects.toThrow(/secret/);
    expect(started).toEqual([]);
  });

  it("refuses a path that leaves the project, and a project of another workspace", async () => {
    const def = pathDef(undefined);
    if (def.spec.kind !== "path") throw new Error("kind");
    await expect(
      w.ops.engine.save({ org: "acme", def: { ...def, spec: { ...def.spec, path: "../secrets" } } }),
    ).rejects.toThrow(/inside the project/);
    await expect(
      w.ops.engine.save({ org: "globex", def: { ...def, spec: { ...def.spec, project: "acme-api" } } }),
    ).rejects.toThrow(/another workspace/);
  });
});
