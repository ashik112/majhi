import type { PromptBlock } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeSession, Script } from "../testing/fakeSession.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** Owner messages queued while an agent turns: they reach the agent once, in order, or not at all when removed. */

let w: World;
afterEach(() => w?.cleanup());

const services = () => w.h.majhi.services;
const runs = () => services().runs;
const send = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("room.send", { task: "ACM-1", text, ...extra });

async function items(): Promise<RoomItem[]> {
  services().room.flush("ACM-1");
  const page = await w.h.cmd("room.items", { task: "ACM-1", limit: 500 });
  return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
}
const systems = async () => (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
const owner = async (text: string) => {
  const item = (await items()).find((i) => i.type === "owner" && i.text === text);
  if (item === undefined) throw new Error(`no owner item "${text}"`);
  return item as Extract<RoomItem, { type: "owner" }>;
};

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A turn that stays open until released or cancelled, or fails with `error` when told. */
function gated(): { script: Script; release: () => void; fail: (error: Error) => void } {
  let release: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const open = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return {
    release: () => release(),
    fail: (error) => fail(error),
    script: async (turn) => {
      turn.emit({ type: "text", messageId: "m", text: "working" });
      await Promise.race([open, turn.untilCancelled()]);
      return "end_turn";
    },
  };
}

/** The text of every prompt a session got, blocks joined. */
const promptTexts = (s: FakeSession | undefined): string[] =>
  (s?.prompts ?? []).map((p: PromptBlock[]) =>
    p.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
  );
const allPrompts = () => w.h.runtime.sessions.flatMap((s) => promptTexts(s));
/** How many prompts, across every session, carry this owner message. */
const deliveries = (text: string) => allPrompts().filter((p) => p.includes(text)).length;

/** Starts ACM-1 with its brief turn held open, and two owner messages queued behind it. */
async function busyWithTwoQueued(): Promise<{ g: ReturnType<typeof gated>; first: FakeSession }> {
  w = await taskWorld();
  const g = gated();
  w.h.runtime.onSession = (session) => {
    if (w.h.runtime.sessions.length === 0) session.script = g.script;
  };
  expect(
    (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true }))
      .status,
  ).toBe(200);
  await until(() => w.h.runtime.sessions[0]?.prompts.length === 1, "the brief turn");
  const first = w.h.runtime.sessions[0];
  if (first === undefined) throw new Error("no session");
  expect((await send("queued one")).body.item.queued).toBe(true);
  expect((await send("queued two")).body.item.queued).toBe(true);
  await until(() => services().room.getLive("ACM-1", "acme-builder")?.queued === 2, "two queued");
  return { g, first };
}

describe("queued owner messages", () => {
  it("reach the restarted session once, in order, after a remount and a Resume during the turn", async () => {
    const { g, first } = await busyWithTwoQueued();
    runs().remount("ACM-1", "acme-builder");
    // Another agent paused the task while this one works; the owner presses Resume.
    await services().tasks.pausedByRuns("ACM-1", "error");
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("paused");
    expect((await w.h.cmd("tasks.start", { id: "ACM-1" })).status).toBe(200);
    expect(await systems()).toContain(
      "@acme-builder is still working on its turn. Your queued messages go when it ends.",
    );
    g.release();
    await runs().idle();

    expect(w.h.runtime.sessions).toHaveLength(2);
    expect(promptTexts(first)).toHaveLength(1);
    const second = promptTexts(w.h.runtime.sessions[1]);
    expect(second).toHaveLength(2);
    expect(second[0]).toContain("queued one");
    expect(second[1]).toContain("queued two");
    expect(deliveries("queued one")).toBe(1);
    expect(deliveries("queued two")).toBe(1);
    expect((await owner("queued one")).queued).toBe(false);
    expect((await owner("queued two")).queued).toBe(false);
  });

  it("reach the fresh session once, in order, after the turn is cut, paused and resumed", async () => {
    const { g, first } = await busyWithTwoQueued();
    expect((await w.h.cmd("room.fresh", { task: "ACM-1" })).status).toBe(200);
    expect(await systems()).toContain("@acme-builder gets a fresh session when this turn ends.");
    // The turn is cut: the run pauses and the task with it.
    g.fail(new Error("fetch failed"));
    await until(async () => (await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status === "paused", "the pause");
    expect(deliveries("queued one")).toBe(0);
    first.script = async () => "end_turn";
    expect((await w.h.cmd("tasks.start", { id: "ACM-1" })).status).toBe(200);
    await runs().idle();

    // The cut turn continues in its own session, then the fresh session reads the two messages.
    expect(promptTexts(first).some((p) => p.startsWith("Continue from where you stopped."))).toBe(true);
    const fresh = w.h.runtime.sessions.at(-1);
    expect(fresh).not.toBe(first);
    const texts = promptTexts(fresh);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("queued one");
    expect(texts[1]).toContain("queued two");
    expect(deliveries("queued one")).toBe(1);
    expect(deliveries("queued two")).toBe(1);
    expect((await owner("queued one")).queued).toBe(false);
    expect((await owner("queued two")).queued).toBe(false);
  });

  it("Send now stops the current turn and sends that message first, once", async () => {
    const { g, first } = await busyWithTwoQueued();
    const two = await owner("queued two");
    expect((await w.h.cmd("room.sendNow", { task: "ACM-1", item: two.id })).status).toBe(200);
    g.release();
    await runs().idle();
    expect(first.cancels).toBe(1);
    expect(promptTexts(first).slice(1)).toEqual([
      expect.stringContaining("queued two"),
      expect.stringContaining("queued one"),
    ]);
    expect(deliveries("queued two")).toBe(1);
    expect(deliveries("queued one")).toBe(1);
    expect((await owner("queued two")).queued).toBe(false);
  });

  it("Send now while the session is still starting sends the message, not holds it", async () => {
    w = await taskWorld();
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
      () => services().room.getLive("ACM-1", "acme-builder")?.status === "starting",
      "the start",
    );
    expect((await send("queued one")).body.item.queued).toBe(true);
    const one = await owner("queued one");
    expect((await w.h.cmd("room.sendNow", { task: "ACM-1", item: one.id })).status).toBe(200);
    // An interrupt sent while the session opens goes too.
    expect((await send("urgent", { mode: "interrupt" })).status).toBe(200);
    opened();
    await runs().idle();
    expect(deliveries("queued one")).toBe(1);
    expect(deliveries("urgent")).toBe(1);
    expect((await owner("queued one")).queued).toBe(false);
  });

  it("Remove drops a queued message and it is never sent", async () => {
    const { g } = await busyWithTwoQueued();
    const one = await owner("queued one");
    const res = await w.h.cmd("room.unqueue", { task: "ACM-1", item: one.id });
    expect(res.status).toBe(200);
    expect(services().room.getLive("ACM-1", "acme-builder")?.queued).toBe(1);
    expect(await owner("queued one")).toMatchObject({ queued: false, removed: true });
    g.release();
    await runs().idle();
    expect(deliveries("queued one")).toBe(0);
    expect(deliveries("queued two")).toBe(1);
    // A message already sent cannot be removed.
    const two = await owner("queued two");
    expect((await w.h.cmd("room.unqueue", { task: "ACM-1", item: two.id })).status).toBe(409);
  });
});
