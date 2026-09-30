import type { PromptBlock } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../testing/harness.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** How background processes hold a task in running and wake its agent (5.15), with in-memory sessions. */

let w: World;
afterEach(() => w?.cleanup());

const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const status = async (h: Harness) =>
  ((await h.cmd("tasks.get", { id: "ACM-1" })).body as { status: string }).status;
const systems = async (h: Harness) => {
  h.majhi.services.room.flush("ACM-1");
  const page = await h.cmd("room.items", { task: "ACM-1", limit: 500 });
  return (page.body.items as RoomItem[]).flatMap((i) => (i.type === "system" ? [i.text] : []));
};
const text = (blocks: PromptBlock[] | undefined) =>
  (blocks ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

/** ACM-1 whose first turn starts `command` in the background, as the agent's tool call would. */
async function startWith(command: string, wait: boolean): Promise<World> {
  w = await taskWorld();
  const { h } = w;
  h.runtime.onSession = (session) => {
    const first = session.script;
    let turns = 0;
    session.script = async (turn) => {
      turns++;
      if (turns === 1) {
        await h.majhi.services.processes.start({ task: "ACM-1", agent: "acme-builder", command, wait });
      }
      return first(turn);
    };
  };
  expect((await h.cmd("tasks.create", { text: "fix api", start: true })).status).toBe(200);
  await until(() => h.runtime.sessions[0]?.prompts.length === 1, "the first turn");
  await h.majhi.services.runs.idle();
  return w;
}

describe("background processes and the task", () => {
  it("a running wait process keeps the task running until the owner stops it", async () => {
    const { h } = await startWith("sleep 30", true);
    expect(await status(h)).toBe("running");
    await until(async () => (await systems(h)).includes("Waiting for p1 `sleep 30`."), "the waiting note");

    const res = await h.cmd("processes.stop", { task: "ACM-1", id: "p1" });
    expect(res.status).toBe(200);
    expect(res.body.process).toMatchObject({ status: "stopped", stoppedBy: "owner" });
    await until(async () => (await status(h)) === "review", "review");
    // Nobody was woken.
    expect(h.runtime.sessions[0]?.prompts).toHaveLength(1);
  });

  it("a wait: false process does not hold the task, and later prompts say it runs", async () => {
    const { h } = await startWith("sleep 30", false);
    await until(async () => (await status(h)) === "review", "review");
    expect((await h.cmd("room.send", { task: "ACM-1", text: "check the server" })).status).toBe(200);
    await until(() => h.runtime.sessions[0]?.prompts.length === 2, "the second prompt");
    expect(text(h.runtime.sessions[0]?.prompts[1])).toContain(
      "Running processes: p1 `sleep 30` by @acme-builder",
    );
  });

  it("an exit wakes the agent with its output and moves a task in review back to running", async () => {
    const { h } = await startWith("true", false);
    await until(async () => (await status(h)) === "review", "review");
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const session = h.runtime.sessions[0];
    if (session === undefined) throw new Error("no session");
    session.script = async (turn) => {
      await held;
      turn.emit({ type: "text", messageId: "w", text: "fixed" });
      return "end_turn";
    };
    await h.majhi.services.processes.start({
      task: "ACM-1",
      agent: "acme-builder",
      command: "echo 2 tests failed; exit 1",
      wait: true,
    });
    await until(() => session.prompts.length === 2, "the wake");
    expect(await status(h)).toBe("running");
    const wake = text(session.prompts[1]);
    expect(wake).toContain("Your background process p2, `echo 2 tests failed; exit 1`, exited with code 1");
    expect(wake).toContain("2 tests failed");
    expect(await systems(h)).toContain("p2 `echo 2 tests failed; exit 1` ended. Waking @acme-builder.");
    release();
    await until(async () => (await status(h)) === "review", "review after the woken turn");
  });

  it("stopping a task that waits on a process pauses it without passing through review", async () => {
    const { h } = await startWith("sleep 30", true);
    expect(await status(h)).toBe("running");
    const setStatus = vi.spyOn(h.majhi.services.store.tasks, "setStatus");
    expect((await h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    // Anything still in flight from the process's end.
    await new Promise((r) => setTimeout(r, 50));
    expect(setStatus.mock.calls.map((c) => c[1])).toEqual(["paused"]);
    const task = (await h.cmd("tasks.get", { id: "ACM-1" })).body as {
      status: string;
      pausedReason?: string;
    };
    expect(task).toMatchObject({ status: "paused", pausedReason: "owner" });
    expect((await systems(h)).some((t) => t.startsWith("Ready for your review"))).toBe(false);
  });

  it("stopping the task stops its processes without a wake", async () => {
    const { h } = await startWith("sleep 30", true);
    expect((await h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    expect(h.majhi.services.processes.list("ACM-1")).toMatchObject([
      { status: "stopped", stoppedBy: "task" },
    ]);
    expect(h.runtime.sessions[0]?.prompts).toHaveLength(1);
  });
});
