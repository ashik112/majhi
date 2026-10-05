import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const create = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("tasks.create", { text, start: false, ...extra });
const idle = () => w.h.majhi.services.runs.idle();

describe("tasks.create", () => {
  it("parses the text on the server and creates an inbox task with its folder", async () => {
    w = await taskWorld();
    const res = await create("add a health endpoint to api from develop", {
      repos: [{ project: "acme-api", base: "develop" }],
    });
    expect(res.status).toBe(200);
    const task = res.body;
    expect(task).toMatchObject({
      id: "ACM-1",
      title: "add a health endpoint to api from develop",
      brief: "add a health endpoint to api from develop",
      kind: "code",
      org: "acme",
      status: "inbox",
      folder: w.taskDir("ACM-1"),
      team: ["acme-builder"],
      links: [],
      attachments: [],
      repos: [
        {
          project: "acme-api",
          source: w.repo("api"),
          base: "develop",
          branch: "feat/acm-1-add-a-health-endpoint-to-api-from",
          createdBranch: true,
        },
      ],
    });
    expect(task.repos[0].worktree).toBeUndefined();

    const taskMd = await readFile(join(task.folder, "TASK.md"), "utf8");
    expect(taskMd).toContain("# ACM-1: add a health endpoint to api from develop");
    expect(taskMd).toContain(
      `- acme-api: worktree \`${join(task.folder, "acme-api")}\`, branch \`feat/acm-1-add-a-health-endpoint-to-api-from\` (new, from \`develop\`)`,
    );
    expect(taskMd).toContain("@acme-builder (Lead)");
    expect(taskMd).toContain("Never push");
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      expect(await readFile(join(task.folder, name), "utf8")).toContain("Read TASK.md in this folder first");
    }
    expect(existsSync(join(task.folder, "acme-api"))).toBe(false);

    const list = await w.h.cmd("tasks.list", {});
    expect(list.body).toEqual([
      {
        id: "ACM-1",
        title: "add a health endpoint to api from develop",
        kind: "code",
        org: "acme",
        status: "inbox",
        team: ["acme-builder"],
        mode: "lead",
        updatedAt: task.updatedAt,
        repos: [{ project: "acme-api", branch: "feat/acm-1-add-a-health-endpoint-to-api-from" }],
        working: [],
        links: [],
        waitingOn: [],
      },
    ]);
  });
});

describe("tasks.start", () => {
  it("creates the worktree on a new branch from the base and runs the agent", async () => {
    w = await taskWorld();
    const res = await create("add a health endpoint to api from develop", {
      start: true,
      repos: [{ project: "acme-api", base: "develop" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    const wt = join(res.body.folder, "acme-api");
    expect(res.body.repos[0].worktree).toBe(wt);
    expect(await git(wt, "symbolic-ref", "--short", "HEAD")).toBe(
      "feat/acm-1-add-a-health-endpoint-to-api-from",
    );
    expect((await stat(join(wt, "README.md"))).isFile()).toBe(true);

    await idle();
    const session = w.h.runtime.sessions[0];
    expect(w.h.runtime.starts[0]).toMatchObject({ cwd: res.body.folder, model: "sonnet", effort: "high" });
    expect(session?.prompts).toHaveLength(1);
    expect(session?.prompts[0]).toEqual([
      {
        type: "text",
        text: "Read TASK.md in this folder, then do the task it describes. Say what you are about to change before you change it.",
      },
    ]);
    const items = (await w.h.cmd("room.items", { task: "ACM-1" })).body.items.reverse();
    expect(items.map((i: { type: string; text?: string }) => [i.type, i.text])).toEqual([
      ["owner", "add a health endpoint to api from develop"],
      ["system", "@acme-builder started on claude-acme, model sonnet, effort high"],
      ["agent", "ok"],
      ["review", undefined],
    ]);
    expect(items.at(-1)).toMatchObject({ type: "review", lead: "acme-builder", state: "pending" });
    // The task list says who is working, and the room's agent is idle.
    expect(w.h.majhi.services.room.getLive("ACM-1", "acme-builder")).toMatchObject({
      status: "idle",
      model: "sonnet",
      effort: "high",
      queued: 0,
    });
  });
});

describe("stopping, closing and removing", () => {
  it("refuses to remove a task with uncommitted changes unless forced and confirmed with its id", async () => {
    w = await taskWorld();
    const made = await create("fix api", { start: true, repos: [{ project: "acme-api" }] });
    await idle();
    const wt = join(made.body.folder, "acme-api");
    await writeFile(join(wt, "work.txt"), "unsaved");
    const refused = await w.h.cmd("tasks.remove", { id: "ACM-1" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(`Uncommitted changes in ${wt}`);
    expect(refused.body.details).toEqual(["acme-api: ?? work.txt"]);
    expect(existsSync(wt)).toBe(true);
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).status).toBe(200);

    // Force alone is not enough: the owner types the task id after seeing the list.
    const unconfirmed = await w.h.cmd("tasks.remove", { id: "ACM-1", force: true });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error).toContain("Type ACM-1 to confirm");
    expect(unconfirmed.body.details).toEqual(["acme-api: ?? work.txt"]);
    const wrong = await w.h.cmd("tasks.remove", { id: "ACM-1", force: true, confirm: "ACM-2" });
    expect(wrong.status).toBe(409);
    expect(existsSync(join(wt, "work.txt"))).toBe(true);

    const forced = await w.h.cmd("tasks.remove", { id: "ACM-1", force: true, confirm: "ACM-1" });
    expect(forced.body).toEqual({ removed: "ACM-1" });
    expect(existsSync(made.body.folder)).toBe(false);
    expect(await git(w.repo("api"), "worktree", "list", "--porcelain")).not.toContain("acm-1");
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).status).toBe(404);
    // The next task does not reuse the number.
    expect((await create("again api", { repos: [{ project: "acme-api" }] })).body.id).toBe("ACM-2");
  });
});
