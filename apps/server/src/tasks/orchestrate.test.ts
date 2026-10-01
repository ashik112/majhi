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
  it("drops a waits-for link between tasks that change different files, and says so in the rooms", async () => {
    w = await taskWorld();
    hold();
    await w.h.cmd("tasks.create", {
      text: "drive the api work",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    const res = await split([
      { text: "add docs/intro.md to api" },
      { text: "add apps/web/src/page.ts to api", dependsOn: [0] },
    ]);
    expect(res.status).toBe(200);
    await until(async () => (await status("ACM-3")) === "running", "ACM-3 started");
    expect((await status("ACM-2")) === "running").toBe(true);

    const second = (await w.h.cmd("tasks.get", { id: "ACM-3" })).body;
    expect(second.links.filter((l: { type: string }) => l.type === "depends-on")).toEqual([]);
    const said =
      "ACM-3 no longer waits for ACM-2: they change different files, so nothing needs to be done first.";
    expect(await lines("ACM-3")).toContain(said);
    expect(await lines("ACM-2")).toContain(said);
    expect(await lines("ACM-1")).toContain(said);
  });

  it("keeps a link when the paths are not known", async () => {
    w = await taskWorld();
    hold();
    await w.h.cmd("tasks.create", {
      text: "drive the api work",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    await split([{ text: "add the model to api" }, { text: "add the view to api", dependsOn: [0] }]);
    await until(async () => (await status("ACM-2")) === "running", "ACM-2 started");
    expect(await status("ACM-3")).toBe("ready");
    const second = (await w.h.cmd("tasks.get", { id: "ACM-3" })).body;
    expect(second.links.some((l: { type: string }) => l.type === "depends-on")).toBe(true);
  });

  it("makes a task that overlaps a running one wait, and starts it when that one is ready", async () => {
    w = await taskWorld();
    const release = hold();
    await w.h.cmd("tasks.create", {
      text: "drive the api work",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    await split([
      { text: "change apps/server/src/runs/manager.ts in api" },
      { text: "also change apps/server/src/runs/manager.ts in api" },
    ]);
    await until(async () => (await status("ACM-2")) === "running", "ACM-2 started");
    await until(
      async () => (await lines("ACM-1")).some((l) => l.startsWith("ACM-3 waits for ACM-2")),
      "wait line",
    );
    expect(await status("ACM-3")).toBe("ready");
    expect((await lines("ACM-1")).find((l) => l.startsWith("ACM-3 waits"))).toContain("apps/server/src/runs");

    release();
    await until(async () => (await status("ACM-3")) !== "ready", "ACM-3 started after ACM-2 was ready");
  });

  it("asks the owner in one card when the wait would be long, and starts on the answer", async () => {
    w = await taskWorld();
    hold();
    await w.h.cmd("tasks.create", {
      text: "drive the api work",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    await split([{ text: "change apps/server/src/runs/manager.ts in api" }]);
    await until(async () => (await status("ACM-2")) === "running", "ACM-2 started");

    // Two hours later, a task that overlaps it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    await split([{ text: "also change apps/server/src/runs/manager.ts in api" }]);
    await until(async () => (await roomItems("ACM-1")).some((i) => i.type === "choice"), "choice card");
    const card = (await roomItems("ACM-1")).find((i) => i.type === "choice");
    if (card?.type !== "choice") throw new Error("no card");
    expect(card.state).toBe("pending");
    expect(card.question).toBe(
      "ACM-3 overlaps ACM-2 in apps/server/src/runs. Start now and merge later, or wait about 2 hours?",
    );
    expect(card.options.map((o) => o.label)).toEqual(["Start now, merge later", "Wait about 2 hours"]);
    expect(await status("ACM-3")).toBe("ready");

    const res = await w.h.cmd("room.choose", { task: "ACM-1", item: card.id, option: "start:ACM-3" });
    expect(res.status).toBe(200);
    await until(async () => (await status("ACM-3")) === "running", "ACM-3 started");
    const settled = (await roomItems("ACM-1")).find((i) => i.id === card.id);
    expect(settled).toMatchObject({ state: "answered", chosen: "start:ACM-3" });
    // The same card cannot be answered twice.
    expect(
      (await w.h.cmd("room.choose", { task: "ACM-1", item: card.id, option: "wait:ACM-3:ACM-2" })).status,
    ).toBe(409);
  });

  it("tasks.plan answers what can start now without changing anything", async () => {
    w = await taskWorld();
    hold();
    await w.h.cmd("tasks.create", {
      text: "drive the api work",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    await w.h.cmd("tasks.create", {
      text: "change apps/server/src/runs/manager.ts in api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    await until(async () => (await status("ACM-2")) === "running", "ACM-2 started");
    await w.h.cmd("tasks.create", {
      text: "change apps/server/src/runs/manager.ts again in api",
      repos: [{ project: "acme-api" }],
      start: false,
      parent: "ACM-1",
    });
    await w.h.cmd("tasks.create", {
      text: "change docs/intro.md in api",
      repos: [{ project: "acme-api" }],
      start: false,
      parent: "ACM-1",
    });

    const res = await w.h.cmd("tasks.plan", { id: "ACM-1" });
    expect(res.status).toBe(200);
    const byTask = Object.fromEntries(
      res.body.entries.map((e: { task: string; action: string }) => [e.task, e.action]),
    );
    expect(byTask).toEqual({ "ACM-3": "wait", "ACM-4": "start" });
    expect(await status("ACM-3")).toBe("inbox");
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
    await split([{ text: "add docs/intro.md to api" }]);

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
    await split([{ text: "add docs/intro.md to api" }]);
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
    expect(said[0]).toContain("1 commit on task/acm-1-");
  });
});
