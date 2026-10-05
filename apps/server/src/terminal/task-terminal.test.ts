import { symlink } from "node:fs/promises";
import { join } from "node:path";
import type { BaseEnv } from "@majhi/acp";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";
import { TerminalManager } from "./manager.ts";
import { openTaskTerminal, taskFolder, taskTerminalEnv, taskTerminalKey } from "./task-terminal.ts";

const BASE: BaseEnv = { PATH: "/usr/bin:/bin" };

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
    const created = await h.cmd("tasks.create", {
      text: "fix api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(created.status).toBe(200);
    return { services: h.majhi.services, task: created.body as Task };
  }

  it("refuses a task folder that leads outside the tasks folder or is missing", async () => {
    const { services, task } = await setup();
    const tasksDir = join(task.folder, "..");
    await expect(taskFolder(task, tasksDir)).resolves.toBe(task.folder);

    const link = join(tasksDir, "ACM-link");
    await symlink(w?.h.dir ?? "/tmp", link);
    await expect(taskFolder({ ...task, folder: link }, tasksDir)).rejects.toThrow();
    await expect(taskFolder({ ...task, folder: join(tasksDir, "gone") }, tasksDir)).rejects.toThrow();

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
    ).rejects.toThrow();
    expect(terminals.running(taskTerminalKey(task.id))).toBeUndefined();
    expect(services.terminals.running(taskTerminalKey(task.id))).toBeUndefined();
  });
});
