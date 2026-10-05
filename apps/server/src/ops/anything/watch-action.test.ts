import { type AutomationAction, type ProcessInfo, WatchDefSchema } from "@majhi/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActionHost, ActionRunner } from "../../automation/actions.ts";
import { RunHistory } from "../../automation/history.ts";
import { type OpsWorld, opsWorld } from "../testing.ts";

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

const prints: string[] = ["file 10 1"];
let w: OpsWorld;

beforeEach(() => {
  processes.clear();
  started.length = 0;
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

  it("refuses an action that names another workspace's task, or holds a secret, when it is saved", async () => {
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: pathDef({ kind: "process.run", task: "GLX-1", command: "pnpm test" }),
      }),
    ).rejects.toThrow(/./);
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: pathDef({
          kind: "process.run",
          task: "ACM-9",
          command: "curl -H 'x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'",
        }),
      }),
    ).rejects.toThrow(/./);
    expect(started).toEqual([]);
  });

  it("refuses a path that leaves the project, and a project of another workspace", async () => {
    const def = pathDef(undefined);
    if (def.spec.kind !== "path") throw new Error("kind");
    await expect(
      w.ops.engine.save({ org: "acme", def: { ...def, spec: { ...def.spec, path: "../secrets" } } }),
    ).rejects.toThrow(/./);
    await expect(
      w.ops.engine.save({ org: "globex", def: { ...def, spec: { ...def.spec, project: "acme-api" } } }),
    ).rejects.toThrow(/./);
  });
});
