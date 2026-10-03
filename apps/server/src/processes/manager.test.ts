import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSpawner } from "@majhi/acp";
import type { ProcessInfo } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessManager } from "./manager.ts";
import { OutputTail, TAIL_BYTES, TAIL_LINES } from "./tail.ts";

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

const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

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

  it("wakes only on a natural exit of a wait process", async () => {
    await start("echo building; echo 'ready on http://localhost:5173/' >&2; exit 3");
    await until(() => ended.length === 1, "the exit");
    expect(ended[0]?.wakes).toBe(true);
    expect(ended[0]?.process).toMatchObject({ id: "p1", status: "exited", exitCode: 3, port: 5173 });
    expect(ended[0]?.process.tail).toEqual(["building", "ready on http://localhost:5173/"]);

    await start("exit 0", { wait: false });
    await until(() => ended.length === 2, "the wait: false exit");
    expect(ended[1]?.wakes).toBe(false);

    await start("sleep 30");
    expect(manager.waiting("ACM-1").map((p) => p.id)).toEqual(["p3"]);
    const stopped = await manager.stop("ACM-1", "p3", "agent");
    expect(stopped).toMatchObject({ status: "stopped", stoppedBy: "agent" });
    await start("sleep 31");
    await manager.stop("ACM-1", "p4", "owner");
    expect(ended.slice(2).map((e) => [e.process.id, e.process.stoppedBy, e.wakes])).toEqual([
      ["p3", "agent", false],
      ["p4", "owner", false],
    ]);
    expect(manager.waiting("ACM-1")).toEqual([]);
  });

  it("restarts under the same id without waking anyone", async () => {
    await start("echo one; sleep 30");
    await until(() => manager.get("ACM-1", "p1")?.tail[0] === "one", "output");
    const again = await manager.restart("ACM-1", "p1", "acme-lead");
    expect(again).toMatchObject({ id: "p1", status: "running", agent: "acme-lead" });
    expect(ended.map((e) => [e.process.stoppedBy, e.wakes])).toEqual([["agent", false]]);
  });

  it("counts an end as read only when its own agent saw it ended, until a restart", async () => {
    const p = await start("sleep 0.1; echo done");
    // Seen while it ran: the end is still news.
    manager.markRead("ACM-1", p, "acme-builder");
    await until(() => manager.get("ACM-1", "p1")?.status === "exited", "the end");
    const end = manager.get("ACM-1", "p1");
    if (end === undefined) throw new Error("no process");
    expect(manager.readAfterEnd(end)).toBe(false);
    manager.markRead("ACM-1", end, "acme-lead");
    expect(manager.readAfterEnd(end)).toBe(false);
    manager.markRead("ACM-1", end, "acme-builder");
    expect(manager.readAfterEnd(end)).toBe(true);

    const again = await manager.restart("ACM-1", "p1", "acme-builder");
    // The old run read is not the new run.
    manager.markRead("ACM-1", end, "acme-builder");
    await until(() => manager.get("ACM-1", "p1")?.status === "exited", "the second end");
    const second = manager.get("ACM-1", "p1");
    if (second === undefined) throw new Error("no process");
    expect(second.startedAt).toBe(again.startedAt);
    expect(manager.readAfterEnd(second)).toBe(false);
    expect(manager.readAfterEnd(end)).toBe(false);
  });

  it("stops a process whose start was still under way", async () => {
    let go: () => void = () => {};
    const gate = new Promise<void>((r) => {
      go = r;
    });
    const slow = new ProcessManager({
      spawner: async (req) => {
        await gate;
        return localSpawner(req);
      },
      launch: async () => ({
        folder,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        account: { tool: "claude", home: dir },
        mounts: [],
      }),
    });
    const starting = slow.start({ task: "ACM-1", agent: "acme-builder", command: "sleep 30", wait: true });
    await new Promise((r) => setTimeout(r, 20));
    const stopping = slow.stop("ACM-1", "p1", "owner");
    go();
    await starting;
    expect(await stopping).toMatchObject({ status: "stopped", stoppedBy: "owner" });
    expect(slow.running("ACM-1")).toEqual([]);
  });

  it("stops every process on close", async () => {
    await start("sleep 30");
    await start("sleep 31", { wait: false });
    await manager.start({ task: "ACM-2", agent: "acme-builder", command: "sleep 32", wait: true });
    await manager.stopTask("ACM-1");
    expect(manager.running("ACM-1")).toEqual([]);
    expect(manager.running("ACM-2")).toHaveLength(1);
    await manager.stopAll();
    expect(manager.running("ACM-2")).toEqual([]);
    expect(ended.every((e) => !e.wakes && e.process.status === "stopped")).toBe(true);
    expect(ended).toHaveLength(3);
  });

  it("keeps a bounded tail of a noisy process", async () => {
    await start("i=0; while [ $i -lt 1000 ]; do echo line $i; i=$((i+1)); done");
    await until(() => ended.length === 1, "the exit");
    const tail = manager.output("ACM-1", "p1", 500);
    expect(tail).toHaveLength(TAIL_LINES);
    expect(tail.at(-1)).toBe("line 999");
  });
});

describe("OutputTail", () => {
  it("caps lines and bytes, and keeps what follows a carriage return", () => {
    const tail = new OutputTail();
    tail.write("\u001b[32mgreen\u001b[0m\nprogress 10%\rprogress 100%\npart");
    expect(tail.last()).toEqual(["green", "progress 100%", "part"]);
    tail.write("ial\n");
    expect(tail.last(1)).toEqual(["partial"]);

    const big = "x".repeat(1024);
    for (let i = 0; i < 150; i++) tail.write(`${big}\n`);
    const kept = tail.last();
    expect(kept.length).toBeLessThan(TAIL_LINES);
    expect(kept.reduce((n, l) => n + l.length + 1, 0)).toBeLessThanOrEqual(TAIL_BYTES);

    tail.write("y".repeat(TAIL_BYTES * 2));
    expect(tail.last(1)[0]?.length).toBe(TAIL_BYTES);
  });
});
