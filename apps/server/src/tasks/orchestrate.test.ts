import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../testing/fixtures.ts";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
/** Lets held turns end, so cleanup does not wait for them. */
let releaseAll: () => void = () => undefined;
afterEach(async () => {
  vi.useRealTimers();
  releaseAll();
  releaseAll = () => undefined;
  await w?.cleanup();
});

const status = async (id: string) => (await w.h.cmd("tasks.get", { id })).body.status as string;
const roomItems = async (id: string) =>
  (await w.h.cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[];
const lines = async (id: string) =>
  (await roomItems(id)).flatMap((i) => (i.type === "system" ? [i.text] : []));

const split = (children: object[]) => w.h.cmd("tasks.split", { task: "ACM-1", children, start: true });

describe("lead orchestration: the parent", () => {
  it("keeps a parent with commits not shipped open, in review for the owner", async () => {
    w = await taskWorld();
    await w.h.cmd("tasks.create", {
      text: "drive the api work",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "running", "parent running");
    await split([{ text: "add docs/intro.md to api", repos: [{ project: "acme-api" }] }]);
    await until(async () => (await status("ACM-2")) === "review", "child in review");
    await w.h.majhi.services.runs.idle();
    // The lead committed work of its own on the parent's branch.
    const tree = join(w.taskDir("ACM-1"), "acme-api");
    await writeFile(join(tree, "lead.txt"), "lead\n");
    await git(tree, "add", ".");
    await git(tree, "commit", "--quiet", "-m", "lead work");

    expect((await w.h.cmd("tasks.close", { id: "ACM-2" })).status).toBe(200);
    expect(await status("ACM-1")).toBe("review");
    const said = (await lines("ACM-1")).filter((l) =>
      l.startsWith("Every subtask is done, but ACM-1 stays open"),
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("1 commit on feat/drive-the-api-work");
  });
});
