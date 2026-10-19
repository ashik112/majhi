import type { AutonomyEvent, AutonomyStatus, Task, TaskSummary } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRating } from "../decisions/api.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** A rating as Laya gives it, counted. */
const rated = (level: TaskRating["level"]): TaskRating => ({
  ...(level === undefined ? {} : { level }),
  confidence: 0.7,
  counted: level !== undefined,
  why: "",
  decisionId: "dec_test",
  provider: "laya",
  by: "Laya",
});

/**
 * A captain world with Acme set to "Runs it" and autonomous mode on; the captain calls from Acme's
 * lane. Sizes come from a fixed rater: a task whose text says "large", "medium" or "small" is rated
 * so, anything else is not rated.
 */
async function on() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const autonomy = h.majhi.services.autonomy;
  autonomy.sizes.useRater(async (t) => {
    const level = (["large", "medium", "small"] as const).find((l) => t.brief.includes(l));
    return level === undefined ? undefined : rated(level);
  });
  expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const call = (tool: string, args: Record<string, unknown>) =>
    h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
  /** A task the owner made in Acme, not started. */
  const ownerTask = async (text: string, repos = [{ project: "acme-api" }]): Promise<string> => {
    const made = await h.cmd("tasks.create", { text, repos, start: false });
    expect(made.status).toBe(200);
    return (made.body as Task).id;
  };
  const configure = async (pick: Record<string, unknown>) => {
    const res = await h.cmd("autonomy.configure", { pick });
    expect(res.status).toBe(200);
    return res.body as AutonomyStatus;
  };
  const status = async (): Promise<AutonomyStatus> => (await h.cmd("autonomy.status", { detail: true })).body;
  const refused = async (): Promise<AutonomyEvent[]> =>
    ((await h.cmd("autonomy.events", { limit: 100 })).body.events as AutonomyEvent[]).filter(
      (e) => e.kind === "refused",
    );
  return { h, chat, autonomy, call, ownerTask, configure, status, refused };
}

describe("tasks marked Not for autonomous mode", () => {
  it("are left alone by the captain, show in tasks.list, and only the owner sets the mark", async () => {
    const t = await on();
    const id = await t.ownerTask("Migrate the billing tables\n\nsmall");
    const marked = await t.h.cmd("autonomy.exclude", { task: id, exclude: true });
    expect(marked.status).toBe(200);
    const list = (await t.h.cmd("tasks.list")).body as TaskSummary[];
    expect(list.find((s) => s.id === id)?.noAutonomy).toBe(true);
    expect(t.h.majhi.services.store.tasks.get(id)?.noAutonomy).toBe(true);

    const why = `Refused: the owner marked ${id} Not for the captain, so the captain leaves it alone.`;
    expect(await t.call("majhi_tasks_start", { id })).toEqual({ isError: true, text: why });
    expect(await t.call("majhi_tasks_update", { id, title: "Renamed" })).toEqual({
      isError: true,
      text: why,
    });
    expect(
      await t.call("majhi_tasks_create", {
        name: "Test task",
        text: "A child of it",
        parent: id,
        start: false,
      }),
    ).toEqual({
      isError: true,
      text: why,
    });
    // Reading it is fine.
    expect((await t.call("majhi_tasks_get", { id })).isError).toBe(false);

    // The captain cannot clear the mark.
    const agent = await t.call("majhi_autonomy_exclude", { task: id, exclude: false });
    expect(agent.isError).toBe(true);
    expect(t.h.majhi.services.store.tasks.get(id)?.noAutonomy).toBe(true);

    // The owner clears it, and the captain may take it again.
    expect((await t.h.cmd("autonomy.exclude", { task: id, exclude: false })).status).toBe(200);
    expect(t.h.majhi.services.store.tasks.get(id)?.noAutonomy).toBeUndefined();
    expect((await t.call("majhi_tasks_start", { id })).text).not.toContain("Not for autonomous mode");
  });
});
