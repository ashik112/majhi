import type { PromptBlock } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../testing/harness.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** How background processes hold a task in running and wake its agent (5.15), with in-memory sessions. */

let w: World;
let extra: Harness | undefined;
afterEach(async () => {
  if (extra !== undefined) {
    await extra.majhi.services.runs.closeAll();
    await extra.majhi.close();
    extra = undefined;
  }
  await w?.cleanup();
});

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
  expect(
    (await h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true })).status,
  ).toBe(200);
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
    const items = (await h.cmd("room.items", { task: "ACM-1" })).body.items as { type: string }[];
    expect(items.some((i) => i.type === "review")).toBe(false);
  });

  it("stopping the task stops its processes without a wake", async () => {
    const { h } = await startWith("sleep 30", true);
    expect((await h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    expect(h.majhi.services.processes.list("ACM-1")).toMatchObject([
      { status: "stopped", stoppedBy: "task" },
    ]);
    expect(h.runtime.sessions[0]?.prompts).toHaveLength(1);
  });

  it("an old run that ends after a newer run of the same name started wakes nobody", async () => {
    const { h } = await startWith("true", false);
    await until(async () => (await status(h)) === "review", "review");
    const { processes } = h.majhi.services;
    const old = await processes.start({
      task: "ACM-1",
      agent: "acme-builder",
      name: "tests",
      command: "sleep 0.3; echo old failure; exit 1",
      wait: true,
    });
    await processes.start({
      task: "ACM-1",
      agent: "acme-builder",
      name: "tests",
      command: "sleep 30",
      wait: true,
    });
    await until(() => processes.get("ACM-1", old.id)?.status === "exited", "the old run's end");
    await until(
      async () =>
        (await systems(h)).includes("p2 `tests` ended, but p3 is a newer run of it, so nobody is woken."),
      "the quiet line",
    );
    await h.majhi.services.runs.idle();
    expect(h.runtime.sessions[0]?.prompts).toHaveLength(1);
    await processes.stopTask("ACM-1");
  });

  it("an end is told once, and ends that pile up while the agent is paused go out in one prompt", async () => {
    const { h } = await startWith("true", false);
    await until(async () => (await status(h)) === "review", "review");
    const { processes, runs, tasks } = h.majhi.services;
    const session = h.runtime.sessions[0];
    if (session === undefined) throw new Error("no session");
    runs.markInterrupted("ACM-1", "acme-builder");
    const lint = await processes.start({
      task: "ACM-1",
      agent: "acme-builder",
      name: "lint",
      command: "echo lint ok",
      wait: true,
    });
    await until(() => processes.get("ACM-1", lint.id)?.status === "exited", "lint's end");
    await new Promise((r) => setTimeout(r, 20));
    const build = await processes.start({
      task: "ACM-1",
      agent: "acme-builder",
      name: "build",
      command: "echo build ok",
      wait: true,
    });
    await until(() => processes.get("ACM-1", build.id)?.status === "exited", "build's end");
    const ended = processes.get("ACM-1", build.id);
    if (ended === undefined) throw new Error("no process");
    // The same end reported again, as a replay would.
    await tasks.processEnded(ended, true);
    await runs.idle();
    expect(session.prompts).toHaveLength(1);

    runs.resumeAfterRestart("ACM-1", "acme-builder");
    await until(() => session.prompts.length >= 3, "the resume and the notice");
    await runs.idle();
    expect(session.prompts).toHaveLength(3);
    const notice = text(session.prompts[2]);
    expect(notice).toContain("2 of your background processes ended. Newest first");
    expect(notice.indexOf("p3, build")).toBeLessThan(notice.indexOf("p2, lint"));
    expect(notice).toContain("Do not mention other agents just to report status");
    const wakes = (await systems(h)).filter((t) => t.includes("ended. Waking @acme-builder."));
    expect(wakes.sort()).toEqual([
      "p2 `lint` ended. Waking @acme-builder.",
      "p3 `build` ended. Waking @acme-builder.",
    ]);

    // After a restart the same end, reported again, wakes nobody.
    extra = h.restart();
    const again = extra;
    await again.majhi.services.runs.idle();
    const before = h.runtime.sessions.flatMap((s) => s.prompts).length;
    await again.majhi.services.tasks.processEnded(ended, true);
    await again.majhi.services.runs.idle();
    expect(h.runtime.sessions.flatMap((s) => s.prompts).length).toBe(before);
    expect((await systems(again)).filter((t) => t.startsWith("p3 `build` ended"))).toHaveLength(1);
  });
});
