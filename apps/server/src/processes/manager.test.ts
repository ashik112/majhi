import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSpawner, type SpawnRequest } from "@majhi/acp";
import type { ProcessInfo } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { until } from "../testing/until.ts";
import { ProcessManager } from "./manager.ts";

let dir: string;
let folder: string;
let manager: ProcessManager;
let ended: { process: ProcessInfo; wakes: boolean }[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "majhi-proc-"));
  folder = join(dir, "ACM-1");
  await mkdir(join(folder, "api"), { recursive: true });
  ended = [];
  manager = new ProcessManager({
    spawner: localSpawner,
    launch: async () => ({
      folder,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      account: { tool: "claude", home: join(dir, "home") },
      mounts: [],
    }),
    onEnded: (p, wakes) => ended.push({ process: p, wakes }),
    throttleMs: 10,
  });
});

afterEach(async () => {
  await manager.stopAll();
  await rm(dir, { recursive: true, force: true });
});

const start = (command: string, more: { wait?: boolean; cwd?: string; agent?: string } = {}) =>
  manager.start({
    task: "ACM-1",
    agent: more.agent ?? "acme-builder",
    command,
    wait: more.wait ?? true,
    cwd: more.cwd,
  });

describe("ProcessManager", () => {
  it("allows five running processes per task and refuses a second copy of one", async () => {
    for (let i = 0; i < 5; i++) await start(`sleep 30 # ${i}`);
    await expect(start("sleep 30 # 5")).rejects.toThrow(/already runs 5 processes/);
    // Another task has its own limit.
    const other = await manager.start({
      task: "ACM-2",
      agent: "acme-builder",
      command: "sleep 30",
      wait: false,
    });
    expect(other.id).toBe("p1");

    await manager.stop("ACM-1", "p1", "agent");
    await expect(start("sleep 30 # 1")).rejects.toThrow(/p2 already runs `sleep 30 # 1`/);
    // The same command in another folder is not a copy. Ids are never reused.
    const again = await start("sleep 30 # 1", { cwd: "api" });
    expect(again.id).toBe("p6");
    expect(again.cwd).toBe(join(folder, "api"));
  });

  it("runs only inside the task folder", async () => {
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(folder, "escape"));
    for (const cwd of ["..", "../outside", join(dir, "outside"), "/", "api/../../outside", "escape"]) {
      await expect(start("true", { cwd }), cwd).rejects.toThrow(/outside the task folder/);
    }
    await expect(start("true", { cwd: "missing" })).rejects.toThrow(/not a folder/);
    expect((await start("pwd", { cwd: join(folder, "api") })).cwd).toBe(join(folder, "api"));
    await until(() => manager.list("ACM-1")[0]?.status === "exited", "pwd to exit");
    expect(manager.list("ACM-1")).toHaveLength(1);
  });
});

describe("a process on the task's network", () => {
  function managerWith(
    network: ((task: string) => Promise<boolean>) | undefined,
    seen: SpawnRequest[],
    nameTaken?: (task: string, name: string) => Promise<boolean>,
  ) {
    return new ProcessManager({
      spawner: (req) => {
        seen.push(req);
        return localSpawner(req);
      },
      launch: async () => ({
        folder,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        account: { tool: "claude", home: join(dir, "home") },
        mounts: [],
      }),
      ...(network === undefined ? {} : { network }),
      ...(nameTaken === undefined ? {} : { nameTaken }),
      throttleMs: 10,
    });
  }

  it("joins the network without a name that a container or majhi already has", async () => {
    const seen: SpawnRequest[] = [];
    const m = managerWith(
      async () => true,
      seen,
      async (_task, name) => name === "preview" || name === "db",
    );
    for (const name of ["preview", "db", "web"]) {
      await m.start({
        task: "ACM-1",
        agent: "acme-builder",
        command: `sleep 5 # ${name}`,
        name,
        wait: false,
      });
    }
    expect(seen.map((r) => r.networkAlias)).toEqual([undefined, undefined, "web"]);
    await m.stopAll();
  });
});
