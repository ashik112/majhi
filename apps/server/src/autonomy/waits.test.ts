import type { AccountStatus, AutonomyStatus, QueueItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { evaluateWaits, waitProblem } from "./waits.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const item = (state: "signed-in" | "available"): QueueItem => ({
  title: "Restart the export",
  task: "UMB-6",
  why: "Waits for the account",
  waitFor: { account: "claude-umbrella-pm", state },
});
const NOW = new Date("2026-10-04T20:00:00.000Z");

describe("queue items that wait for an account", () => {
  const status = (s: AccountStatus | undefined) => (id: string) =>
    id === "claude-umbrella-pm" ? s : undefined;

  it("becomes ready, with one line, when the account is signed in again", () => {
    const out = evaluateWaits([item("signed-in")], status("healthy"), NOW, () => true);
    expect(out.queue[0]?.readyAt).toBe(NOW.toISOString());
    expect(out.lifted).toHaveLength(1);
    // Looked at again: nothing new to say.
    const again = evaluateWaits(out.queue, status("healthy"), NOW, () => true);
    expect(again.lifted).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it("keeps waiting while the account is signed out or not checked, and waits again when it falls back", () => {
    expect(evaluateWaits([item("signed-in")], status("needs-login"), NOW, () => true).lifted).toEqual([]);
    expect(evaluateWaits([item("signed-in")], status("unknown"), NOW, () => true).lifted).toEqual([]);
    const ready = evaluateWaits([item("signed-in")], status("healthy"), NOW, () => true).queue;
    const back = evaluateWaits(ready, status("needs-login"), NOW, () => true);
    expect(back.queue[0]?.readyAt).toBeUndefined();
    expect(back.changed).toBe(true);
  });

  it("'available' also needs the account under its limit", () => {
    expect(evaluateWaits([item("available")], status("at-limit"), NOW, () => true).lifted).toEqual([]);
    expect(evaluateWaits([item("signed-in")], status("at-limit"), NOW, () => true).lifted).toHaveLength(1);
    expect(evaluateWaits([item("available")], status("running-high"), NOW, () => false).lifted).toHaveLength(
      1,
    );
  });

  it("a full per-account slot is a reason to wait for 'available', and it lifts when a slot frees", () => {
    const known = () => true;
    const full = () => true;
    expect(waitProblem(item("available"), status("healthy"), known, full)).toBeUndefined();
    expect(waitProblem(item("available"), status("healthy"), known)).toBeDefined();
    const held = evaluateWaits([item("available")], status("healthy"), NOW, () => false, full);
    expect(held.lifted).toEqual([]);
    const freed = evaluateWaits(
      held.queue,
      status("healthy"),
      NOW,
      () => false,
      () => false,
    );
    expect(freed.lifted).toHaveLength(1);
    // Signed-in waits do not care about slots.
    expect(waitProblem(item("signed-in"), status("healthy"), known, full)).toBeDefined();
  });

  it("refuses a wait the account already meets, and an account that does not exist", () => {
    const known = (id: string) => id === "claude-umbrella-pm";
    expect(waitProblem(item("signed-in"), status("healthy"), known)).toBeDefined();
    expect(waitProblem(item("signed-in"), status("needs-login"), known)).toBeUndefined();
    expect(waitProblem(item("signed-in"), status("healthy"), () => false)).toBeDefined();
  });
});

describe("majhi watching the account for the captain", () => {
  it("refuses a stale wait, saves a real one, and wakes the captain when the account is signed in again", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { autonomy, accounts, store } = h.majhi.services;
    // The account's health as the test sets it: a real sign-in needs a browser.
    let health: AccountStatus = "healthy";
    const real = accounts.list.bind(accounts);
    vi.spyOn(accounts, "list").mockImplementation(async () =>
      (await real()).map((a) => (a.id === "claude-acme" ? { ...a, status: health } : a)),
    );
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const call = (tool: string, args: Record<string, unknown>) =>
      h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
    const made = await h.cmd("tasks.create", {
      text: "Fix the typo on the login page",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    const id = (made.body as Task).id;
    const plan = (waitFor: QueueItem["waitFor"]) =>
      call("majhi_autonomy_plan", {
        items: [{ title: "Restart the export", task: id, why: "Waits for the account", waitFor }],
      });
    const queue = async () =>
      ((await h.cmd("autonomy.status", { detail: true })).body as AutonomyStatus).queue;
    const sweep = () => autonomy.sweepNow();

    // The account works: the captain's belief that it does not is refused, nothing is saved.
    const stale = await plan({ account: "claude-acme", state: "signed-in" });
    expect(stale.isError).toBe(true);
    expect(await queue()).toEqual([]);

    // Signed out for real: the wait is saved, and not ready.
    health = "needs-login";
    expect((await plan({ account: "claude-acme", state: "signed-in" })).isError).toBe(false);
    await sweep();
    expect((await queue())[0]?.readyAt).toBeUndefined();

    // Signed in again: the item is ready and the captain's lane hears of it.
    health = "healthy";
    await sweep();
    expect((await queue())[0]?.readyAt).toBeDefined();
    expect(store.tasks.get(id)?.status).toBe("inbox");
  });
});
