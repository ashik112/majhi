import type { AutonomyStatus, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ASK, RUNS, TIDY } from "../captain/authority-fixtures.ts";
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
 * A captain world where every agent's first turn waits until `release`, or until it is cancelled, and
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
  const status = async (): Promise<AutonomyStatus> => (await h.cmd("autonomy.status", { detail: true })).body;
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
    /** Turns on, and has the captain create and start a task in Acme; waits for its first turn. */
    async startWorking(): Promise<string> {
      expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
      const on = await h.cmd("autonomy.start");
      expect(on.status).toBe(200);
      const chat = await h.majhi.services.autonomy.laneChat("acme");
      if (chat === undefined) throw new Error("no lane for Acme");
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
  it("is refused without a captain", async () => {
    plain = await taskWorld();
    const res = await plain.h.cmd("autonomy.start");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("There is no captain yet");
    expect((await plain.h.cmd("autonomy.status", { detail: true })).body.mode).toBe("off");
  });

  it("turns on, works in the lane, adopts the captain's task, and finishes its step when turned off", async () => {
    const t = await world();
    const id = await t.startWorking();
    const on = await t.status();
    expect(on.mode).toBe("on");
    expect(on.boss?.chat).toBe(await t.h.majhi.services.autonomy.laneChat("acme"));
    expect(on.now.map((n) => n.task)).toEqual([id]);
    const listed = (await t.h.cmd("tasks.list")).body as { id: string; autonomous?: boolean }[];
    expect(listed.find((x) => x.id === id)?.autonomous).toBe(true);

    expect((await t.h.cmd("autonomy.stop", { how: "graceful" })).body.mode).toBe("stopping");
    // Something more for the agent while its turn runs: it waits behind the stop.
    t.h.majhi.services.runs.notify(id, "acme-builder", "one more thing");
    expect(t.task(id).status).toBe("running");
    // While it turns off, calls that start work are refused.
    const refused = await t.h.majhi.services.admin.call(
      { task: on.boss?.chat ?? "", agent: "boss" },
      "majhi_tasks_start",
      { id, reason: "go on" },
    );
    expect(refused).toEqual({ text: "Autonomous is turning off: nothing new starts.", isError: true });
    t.release();
    await t.w.until(async () => (await t.status()).mode === "off", "the stop to finish");
    expect(t.task(id)).toMatchObject({ status: "paused", pausedReason: "owner", pausedBy: "autonomy-off" });
    expect(t.prompts()).toHaveLength(1);
    // The task is marked, so turning on can resume exactly it.
    expect((await t.status()).stopped).toEqual([id]);

    expect((await t.h.cmd("autonomy.start", { resumeStopped: true })).body.mode).toBe("on");
    await t.w.until(() => t.task(id).status !== "paused", "the task to run again");
    expect(t.task(id).pausedBy).toBeUndefined();
    expect(t.h.majhi.services.autonomy.repo.task(id)?.held).toBe(undefined);
    const modes = (await t.h.cmd("autonomy.events", { limit: 50 })).body.events
      .filter(
        (e: { kind: string; text: string }) => e.kind === "mode" && !e.text.startsWith("The captain works"),
      )
      .map((e: { text: string }) => e.text);
    expect(modes).toEqual([
      "Turned on",
      "Turned off after the current turns",
      "Stopping after the current turns",
      "Turned on",
    ]);
  });

  it("does not resume a task the owner resumed by hand when turning on", async () => {
    const t = await world();
    const id = await t.startWorking();
    const { autonomy, runs } = t.h.majhi.services;
    expect((await t.h.cmd("autonomy.stop", { how: "graceful" })).body.mode).toBe("stopping");
    runs.notify(id, "acme-builder", "one more thing");
    t.release();
    await t.w.until(async () => (await t.status()).mode === "off", "the stop to finish");
    expect(autonomy.repo.task(id)?.held).toBe("owner");

    // The owner resumes this one task by hand: it runs, and leaves the marked set.
    expect((await t.h.cmd("tasks.start", { id })).status).toBe(200);
    await t.w.until(() => t.task(id).status !== "paused", "the task to go on");
    await runs.idle(id);
    expect(autonomy.repo.task(id)?.held).toBe(undefined);
    const sent = t.prompts().length;

    // Turning on with resume does not start it a second time.
    expect((await t.h.cmd("autonomy.start", { resumeStopped: true })).body.mode).toBe("on");
    await runs.idle(id);
    expect(t.prompts()).toHaveLength(sent);
  });

  it("stops now: the turn is cut, the task waits for the owner, and the mode is off", async () => {
    const t = await world();
    const id = await t.startWorking();
    const off = (await t.h.cmd("autonomy.stop", { how: "now" })).body as AutonomyStatus;
    expect(off).toMatchObject({ mode: "off", by: "owner" });
    expect(t.sessions[0]?.cancels).toBeGreaterThan(0);
    expect(t.task(id)).toMatchObject({ status: "paused", pausedReason: "owner", pausedBy: "autonomy-off" });
    // Off: the gate holds nothing.
    expect(t.h.majhi.services.autonomy.holdFor(id)).toBe(undefined);
    // On with resume restarts exactly the tasks it paused, and a task paused by hand stays paused.
    const made = await t.h.cmd("tasks.create", {
      text: "another job",
      repos: [{ project: "acme-api" }],
      attachments: [],
      start: false,
    });
    expect(made.status).toBe(200);
    const other = made.body as Task;
    expect((await t.status()).stopped).toEqual([id]);
    expect((await t.h.cmd("autonomy.start", { resumeStopped: true })).body.mode).toBe("on");
    await t.w.until(() => t.task(id).status === "running", "the paused task to run again");
    expect(t.task(other.id).status).toBe("inbox");
    expect((await t.status()).stopped).toEqual([]);
  });

  it("turns on without resume: the tasks it paused stay paused and are no longer offered", async () => {
    const t = await world();
    const id = await t.startWorking();
    expect((await t.h.cmd("autonomy.stop", { how: "now" })).body.mode).toBe("off");
    expect((await t.status()).stopped).toEqual([id]);
    expect((await t.h.cmd("autonomy.start", { resumeStopped: false })).body.mode).toBe("on");
    expect(t.task(id).status).toBe("paused");
    expect((await t.status()).stopped).toEqual([]);
    expect(t.h.majhi.services.autonomy.repo.task(id)?.held).toBe(undefined);
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
      why: "turned off after the current turns",
    });
    expect(t.prompts()).toHaveLength(1);
    expect(t.task(id)).toMatchObject({ status: "paused", pausedReason: "owner", pausedBy: "autonomy-off" });
    // Turning on without resume leaves it paused.
    expect((await t.h.cmd("autonomy.start")).body.mode).toBe("on");
    expect(t.task(id).status).toBe("paused");
  });

  it("survives a restart in on, and finishes a stop that was under way", async () => {
    const t = await world();
    const id = await t.startWorking();
    extra = t.h.restart();
    expect((await extra.cmd("autonomy.status", { detail: true })).body).toMatchObject({
      mode: "on",
      now: [{ task: id }],
    });
    await extra.majhi.close();

    expect((await t.h.cmd("autonomy.stop", { how: "graceful" })).body.mode).toBe("stopping");
    // majhi dies while the turn runs: the new server has no turn in flight, so the stop finishes.
    extra = t.h.restart();
    const again = extra;
    await t.w.until(
      async () => (await again.cmd("autonomy.status", { detail: true })).body.mode === "off",
      "the stop after the restart",
    );
    expect((await again.cmd("autonomy.status", { detail: true })).body).toMatchObject({
      by: "majhi",
      why: "turned off after the current turns",
    });
    t.release();
  });
});
