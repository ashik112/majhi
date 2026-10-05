import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../testing/fixtures.ts";
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

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const status = async (id: string) => (await w.h.cmd("tasks.get", { id })).body.status as string;
const roomItems = async (id: string) =>
  (await w.h.cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[];
const lines = async (id: string) =>
  (await roomItems(id)).flatMap((i) => (i.type === "system" ? [i.text] : []));

/** Agents hold their turn until `release()`, so a task stays running. */
function hold() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      await gate;
      t.emit({ type: "text", messageId: "m", text: "done" });
      return "end_turn";
    };
  };
  releaseAll = release;
  return release;
}

const split = (children: object[]) => w.h.cmd("tasks.split", { task: "ACM-1", children, start: true });

describe("lead orchestration: parallel planning", () => {
  it("sends a finished parent to review when its only open subtask waits for it", async () => {
    w = await taskWorld();
    const release = hold();
    await w.h.cmd("tasks.create", {
      text: "change apps/server/src/runs/manager.ts in api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "running", "parent running");
    const res = await w.h.cmd("tasks.split", {
      task: "ACM-1",
      children: [{ text: "change apps/web/src/page.ts in api", repos: [{ project: "acme-api" }] }],
      start: false,
    });
    expect(res.status).toBe(200);
    // The subtask holds an older link to its parent, as one made before subtasks stopped waiting for it.
    const link = await w.h.cmd("tasks.link", {
      task: "ACM-2",
      type: "depends-on",
      target: "ACM-1",
      when: "ready",
    });
    expect(link.status).toBe(200);
    expect(await status("ACM-2")).not.toBe("done");

    release();
    await until(async () => (await status("ACM-1")) === "review", "parent in review");
    const cards = (await roomItems("ACM-1")).filter((i) => i.type === "review");
    expect(cards.filter((c) => c.state === "pending")).toHaveLength(1);
  });

  it("keeps a parent running while a subtask that waits for something else is open", async () => {
    w = await taskWorld();
    const release = hold();
    await w.h.cmd("tasks.create", {
      text: "change apps/server/src/runs/manager.ts in api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "running", "parent running");
    await w.h.cmd("tasks.split", {
      task: "ACM-1",
      children: [
        { text: "change apps/web/src/page.ts in api", repos: [{ project: "acme-api" }] },
        { text: "change apps/web/src/other.ts in api", repos: [{ project: "acme-api" }] },
      ],
      start: false,
    });
    await w.h.cmd("tasks.link", { task: "ACM-2", type: "depends-on", target: "ACM-1", when: "ready" });
    await w.h.cmd("tasks.link", { task: "ACM-3", type: "depends-on", target: "ACM-2", when: "ready" });
    release();
    await new Promise((r) => setTimeout(r, 200));
    // ACM-3 waits for its sibling too, so the parent is not the only thing holding the subtasks.
    expect(await status("ACM-1")).toBe("running");
  });
});

describe("lead orchestration: the parent", () => {
  it("tells the parent's lead when a child is ready, and closes the parent with a report", async () => {
    w = await taskWorld();
    await w.h.cmd("tasks.create", {
      text: "drive the api work",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    await until(async () => (await status("ACM-1")) === "running", "parent running");
    await split([{ text: "add docs/intro.md to api", repos: [{ project: "acme-api" }] }]);

    // The parent's lead hears about the child.
    const told = () =>
      w.h.runtime.sessions.some((s) =>
        s.prompts.some((blocks) =>
          blocks.some(
            (b) => b.type === "text" && b.text.includes("ACM-2") && b.text.includes("ready for review"),
          ),
        ),
      );
    await until(told, "lead told");

    await w.h.cmd("tasks.close", { id: "ACM-2" });
    expect(await status("ACM-1")).toBe("done");
    const report = (await lines("ACM-1")).find((l) => l.startsWith("Every subtask is done. Task closed."));
    expect(report).toContain("- ACM-2 add docs/intro.md to api");
  });

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
    expect(said[0]).toContain("1 commit on feat/acm-1-");
  });
});
