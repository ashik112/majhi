import type { AutonomyStatus, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import type { FakeSession } from "../testing/fakeSession.ts";
import type { Harness } from "../testing/harness.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: BossWorld | undefined;
let plain: World | undefined;
let extra: Harness | undefined;
afterEach(async () => {
  await extra?.majhi.close();
  extra = undefined;
  await w?.cleanup();
  w = undefined;
  await plain?.cleanup();
  plain = undefined;
});

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A boss world where every agent's first turn waits until `release`, or until it is cancelled, and
 * any later turn ends at once. `prompts()` is every prompt text agents got, in order.
 */
async function world() {
  w = await bossWorld({ real: false });
  const { h } = w;
  let open = gate();
  const sessions: FakeSession[] = [];
  h.runtime.onSession = (session) => {
    sessions.push(session);
    session.script = async (turn) => {
      if (sessions.length === 1 && session.prompts.length === 1) {
        await Promise.race([open.promise, turn.untilCancelled()]);
      }
      turn.emit({ type: "text", messageId: `m${session.prompts.length}`, text: "ok" });
      return "end_turn";
    };
  };
  const status = async (): Promise<AutonomyStatus> => (await h.cmd("autonomy.status")).body;
  const task = (id: string): Task => {
    const found = h.majhi.services.store.tasks.get(id);
    if (found === undefined) throw new Error(`no task ${id}`);
    return found;
  };
  const prompts = () =>
    sessions.flatMap((s) => s.prompts.map((p) => (p[0]?.type === "text" ? p[0].text : "")));
  const world = w;
  return {
    w: world,
    h,
    status,
    task,
    prompts,
    sessions,
    release: () => {
      open.resolve();
      open = gate();
    },
    /** Turns on, and has the boss create and start a task in Acme; waits for its first turn. */
    async startWorking(): Promise<string> {
      const on = await h.cmd("autonomy.start");
      expect(on.status).toBe(200);
      const chat = h.majhi.services.autonomy.chat();
      if (chat === undefined) throw new Error("no autonomy chat");
      const made = await h.majhi.services.admin.call({ task: chat, agent: "boss" }, "majhi_tasks_create", {
        text: "fix the api",
        repos: [{ project: "acme-api" }],
        start: true,
        reason: "the top task of the backlog",
      });
      expect(made.isError).toBe(false);
      const id = (JSON.parse(made.text) as { id: string }).id;
      await world.until(() => sessions[0]?.prompts.length === 1, "the first turn");
      return id;
    },
  };
}

describe("autonomous mode's state machine", () => {
  it("is refused without a boss", async () => {
    plain = await taskWorld();
    const res = await plain.h.cmd("autonomy.start");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("There is no boss yet");
    expect((await plain.h.cmd("autonomy.status")).body.mode).toBe("off");
  });

  it("turns on with an autonomy chat, adopts the boss's task, and pauses it after its current turn", async () => {
    const t = await world();
    const id = await t.startWorking();
    const on = await t.status();
    expect(on.mode).toBe("on");
    expect(on.boss?.chat).toBe(t.h.majhi.services.autonomy.chat());
    expect(on.now.map((n) => n.task)).toEqual([id]);
    const listed = (await t.h.cmd("tasks.list")).body as { id: string; autonomous?: boolean }[];
    expect(listed.find((x) => x.id === id)?.autonomous).toBe(true);
    // The chat is a chat: not on the board, not the owner's Cmd J chat.
    const chat = t.task(on.boss?.chat ?? "");
    expect(listed.find((x) => x.id === chat.id)).toMatchObject({ chat: true });
    expect((await t.h.cmd("boss.chat")).body.id).not.toBe(chat.id);

    expect((await t.h.cmd("autonomy.pause")).body.mode).toBe("paused");
    // Something more for the agent while its turn runs: it waits behind the pause.
    t.h.majhi.services.runs.notify(id, "acme-builder", "one more thing");
    expect(t.task(id).status).toBe("running");
    t.release();
    await t.w.until(() => t.task(id).status === "paused", "the pause");
    expect(t.task(id).pausedReason).toBe("owner");
    expect(t.prompts()).toHaveLength(1);
    expect(t.h.majhi.services.autonomy.repo.task(id)?.held).toBe("owner");
    // Paused: calls that start work are refused.
    const chatCaller = { task: chat.id, agent: "boss" };
    const refused = await t.h.majhi.services.admin.call(chatCaller, "majhi_tasks_start", {
      id,
      reason: "go on",
    });
    expect(refused).toEqual({
      text: "Autonomous mode is paused: nothing new starts until the owner resumes it.",
      isError: true,
    });

    // Resume: exactly the held task goes on, with the prompt that waited and no extra "continue".
    expect((await t.h.cmd("autonomy.start")).body.mode).toBe("on");
    await t.w.until(() => t.prompts().length === 2, "the prompt that waited");
    expect(t.prompts()[1]).toBe("one more thing");
    await t.w.until(() => t.task(id).status !== "paused", "the task to run again");
    expect(t.h.majhi.services.autonomy.repo.task(id)?.held).toBe(undefined);
    const modes = (await t.h.cmd("autonomy.events", { limit: 50 })).body.events
      .filter((e: { kind: string }) => e.kind === "mode")
      .map((e: { text: string }) => e.text);
    expect(modes).toEqual(["Resumed", "Paused", "Turned on"]);
  });

  it("lets the owner resume one held task by hand while paused, until the next pause", async () => {
    const t = await world();
    const id = await t.startWorking();
    const { autonomy, runs } = t.h.majhi.services;
    expect((await t.h.cmd("autonomy.pause")).body.mode).toBe("paused");
    runs.notify(id, "acme-builder", "one more thing");
    t.release();
    await t.w.until(() => t.task(id).status === "paused", "the pause");
    expect(autonomy.repo.task(id)?.held).toBe("owner");

    // The owner resumes this one task by hand: it runs past the pause, and leaves the held set.
    expect((await t.h.cmd("tasks.start", { id })).status).toBe(200);
    await t.w.until(() => t.prompts().includes("one more thing"), "the task to go on");
    await runs.idle(id);
    expect(autonomy.repo.task(id)?.held).toBe(undefined);
    expect(autonomy.holdFor(id)).toBe(undefined);
    const sent = t.prompts().length;

    // Resuming autonomous mode does not start it a second time.
    expect((await t.h.cmd("autonomy.start")).body.mode).toBe("on");
    await runs.idle(id);
    expect(t.prompts()).toHaveLength(sent);

    // The next pause holds it again.
    expect((await t.h.cmd("autonomy.pause")).body.mode).toBe("paused");
    runs.notify(id, "acme-builder", "and another");
    await t.w.until(
      () => t.task(id).status === "paused" && t.task(id).pausedReason === "owner",
      "the next pause",
    );
    expect(t.prompts()).not.toContain("and another");
    expect(autonomy.repo.task(id)?.held).toBe("owner");
  });

  it("stops now: the turn is cut, the task waits for the owner, and the mode is off", async () => {
    const t = await world();
    const id = await t.startWorking();
    const off = (await t.h.cmd("autonomy.stop", { how: "now" })).body as AutonomyStatus;
    expect(off).toMatchObject({ mode: "off", by: "owner" });
    expect(t.sessions[0]?.cancels).toBeGreaterThan(0);
    expect(t.task(id)).toMatchObject({ status: "paused", pausedReason: "owner" });
    // Off: the gate holds nothing, and Resume is a fresh start.
    expect(t.h.majhi.services.autonomy.holdFor(id)).toBe(undefined);
  });

  it("stops gracefully: the current turn finishes, nothing new starts, then majhi turns it off", async () => {
    const t = await world();
    const id = await t.startWorking();
    const stopping = (await t.h.cmd("autonomy.stop", { how: "graceful" })).body as AutonomyStatus;
    expect(stopping.mode).toBe("stopping");
    t.h.majhi.services.runs.notify(id, "acme-builder", "one more thing");
    t.release();
    await t.w.until(async () => (await t.status()).mode === "off", "the stop to finish");
    expect(await t.status()).toMatchObject({
      mode: "off",
      by: "majhi",
      why: "stopped after the current turns",
    });
    expect(t.prompts()).toHaveLength(1);
    expect(t.task(id)).toMatchObject({ status: "paused", pausedReason: "owner" });
    // The held task stays paused: turning on again does not resume it.
    expect((await t.h.cmd("autonomy.start")).body.mode).toBe("on");
    expect(t.task(id).status).toBe("paused");
  });

  it("survives a restart in on, and finishes a stop that was under way", async () => {
    const t = await world();
    const id = await t.startWorking();
    extra = t.h.restart();
    expect((await extra.cmd("autonomy.status")).body).toMatchObject({ mode: "on", now: [{ task: id }] });
    await extra.majhi.close();

    expect((await t.h.cmd("autonomy.stop", { how: "graceful" })).body.mode).toBe("stopping");
    // majhi dies while the turn runs: the new server has no turn in flight, so the stop finishes.
    extra = t.h.restart();
    const again = extra;
    await t.w.until(
      async () => (await again.cmd("autonomy.status")).body.mode === "off",
      "the stop after the restart",
    );
    expect((await again.cmd("autonomy.status")).body).toMatchObject({
      by: "majhi",
      why: "stopped after the current turns",
    });
    t.release();
  });
});
