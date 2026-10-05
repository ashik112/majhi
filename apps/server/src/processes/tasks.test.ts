import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptBlock } from "@majhi/acp";
import type { ProcessInfo, RoomItem } from "@majhi/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../testing/harness.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { processesServer } from "./mcp.ts";

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

/** Calls a majhi-processes tool as acme-builder's session would. */
async function callTool(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const server = processesServer({ task: "ACM-1", agent: "acme-builder" }, h.majhi.services.processes);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(far);
  try {
    const res = await client.callTool({ name, arguments: args });
    return (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

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
    expect((await h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    // Anything still in flight from the process's end.
    await new Promise((r) => setTimeout(r, 50));
    const trail = h.majhi.services.store.lifecycle.events("ACM-1").reverse();
    expect(trail.map((e) => e.event)).toEqual(["start", "ownerStop"]);
    expect(trail.every((e) => e.toStatus !== "review")).toBe(true);
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

  it("an end the agent read with output before majhi handled it wakes nobody, and the task goes to review", async () => {
    const { h } = await startWith("until [ -e go ]; do sleep 0.05; done; echo 3 passed", true);
    const { runs, tasks } = h.majhi.services;
    await until(
      async () => (await systems(h)).some((t) => t.startsWith("Waiting for p1")),
      "the waiting note",
    );
    const held: ProcessInfo[] = [];
    const handle = vi.spyOn(tasks, "processEnded").mockImplementation(async (p) => {
      held.push(p);
    });
    const folder = ((await h.cmd("tasks.get", { id: "ACM-1" })).body as { folder: string }).folder;
    await writeFile(join(folder, "go"), "");
    await until(() => held.length === 1, "the end");
    handle.mockRestore();
    const [end] = held;
    if (end === undefined) throw new Error("no end");

    expect(await callTool(h, "output", { id: "p1" })).toContain("3 passed");
    await tasks.processEnded(end, true);
    await runs.idle();
    const line = `p1 \`${end.name}\` ended; @acme-builder already read it, so nobody is woken.`;
    expect(await systems(h)).toContain(line);
    expect(h.runtime.sessions[0]?.prompts).toHaveLength(1);
    await until(async () => (await status(h)) === "review", "review");

    // Reported again, it still wakes nobody.
    await tasks.processEnded(end, true);
    await runs.idle();
    expect(h.runtime.sessions[0]?.prompts).toHaveLength(1);
    expect((await systems(h)).filter((t) => t === line)).toHaveLength(1);
  });

  it("an end that arrives while the agent works, read with list in that turn, gets no follow-up turn", async () => {
    const { h } = await startWith("true", false);
    await until(async () => (await status(h)) === "review", "review");
    const { processes, runs } = h.majhi.services;
    const session = h.runtime.sessions[0];
    if (session === undefined) throw new Error("no session");
    session.script = async (turn) => {
      if (session.prompts.length === 2) {
        await processes.start({
          task: "ACM-1",
          agent: "acme-builder",
          name: "test",
          command: "echo 3 passed",
          wait: true,
        });
        // majhi handles the end while this turn still runs: it is queued for the agent.
        await until(
          async () => (await systems(h)).includes("p2 `test` ended. Waking @acme-builder."),
          "the queued end",
        );
        expect(await callTool(h, "list")).toContain("p2 test (`echo 3 passed`)");
      }
      turn.emit({ type: "text", messageId: "r", text: "tests pass" });
      return "end_turn";
    };
    expect((await h.cmd("room.send", { task: "ACM-1", text: "run the tests" })).status).toBe(200);
    await until(() => session.prompts.length === 2, "the owner's prompt");
    await until(async () => (await status(h)) === "review", "review after the turn");
    await runs.idle();
    expect(session.prompts).toHaveLength(2);
    expect(await systems(h)).toContain(
      "p2 ended, but @acme-builder already read it, so @acme-builder is not told again.",
    );
  });

  it("an end only another agent saw still wakes its agent", async () => {
    const { h } = await startWith("true", false);
    await until(async () => (await status(h)) === "review", "review");
    const { processes } = h.majhi.services;
    const session = h.runtime.sessions[0];
    if (session === undefined) throw new Error("no session");
    const p = await processes.start({
      task: "ACM-1",
      agent: "acme-builder",
      name: "test",
      command: "echo 3 passed",
      wait: true,
    });
    await until(() => processes.get("ACM-1", p.id)?.status === "exited", "the end");
    // The lead looked at it, not the builder.
    const ended = processes.get("ACM-1", p.id);
    if (ended === undefined) throw new Error("no process");
    processes.markRead("ACM-1", ended, "acme-lead");
    expect(processes.readAfterEnd(ended)).toBe(false);
    await until(() => session.prompts.length === 2, "the wake");
    expect(text(session.prompts[1])).toContain("Your background process p2, test (`echo 3 passed`), exited");
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
