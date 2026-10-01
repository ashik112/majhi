import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const status = async (id: string) => (await w.h.cmd("tasks.get", { id })).body.status as string;
const notes = async (id: string) =>
  ((await w.h.cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[]).flatMap((i) =>
    i.type === "system" ? [i.text] : [],
  );

describe("a ready dependency", () => {
  it("stacks the waiting task's branch on its branch, and rebases it when that branch moves", async () => {
    w = await taskWorld();
    const { h } = w;
    const api1 = () => join(w.taskDir("ACM-1"), "acme-api");
    const api2 = () => join(w.taskDir("ACM-2"), "acme-api");
    let turn = 0;
    // The first task's agent writes a file each turn; majhi checkpoints it on the task branch.
    h.runtime.onSession = (session) => {
      session.script = async (t) => {
        if (t.text.includes("ACM-1") || session.sessionId === "fake-session-1") {
          turn++;
          await writeFile(join(api1(), `step${turn}.txt`), `step ${turn}\n`);
        }
        t.emit({ type: "text", messageId: "m", text: "done" });
        return "end_turn";
      };
    };
    expect(
      (
        await h.cmd("tasks.create", {
          text: "add the model to api",
          repos: [{ project: "acme-api" }],
          start: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.cmd("tasks.create", {
          text: "add the view to api",
          repos: [{ project: "acme-api" }],
          start: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (await h.cmd("tasks.link", { task: "ACM-2", type: "depends-on", target: "ACM-1", when: "ready" }))
        .status,
    ).toBe(200);
    expect((await h.cmd("tasks.start", { id: "ACM-2" })).status).toBe(409);

    // ACM-1 reaches review: ACM-2 starts from ACM-1's branch, with its work in it.
    await until(async () => (await status("ACM-2")) !== "ready", "ACM-2 started");
    const second = (await h.cmd("tasks.get", { id: "ACM-2" })).body;
    const first = (await h.cmd("tasks.get", { id: "ACM-1" })).body;
    expect(second.repos[0].base).toBe(first.repos[0].branch);
    expect(second.repos[0].stack).toMatchObject({ task: "ACM-1", branch: first.repos[0].branch });
    expect(await git(api2(), "ls-files")).toContain("step1.txt");
    expect(await notes("ACM-2")).toContain(`acme-api: stacked on ACM-1's branch ${first.repos[0].branch}.`);
    await h.majhi.services.runs.idle();

    // ACM-1 moves on: ACM-2 follows.
    await h.cmd("room.send", { task: "ACM-1", text: "one more step" });
    await until(async () => (await git(api2(), "ls-files")).includes("step2.txt"), "rebased");
    const tip = (await git(api1(), "rev-parse", "HEAD")).trim();
    expect((await h.cmd("tasks.get", { id: "ACM-2" })).body.repos[0].stack.commit).toBe(tip);
    expect(await notes("ACM-2")).toContain(`acme-api: rebased onto ACM-1's latest ${first.repos[0].branch}.`);
  });
});
