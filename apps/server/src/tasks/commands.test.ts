import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const create = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("tasks.create", { text, start: false, ...extra });
const idle = () => w.h.majhi.services.runs.idle();

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
