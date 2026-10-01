import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { Script } from "../testing/fakeSession.ts";
import { git } from "../testing/fixtures.ts";
import type { Harness } from "../testing/harness.ts";
import { taskWorld, type World, type WorldOptions } from "../testing/world.ts";

/**
 * Resume without the owner (SPEC 5.7), concurrency limits and agents on demand (5.17), and the
 * decision hooks (5.12), with in-memory sessions.
 */

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
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** A turn that writes a file into the worktree and then stays open until released or cancelled. */
function working(file: string): { script: Script; release: () => void } {
  let release: () => void = () => {};
  const open = new Promise<void>((r) => {
    release = r;
  });
  return {
    release: () => release(),
    script: async (turn) => {
      const wt = join(w.taskDir("ACM-1"), "acme-api");
      await mkdir(wt, { recursive: true });
      await writeFile(join(wt, file), "work\n");
      turn.emit({ type: "text", messageId: "m", text: "working" });
      await Promise.race([open, turn.untilCancelled()]);
      return "end_turn";
    },
  };
}

async function items(h: Harness, task = "ACM-1"): Promise<RoomItem[]> {
  h.majhi.services.room.flush(task);
  const page = await h.cmd("room.items", { task, limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const systems = async (h: Harness, task = "ACM-1") =>
  (await items(h, task)).flatMap((i) => (i.type === "system" ? [i.text] : []));
const status = async (h: Harness, id = "ACM-1") => (await h.cmd("tasks.get", { id })).body;

/** Starts ACM-1 with its first turn scripted and waits until that turn is running. */
async function startWorking(options: WorldOptions = {}, file = "a.txt") {
  w = await taskWorld(options);
  const turn = working(file);
  w.h.runtime.onSession = (session) => {
    if (w.h.runtime.sessions.length === 0) session.script = turn.script;
  };
  expect(
    (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true }))
      .status,
  ).toBe(200);
  await until(() => existsSync(join(w.taskDir("ACM-1"), "acme-api", file)), "the first turn");
  return turn;
}

describe("restart and crash", () => {
  it("continues a cut turn after a restart, with its work and a checkpoint", async () => {
    await startWorking();
    // majhi dies mid-turn: a second server opens the same home without closing the first.
    extra = w.h.restart();
    const again = extra;
    await until(() => w.h.runtime.sessions.length === 2, "a new session");
    await again.majhi.services.runs.idle();

    const second = w.h.runtime.sessions[1];
    expect(w.h.runtime.starts[1]?.resume).toBe(w.h.runtime.sessions[0]?.sessionId);
    // The team facts block may follow; the resume line comes first.
    expect(second?.prompts[0]?.[0]).toEqual({
      type: "text",
      text: "Continue from where you stopped. There is no checkpoint yet.",
    });
    expect(await systems(again)).toContain("Resuming @acme-builder: majhi restarted during its turn.");
    // The work from before the crash is on disk and committed at the end of the resumed turn.
    const wt = join(w.taskDir("ACM-1"), "acme-api");
    expect(await git(wt, "log", "-1", "--format=%s")).toBe("wip(ACM-1): checkpoint 1");
    expect(await git(wt, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt");
    expect(again.majhi.services.store.runs.interrupted()).toEqual([]);
    expect(again.majhi.services.store.runs.forTask("ACM-1").at(-1)?.checkpoint).toBe(1);
  });

  it("pauses with reason error after two failed resumes", async () => {
    await startWorking();
    w.h.runtime.startError = new Error("adapter is broken");
    extra = w.h.restart();
    const again = extra;
    await until(async () => (await status(again)).status === "paused", "the pause");
    expect(await status(again)).toMatchObject({ pausedReason: "error" });
    const text = await systems(again);
    expect(text.filter((t) => t.startsWith("@acme-builder could not start"))).toHaveLength(2);
    expect(text).toContain(
      "Could not resume @acme-builder after two tries: the agent could not start. Resume the task to try again.",
    );
  });
});

/** A fake clock for the runs and the network watch, and a probe the test turns off and on. */
function outageKit() {
  let t = Date.parse("2026-10-01T11:20:00.000Z");
  let online = true;
  return {
    clock: () => new Date(t),
    probe: async () => online,
    pass: (ms: number) => {
      t += ms;
    },
    set online(value: boolean) {
      online = value;
    },
  };
}

/** Probe rounds 15 s apart from now until `ms` passed, as the watch does while the network is down. */
async function failFor(kit: ReturnType<typeof outageKit>, ms: number): Promise<void> {
  kit.online = false;
  await w.h.majhi.services.resilience.network.check();
  for (let passed = 15_000; passed <= ms; passed += 15_000) {
    kit.pass(15_000);
    await w.h.majhi.services.resilience.network.check();
  }
}

async function backOnline(kit: ReturnType<typeof outageKit>): Promise<void> {
  kit.online = true;
  await w.h.majhi.services.resilience.network.check();
}

/** Sessions that are still open: each one is a runner container in production. */
const openSessions = () => w.h.runtime.sessions.filter((s) => !s.closed).length;

describe("offline", () => {
  it("pauses nothing for a blip shorter than 45 seconds", async () => {
    const kit = outageKit();
    const turn = await startWorking({ probe: kit.probe, runClock: kit.clock });
    // The turn has been quiet a while: it would pause if majhi counted as offline.
    kit.pass(60_000);
    await failFor(kit, 30_000);
    expect(w.h.majhi.services.resilience.network.online).toBe(true);
    await backOnline(kit);
    expect((await status(w.h)).status).toBe("running");
    expect(w.h.runtime.sessions[0]?.cancels).toBe(0);
    expect(await systems(w.h)).not.toContain(
      "majhi is offline. @acme-builder paused and continues when the connection is back.",
    );
    turn.release();
    await w.h.majhi.services.runs.idle();
    expect(w.h.runtime.sessions[0]?.prompts).toHaveLength(1);
  });

  it("pauses a quiet turn in a real outage and resumes it with one prompt in the same session", async () => {
    const kit = outageKit();
    const turn = await startWorking({ probe: kit.probe, runClock: kit.clock });
    const { room } = w.h.majhi.services;
    kit.pass(31_000);
    await failFor(kit, 45_000);
    await until(async () => (await status(w.h)).status === "paused", "the offline pause");
    expect(await status(w.h)).toMatchObject({ pausedReason: "offline" });
    expect(room.getLive("ACM-1", "acme-builder")?.status).toBe("paused");
    expect(await systems(w.h)).toContain(
      "majhi is offline. @acme-builder paused and continues when the connection is back.",
    );
    // The cut turn does not say "Stopped", and its work was checkpointed.
    expect(await systems(w.h)).not.toContain("Stopped @acme-builder's turn.");
    const wt = join(w.taskDir("ACM-1"), "acme-api");
    await until(
      async () => (await git(wt, "log", "-1", "--format=%s")) === "wip(ACM-1): checkpoint 1",
      "the checkpoint",
    );

    // The resumed turn stays open until released, so the test sees it working.
    const session = w.h.runtime.sessions[0];
    if (session === undefined) throw new Error("no session");
    session.script = turn.script;
    await backOnline(kit);
    // Another watcher call at the same moment resumes nothing twice.
    await w.h.majhi.services.resilience.networkChanged(true);
    await until(() => session.prompts.length === 2, "the resume prompt");
    await until(() => room.getLive("ACM-1", "acme-builder")?.status === "working", "working again");
    expect((await status(w.h)).status).toBe("running");
    turn.release();
    await w.h.majhi.services.runs.idle();
    // The same session continues: nothing was restarted, and the turn was sent again once.
    expect(w.h.runtime.sessions).toHaveLength(1);
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toEqual([
      { type: "text", text: "Continue from where you stopped. The last checkpoint is 1." },
    ]);
    expect(
      (await systems(w.h)).filter((t) => t === "Resuming @acme-builder: the connection is back."),
    ).toHaveLength(1);
    expect((await status(w.h)).status).toBe("review");
  });

  it("sends the waiting message once when the outage hits while the agent is still starting", async () => {
    const kit = outageKit();
    w = await taskWorld({ probe: kit.probe, runClock: kit.clock });
    // The runner takes its time to start, like a container on a flaky connection.
    let opened: () => void = () => {};
    const gate = new Promise<void>((r) => {
      opened = r;
    });
    const start = w.h.runtime.startSession.bind(w.h.runtime);
    w.h.runtime.startSession = async (s) => {
      await gate;
      return start(s);
    };
    expect(
      (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true }))
        .status,
    ).toBe(200);
    await until(
      () => w.h.majhi.services.room.getLive("ACM-1", "acme-builder")?.status === "starting",
      "the start",
    );
    await failFor(kit, 45_000);
    expect(w.h.majhi.services.resilience.network.online).toBe(false);
    await backOnline(kit);
    opened();
    await until(() => (w.h.runtime.sessions[0]?.prompts.length ?? 0) >= 1, "the first prompt");
    await w.h.majhi.services.runs.idle();
    const prompts = w.h.runtime.sessions[0]?.prompts ?? [];
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain("TASK.md");
    expect(w.h.runtime.sessions).toHaveLength(1);
    expect((await status(w.h)).status).toBe("review");
  });

  it("does not cut a turn that streams during the outage, and pauses it once it goes quiet", async () => {
    const kit = outageKit();
    const turn = await startWorking({ probe: kit.probe, runClock: kit.clock });
    const session = w.h.runtime.sessions[0];
    if (session === undefined) throw new Error("no session");
    // The agent keeps sending through the outage: every probe round sees fresh output.
    kit.online = false;
    for (let round = 0; round <= 4; round++) {
      if (round > 0) kit.pass(15_000);
      session.emit({ type: "text", messageId: "m", text: "." });
      await w.h.majhi.services.resilience.network.check();
    }
    expect(w.h.majhi.services.resilience.network.online).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(session.cancels).toBe(0);
    expect((await status(w.h)).status).toBe("running");
    expect(w.h.majhi.services.room.getLive("ACM-1", "acme-builder")?.status).toBe("working");

    // Then it goes quiet while still offline: the next round pauses it.
    kit.pass(31_000);
    await w.h.majhi.services.resilience.network.check();
    await until(async () => (await status(w.h)).status === "paused", "the pause once quiet");
    expect(session.cancels).toBe(1);
    await backOnline(kit);
    await until(() => session.prompts.length === 2, "the resume prompt");
    turn.release();
    await w.h.majhi.services.runs.idle();
    expect(openSessions()).toBe(1);
  });

  it("keeps one live runner per run across pause and resume, also when a cancel fails", async () => {
    const kit = outageKit();
    await startWorking({ probe: kit.probe, runClock: kit.clock });
    // The agent ignores cancel, like one stuck on a dead connection: majhi closes its process.
    w.h.runtime.onSession = (session) => {
      session.script = async (turn) => {
        turn.emit({ type: "text", messageId: "m", text: "working" });
        await turn.untilCancelled();
        return "end_turn";
      };
      session.cancel = async () => {
        throw new Error("The agent did not stop after cancel");
      };
    };
    const first = w.h.runtime.sessions[0];
    if (first === undefined) throw new Error("no session");
    first.cancel = async () => {
      throw new Error("The agent did not stop after cancel");
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
      await until(async () => (await status(w.h)).status === "running", `running ${cycle}`);
      kit.pass(31_000);
      await failFor(kit, 45_000);
      await until(async () => (await status(w.h)).status === "paused", `pause ${cycle}`);
      await until(() => openSessions() === 0, `the closed session ${cycle}`);
      await backOnline(kit);
      await until(() => w.h.runtime.sessions.length === cycle + 1, `session ${cycle + 1}`);
      await until(() => (w.h.runtime.sessions[cycle]?.prompts.length ?? 0) === 1, `resume ${cycle}`);
      expect(openSessions()).toBe(1);
    }
    await w.h.majhi.services.runs.stop("ACM-1");
    expect(openSessions()).toBe(0);
  });

  it("removes the runner of an agent whose process died", async () => {
    await startWorking();
    const session = w.h.runtime.sessions[0];
    session?.emit({ type: "exit", code: 1, error: "getaddrinfo ENOTFOUND api.anthropic.com" });
    await until(() => session?.closed === true, "the runner removed");
    expect(openSessions()).toBe(0);
  });
});

describe("limits", () => {
  async function threeAgents(): Promise<void> {
    for (const id of ["acme-two", "acme-three"]) {
      const res = await w.h.cmd("agents.create", {
        id,
        frontmatter: { scope: "acme", role: "Builder", account: "claude-acme", perms: ["edit"] },
        instructions: "Build.\n",
      });
      expect(res.status).toBe(200);
    }
  }

  it("queues a third agent under per_account 2, shows its place, and starts it when a slot frees", async () => {
    w = await taskWorld();
    await threeAgents();
    // One open turn per task, released by the test.
    const gates = new Map<string, () => void>();
    w.h.runtime.onSession = (session, start) => {
      const task = start.cwd.split("/").pop() ?? "";
      session.script = (turn) =>
        new Promise((resolve) => {
          turn.emit({ type: "text", messageId: "m", text: "busy" });
          gates.set(task, () => resolve("end_turn"));
        });
    };
    for (const text of ["one on api", "two on api @acme-two", "three on api @acme-three"]) {
      expect(
        (await w.h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: true })).status,
      ).toBe(200);
    }
    const live = (task: string, agent: string) => w.h.majhi.services.room.getLive(task, agent);
    await until(() => live("ACM-3", "acme-three")?.status === "queued", "the queue");
    expect(live("ACM-3", "acme-three")).toMatchObject({ status: "queued", slot: 1 });
    expect(w.h.runtime.sessions).toHaveLength(2);
    expect(await systems(w.h, "ACM-3")).toContain(
      "Queued, #1 in line: majhi is running as many agents as the limits allow. @acme-three starts when a slot is free.",
    );

    // The first agent ends its turn and goes idle: its process makes room for the one waiting.
    await until(() => gates.has("ACM-1"), "the first turn");
    gates.get("ACM-1")?.();
    await until(() => w.h.runtime.sessions.length === 3, "the third session");
    const first = w.h.runtime.sessions.find((s) =>
      w.h.runtime.starts[w.h.runtime.sessions.indexOf(s)]?.cwd.endsWith("ACM-1"),
    );
    expect(first?.closed).toBe(true);
    expect(live("ACM-1", "acme-builder")?.status).toBe("idle");
    expect(live("ACM-3", "acme-three")?.slot).toBeUndefined();
    await until(() => gates.has("ACM-3"), "the third turn");
    gates.get("ACM-2")?.();
    gates.get("ACM-3")?.();
    await w.h.majhi.services.runs.idle();
  });
});
