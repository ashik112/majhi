import { symlink } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEnv } from "@majhi/acp";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";
import { TerminalManager } from "./manager.ts";
import { openTaskTerminal, taskFolder, taskTerminalEnv, taskTerminalKey } from "./task-terminal.ts";

const BASE: BaseEnv = { PATH: "/usr/bin:/bin" };

const until = async (check: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe("the task terminal environment", () => {
  it("holds PATH, HOME, TERM and LANG only", () => {
    expect(taskTerminalEnv({ ...BASE, TMPDIR: "/var/x", PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" })).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    });
  });
});

describe("one shell per task", () => {
  let w: World | undefined;
  let terminals: TerminalManager | undefined;
  afterEach(async () => {
    terminals?.closeAll();
    await w?.cleanup();
    w = undefined;
  });

  async function setup() {
    w = await taskWorld();
    const { h } = w;
    const created = await h.cmd("tasks.create", { text: "fix api", start: false });
    expect(created.status).toBe(200);
    const services = h.majhi.services;
    return { h, services, task: created.body as Task };
  }

  it("opening again while the shell runs returns the same terminal; after it exits, a new one", async () => {
    const { h } = await setup();
    const first = await h.cmd("tasks.terminal.open", { task: "ACM-1" });
    expect(first.status).toBe(200);
    const again = await h.cmd("tasks.terminal.open", { task: "ACM-1" });
    expect(again.body.terminalId).toBe(first.body.terminalId);
    // Opening at the same time still ends with one shell.
    const both = await Promise.all([
      h.cmd("tasks.terminal.open", { task: "ACM-1" }),
      h.cmd("tasks.terminal.open", { task: "ACM-1" }),
    ]);
    expect(both.map((r) => r.body.terminalId)).toEqual([first.body.terminalId, first.body.terminalId]);

    const shell = h.majhi.services.terminals.get(first.body.terminalId);
    if (shell === undefined) throw new Error("no terminal");
    shell.kill();
    await until(() => shell.exited, "the shell to exit");
    const fresh = await h.cmd("tasks.terminal.open", { task: "ACM-1" });
    expect(fresh.body.terminalId).not.toBe(first.body.terminalId);
  });

  it("is killed when the task is stopped, closed or removed", async () => {
    const { h } = await setup();
    const open = async () => {
      const res = await h.cmd("tasks.terminal.open", { task: "ACM-1" });
      const shell = h.majhi.services.terminals.get(res.body.terminalId);
      if (shell === undefined) throw new Error("no terminal");
      expect(shell.exited).toBe(false);
      return shell;
    };

    let shell = await open();
    expect((await h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    await until(() => shell.exited, "the shell to exit after stop");

    shell = await open();
    expect((await h.cmd("tasks.close", { id: "ACM-1" })).status).toBe(200);
    await until(() => shell.exited, "the shell to exit after close");

    shell = await open();
    expect((await h.cmd("tasks.remove", { id: "ACM-1" })).status).toBe(200);
    await until(() => shell.exited, "the shell to exit after remove");
  });

  it("refuses a task folder that leads outside the tasks folder or is missing", async () => {
    const { services, task } = await setup();
    const tasksDir = join(task.folder, "..");
    await expect(taskFolder(task, tasksDir)).resolves.toBe(task.folder);

    const link = join(tasksDir, "ACM-link");
    await symlink(w?.h.dir ?? "/tmp", link);
    await expect(taskFolder({ ...task, folder: link }, tasksDir)).rejects.toThrow("outside the tasks folder");
    await expect(taskFolder({ ...task, folder: join(tasksDir, "gone") }, tasksDir)).rejects.toThrow(
      "is not there",
    );

    // The manager on its own: nothing starts for a task with no folder.
    terminals = new TerminalManager();
    await expect(
      openTaskTerminal(
        {
          terminals,
          task: () => ({ ...task, folder: join(tasksDir, "gone") }),
          tasksDir: async () => tasksDir,
          base: BASE,
          repoMounts: async () => [],
        },
        task.id,
      ),
    ).rejects.toThrow("is not there");
    expect(terminals.running(taskTerminalKey(task.id))).toBeUndefined();
    expect(services.terminals.running(taskTerminalKey(task.id))).toBeUndefined();
  });
});
