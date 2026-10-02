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
 * A boss world with autonomous mode on. Sizes come from a fixed rater: a task whose text says
 * "large", "medium" or "small" is rated so, anything else is not rated.
 */
async function on() {
  w = await bossWorld({ real: false });
  const { h } = w;
  const autonomy = h.majhi.services.autonomy;
  autonomy.sizes.useRater(async (t) => {
    const level = (["large", "medium", "small"] as const).find((l) => t.brief.includes(l));
    return level === undefined ? undefined : rated(level);
  });
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = autonomy.chat();
  if (chat === undefined) throw new Error("no autonomy chat");
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
  const status = async (): Promise<AutonomyStatus> => (await h.cmd("autonomy.status")).body;
  const refused = async (): Promise<AutonomyEvent[]> =>
    ((await h.cmd("autonomy.events", { limit: 100 })).body.events as AutonomyEvent[]).filter(
      (e) => e.kind === "refused",
    );
  return { h, chat, autonomy, call, ownerTask, configure, status, refused };
}

describe("the size rule", () => {
  it("refuses the boss's start of a task larger than the rule, with one line why, and lets one that fits start", async () => {
    const t = await on();
    const big = await t.ownerTask("Rework the billing export\n\nlarge");
    const small = await t.ownerTask("Fix the typo on the login page\n\nsmall");
    const before = await t.configure({ size: "small" });
    expect(before.settings.pick).toEqual({ size: "small" });

    const no = await t.call("majhi_tasks_start", { id: big });
    expect(no).toEqual({
      isError: true,
      text: `Refused: ${big} was not started: it is large, and the size rule is Small only. Pick work the size rule allows.`,
    });
    expect(t.h.majhi.services.store.tasks.get(big)?.status).toBe("inbox");
    expect(await t.refused()).toEqual([
      expect.objectContaining({
        command: "tasks.start",
        task: t.chat,
        outcome: "refused",
        reason: "it is next",
        text: expect.stringContaining("it is large, and the size rule is Small only"),
      }),
    ]);

    const yes = await t.call("majhi_tasks_start", { id: small });
    expect(yes.text).not.toContain("size rule");
    expect(await t.refused()).toHaveLength(1);

    // Up to medium lets a medium task start; Any size lets everything.
    const medium = await t.ownerTask("Add CSV export to the reports\n\nmedium");
    await t.configure({ size: "medium" });
    expect((await t.call("majhi_tasks_start", { id: medium })).text).not.toContain("size rule");
    expect((await t.call("majhi_tasks_start", { id: big })).text).toContain(
      "it is large, and the size rule is Up to medium",
    );
    await t.configure({ size: "any" });
    expect((await t.call("majhi_tasks_start", { id: big })).text).not.toContain("size rule");
  });

  it("does not start a task whose size is not known under a size limit", async () => {
    const t = await on();
    const unknown = await t.ownerTask("Look into the flaky deploy");
    await t.configure({ size: "medium" });
    const res = await t.call("majhi_tasks_start", { id: unknown });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      `Refused: ${unknown} was not started: its size is not known (no decision provider could rate it), and the size rule is Up to medium. Pick work the size rule allows.`,
    );
  });

  it("refuses a create that starts work too large, and creates nothing", async () => {
    const t = await on();
    await t.configure({ size: "small" });
    const count = () => t.h.majhi.services.store.tasks.list(true).length;
    const before = count();
    const res = await t.call("majhi_tasks_create", {
      text: "Rewrite the auth layer\n\nlarge",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('"Rewrite the auth layer" was not started: it is large');
    expect(count()).toBe(before);
    // Created but not started: the size rule waits for the start.
    const later = await t.call("majhi_tasks_create", {
      text: "Rewrite the auth layer\n\nlarge",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(later.isError).toBe(false);
    const id = (JSON.parse(later.text) as { id: string }).id;
    expect((await t.call("majhi_tasks_start", { id })).text).toContain("it is large");
  });
});

describe("the org rule", () => {
  it("keeps the boss's task calls to the orgs it may work in", async () => {
    const t = await on();
    const acme = await t.ownerTask("Fix the api\n\nsmall");
    const status = await t.configure({ orgs: ["private"] });
    expect(status.settings.pick).toEqual({ size: "any", orgs: ["private"] });
    const start = await t.call("majhi_tasks_start", { id: acme });
    expect(start).toEqual({
      isError: true,
      text: "Refused: Acme is not one of the orgs autonomous mode may work in.",
    });
    const create = await t.call("majhi_tasks_create", {
      text: "Add a health check",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(create.text).toBe("Refused: Acme is not one of the orgs autonomous mode may work in.");
    // A task with no org is Private, which the rule allows.
    const own = await t.call("majhi_tasks_create", { text: "Write the release notes", start: false });
    expect(own.isError).toBe(false);
    // Back to every org.
    expect((await t.configure({ orgs: null })).settings.pick).toEqual({ size: "any" });
    expect((await t.call("majhi_tasks_start", { id: acme })).text).not.toContain("orgs autonomous mode");
    // An org that does not exist is refused.
    expect((await t.h.cmd("autonomy.configure", { pick: { orgs: ["nowhere"] } })).status).toBe(404);
  });
});

describe("tasks marked Not for autonomous mode", () => {
  it("are left alone by the boss, show in tasks.list, and only the owner sets the mark", async () => {
    const t = await on();
    const id = await t.ownerTask("Migrate the billing tables\n\nsmall");
    const marked = await t.h.cmd("autonomy.exclude", { task: id, exclude: true });
    expect(marked.status).toBe(200);
    const list = (await t.h.cmd("tasks.list")).body as TaskSummary[];
    expect(list.find((s) => s.id === id)?.noAutonomy).toBe(true);
    expect(t.h.majhi.services.store.tasks.get(id)?.noAutonomy).toBe(true);

    const why = `Refused: the owner marked ${id} Not for autonomous mode, so autonomous mode leaves it alone.`;
    expect(await t.call("majhi_tasks_start", { id })).toEqual({ isError: true, text: why });
    expect(await t.call("majhi_tasks_update", { id, title: "Renamed" })).toEqual({
      isError: true,
      text: why,
    });
    expect(await t.call("majhi_tasks_create", { text: "A child of it", parent: id, start: false })).toEqual({
      isError: true,
      text: why,
    });
    // Reading it is fine.
    expect((await t.call("majhi_tasks_get", { id })).isError).toBe(false);

    // The boss cannot clear the mark.
    const agent = await t.call("majhi_autonomy_exclude", { task: id, exclude: false });
    expect(agent.isError).toBe(true);
    expect(t.h.majhi.services.store.tasks.get(id)?.noAutonomy).toBe(true);

    // The owner clears it, and the boss may take it again.
    expect((await t.h.cmd("autonomy.exclude", { task: id, exclude: false })).status).toBe(200);
    expect(t.h.majhi.services.store.tasks.get(id)?.noAutonomy).toBeUndefined();
    expect((await t.call("majhi_tasks_start", { id })).text).not.toContain("Not for autonomous mode");
  });
});

describe("what the boss reads", () => {
  it("lists the backlog with sizes and leaves out what the rules exclude", async () => {
    const t = await on();
    const small = await t.ownerTask("Fix the typo\n\nsmall");
    const big = await t.ownerTask("Rework the export\n\nlarge");
    const marked = await t.ownerTask("Touch the payments code\n\nsmall");
    const own = await t.ownerTask("Write the release notes\n\nsmall", []);
    await t.h.cmd("autonomy.exclude", { task: marked, exclude: true });
    await t.configure({ size: "medium", orgs: ["acme"] });

    const pick = await t.autonomy.pickable(10_000);
    expect(pick.backlog.map((b) => [b.id, b.size])).toEqual([[small, "small"]]);
    expect(pick.leftOut).toBe(3);
    expect(pick.rules[0]).toContain("Task size: Up to medium");
    expect(pick.rules[1]).toBe("Orgs: only Acme.");

    const status = await t.status();
    const row = (id: string) => status.backlog.find((b) => b.task === id);
    expect(row(small)).toMatchObject({ size: "small", sizeNote: "Laya rated it small (0.70)" });
    expect(row(small)?.leftOut).toBeUndefined();
    expect(row(big)?.leftOut).toBe("It is large, and the size rule is Up to medium");
    expect(row(marked)).toMatchObject({ noAutonomy: true, leftOut: "Marked Not for autonomous mode" });
    expect(row(own)?.leftOut).toBe("Private is not one of the orgs autonomous mode may work in");
  });
});

describe("the boss's chat", () => {
  it("cannot be closed or removed while the mode is not off; off, it can, and the next start makes a new one", async () => {
    const t = await on();
    const remove = await t.h.cmd("tasks.remove", { id: t.chat });
    expect(remove.status).toBe(409);
    expect(JSON.stringify(remove.body)).toContain(
      `${t.chat} is the chat autonomous mode works in, so it cannot be removed while autonomous mode is on.`,
    );
    const close = await t.h.cmd("tasks.close", { id: t.chat });
    expect(close.status).toBe(409);
    expect(JSON.stringify(close.body)).toContain("cannot be closed while autonomous mode is on");
    // Paused counts as not off.
    expect((await t.h.cmd("autonomy.pause")).status).toBe(200);
    expect((await t.h.cmd("tasks.remove", { id: t.chat })).status).toBe(409);
    expect(t.h.majhi.services.store.tasks.get(t.chat)).toBeDefined();

    expect((await t.h.cmd("autonomy.stop", { how: "now" })).status).toBe(200);
    expect((await t.h.cmd("tasks.remove", { id: t.chat })).status).toBe(200);
    expect(t.h.majhi.services.store.tasks.get(t.chat)).toBeUndefined();
    expect((await t.status()).boss?.chat).toBeUndefined();

    expect((await t.h.cmd("autonomy.start")).status).toBe(200);
    const next = (await t.status()).boss?.chat;
    expect(next).toBeDefined();
    expect(next).not.toBe(t.chat);
    expect(t.h.majhi.services.store.tasks.get(next ?? "")?.brief).toBe("Autonomous mode");
  });

  it("is made again before a tick when it is gone while the mode is on, so the boss is never woken into nothing", async () => {
    const t = await on();
    // Gone without the guard (a direct delete): the driver's chat is made again, with a line why.
    t.h.majhi.services.store.tasks.remove(t.chat);
    expect(t.autonomy.chat()).toBeUndefined();
    const chat = await t.autonomy.tickChat();
    expect(chat).toBeDefined();
    expect(chat).not.toBe(t.chat);
    expect(t.h.majhi.services.store.tasks.get(chat ?? "")?.team[0]).toBe("boss");
    expect(t.autonomy.chat()).toBe(chat);
    const events = (await t.h.cmd("autonomy.events", { limit: 20 })).body.events as AutonomyEvent[];
    expect(events[0]?.text).toBe(`The boss works in a new chat, ${chat}: ${t.chat} was removed`);
    // A closed chat is reopened, not replaced.
    t.h.majhi.services.store.tasks.setStatus(chat ?? "", "done", undefined, new Date().toISOString());
    expect(await t.autonomy.tickChat()).toBe(chat);
    expect(t.h.majhi.services.store.tasks.get(chat ?? "")?.status).not.toBe("done");
    // Off: no tick, and no chat is made.
    await t.h.cmd("autonomy.stop", { how: "now" });
    expect(await t.autonomy.tickChat()).toBeUndefined();
  });
});
