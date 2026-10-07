import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { seedStatus } from "../testing/status.ts";

/**
 * Counts come from live state (task-lifecycle 4.6): a task whose status says running but that has no
 * run holds no slot, a restart ends such a task in an honest state, and the lane's count of things
 * for the owner is the Needs you count.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await w?.cleanup();
  w = undefined;
});

const must = (res: { status: number; body: unknown }) => {
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body;
};

async function on() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const services = h.majhi.services;
  // Every agent works until it is stopped, so a started task stays live.
  h.runtime.onSession = (session) => {
    session.script = async (turn) => {
      await turn.untilCancelled();
      return "cancelled";
    };
  };
  must(await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } }));
  must(await h.cmd("autonomy.start"));
  const chat = await services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const call = (tool: string, args: Record<string, unknown>) =>
    services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
  const make = async (text: string): Promise<string> =>
    (must(await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: false })) as Task).id;
  const makeChat = async (): Promise<string> =>
    (
      must(
        await h.cmd("tasks.create", {
          text: "Talk through the plan",
          kind: "chat",
          org: "acme",
          start: false,
        }),
      ) as Task
    ).id;
  /** What a restart leaves behind: status running, no run. */
  const strand = (id: string) =>
    seedStatus(services.store, id, "running", undefined, new Date().toISOString());
  const task = (id: string) => services.store.tasks.get(id);
  return { h, services, call, make, makeChat, strand, task };
}

describe("tasks at once counts live runs", () => {
  it("lets the captain start when the only running task has no run, and counts a live one", async () => {
    const t = await on();
    const stale = await t.make("Fix the typo on the login page");
    t.strand(stale);
    const next = await t.make("Update the README");
    const started = await t.call("majhi_tasks_start", { id: next });
    expect(started.isError).toBe(false);
    expect(t.task(next)?.status).toBe("running");

    // Now one is live: a third waits, naming the live task and not the stale one.
    const third = await t.make("Add a CSV export");
    const no = await t.call("majhi_tasks_start", { id: third });
    expect(no.isError).toBe(true);
    expect(no.text).toContain(`${next} is running`);
    expect(no.text).not.toContain(stale);
  });
});

describe("a restart leaves no task running without a run", () => {
  it("pauses it with reason error when automatic resume is off, and frees the slot", async () => {
    const t = await on();
    must(await t.h.cmd("orgs.update", { id: "acme", resume: { auto: false } }));
    const stale = await t.make("Fix the typo on the login page");
    t.strand(stale);
    await t.services.resilience.startup();
    expect(t.task(stale)).toMatchObject({ status: "paused", pausedReason: "error" });
    const next = await t.make("Update the README");
    expect((await t.call("majhi_tasks_start", { id: next })).isError).toBe(false);
  });
});
