import type { AutonomyEvent, AutonomyStatus, RoomItem, Task, TaskSummary } from "@majhi/shared";
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
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { level: "runs" } } })).status).toBe(200);
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
  const status = async (): Promise<AutonomyStatus> => (await h.cmd("autonomy.status")).body;
  const refused = async (): Promise<AutonomyEvent[]> =>
    ((await h.cmd("autonomy.events", { limit: 100 })).body.events as AutonomyEvent[]).filter(
      (e) => e.kind === "refused",
    );
  return { h, chat, autonomy, call, ownerTask, configure, status, refused };
}

describe("the size rule", () => {
  it("refuses the captain's start of a task larger than the rule, with one line why, and lets one that fits start", async () => {
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

describe("the workspace's choice and the lane", () => {
  it("lets the captain start work only in a workspace set to Runs it, and only in its own lane's workspace", async () => {
    const t = await on();
    const acme = await t.ownerTask("Fix the api\n\nsmall");
    const own = await t.ownerTask("Write the release notes\n\nsmall", []);
    // Another workspace's task, from Acme's lane: refused, read or write.
    const lane =
      "Refused: this lane works in Acme only, and the call is about Private. Each workspace has its own lane.";
    expect(await t.call("majhi_tasks_start", { id: own })).toEqual({ isError: true, text: lane });
    expect(await t.call("majhi_tasks_get", { id: own })).toEqual({ isError: true, text: lane });
    expect(await t.call("majhi_tasks_create", { text: "Write the notes", start: false })).toEqual({
      isError: true,
      text: lane,
    });
    // Acme set to Keeps things tidy: the captain no longer starts or changes work there.
    expect((await t.h.cmd("autonomy.configure", { orgs: { acme: { level: "tidy" } } })).status).toBe(200);
    const tidy =
      "Refused: Acme is set to Keeps things tidy, so the captain does not start or change work there.";
    expect(await t.call("majhi_tasks_start", { id: acme })).toEqual({ isError: true, text: tidy });
    expect(
      await t.call("majhi_tasks_create", {
        text: "Add a health check",
        repos: [{ project: "acme-api" }],
        start: false,
      }),
    ).toEqual({ isError: true, text: tidy });
    // Runs it again, but only on Codex: work on Acme's Claude account does not start.
    expect(
      (await t.h.cmd("autonomy.configure", { orgs: { acme: { level: "runs", providers: ["codex"] } } }))
        .status,
    ).toBe(200);
    expect(await t.call("majhi_tasks_start", { id: acme })).toEqual({
      isError: true,
      text: "Refused: Acme lets the captain start work on codex only, and this would run on claude.",
    });
    expect((await t.h.cmd("autonomy.configure", { orgs: { acme: { providers: null } } })).status).toBe(200);
    expect((await t.call("majhi_tasks_start", { id: acme })).isError).toBe(false);
    // With Autonomous off, the captain starts nothing.
    expect((await t.h.cmd("autonomy.stop", { how: "now" })).status).toBe(200);
    const other = await t.ownerTask("Add a status page\n\nsmall");
    expect((await t.call("majhi_tasks_start", { id: other })).text).toBe(
      "Refused: Autonomous is off, so the captain does not start or change work in Acme. It acts only when you ask.",
    );
    // A workspace that does not exist is refused.
    expect((await t.h.cmd("autonomy.configure", { orgs: { nowhere: { level: "runs" } } })).status).toBe(404);
  });
});

describe("tasks marked Not for autonomous mode", () => {
  it("are left alone by the captain, show in tasks.list, and only the owner sets the mark", async () => {
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

describe("what the captain reads", () => {
  it("lists the backlog with sizes and leaves out what the rules exclude", async () => {
    const t = await on();
    const small = await t.ownerTask("Fix the typo\n\nsmall");
    const big = await t.ownerTask("Rework the export\n\nlarge");
    const marked = await t.ownerTask("Touch the payments code\n\nsmall");
    const own = await t.ownerTask("Write the release notes\n\nsmall", []);
    await t.h.cmd("autonomy.exclude", { task: marked, exclude: true });
    await t.configure({ size: "medium" });

    // Acme's lane reads Acme's backlog only.
    const pick = await t.autonomy.pickable(10_000, "acme");
    expect(pick.backlog.map((b) => [b.id, b.size])).toEqual([[small, "small"]]);
    expect(pick.leftOut).toBe(2);
    expect(pick.rules[0]).toContain("Task size: Up to medium");
    expect(pick.rules[1]).toBe("Workspace: Acme only. This lane never sees or acts in another workspace.");

    const status = await t.status();
    const row = (id: string) => status.backlog.find((b) => b.task === id);
    expect(row(small)).toMatchObject({ size: "small", sizeNote: "Laya rated it small (0.70)" });
    expect(row(small)?.leftOut).toBeUndefined();
    expect(row(big)?.leftOut).toBe("It is large, and the size rule is Up to medium");
    expect(row(marked)).toMatchObject({ noAutonomy: true, leftOut: "Marked Not for autonomous mode" });
    expect(row(own)?.leftOut).toBe("Private is set to Keeps things tidy");
  });
});

describe("the captain's lane", () => {
  it("cannot be closed or removed, on or off, and is not listed as a task", async () => {
    const t = await on();
    const remove = await t.h.cmd("tasks.remove", { id: t.chat });
    expect(remove.status).toBe(409);
    expect(JSON.stringify(remove.body)).toContain(`${t.chat} is a captain thread, not a task`);
    const close = await t.h.cmd("tasks.close", { id: t.chat });
    expect(close.status).toBe(409);
    expect(JSON.stringify(close.body)).toContain("cannot be closed");
    // Off changes nothing: the thread is never the owner's to delete.
    expect((await t.h.cmd("autonomy.stop", { how: "now" })).status).toBe(200);
    expect((await t.h.cmd("tasks.remove", { id: t.chat })).status).toBe(409);
    expect((await t.h.cmd("tasks.close", { id: t.chat })).status).toBe(409);
    expect(t.h.majhi.services.store.tasks.get(t.chat)).toBeDefined();
    // It can still be read by id (the panel and old links open it), but no list shows it.
    expect((await t.h.cmd("tasks.get", { id: t.chat })).status).toBe(200);
    const listed = (await t.h.cmd("tasks.list", { includeDone: true })).body as TaskSummary[];
    expect(listed.find((x) => x.id === t.chat)).toBeUndefined();
    expect((await t.status()).lanes[0]?.chat).toBe(t.chat);
    // The summary of the store marks it, for the panel.
    expect(t.h.majhi.services.store.tasks.list(true).find((x) => x.id === t.chat)?.lane).toBe(true);
  });

  it("is made again before a tick when it is gone while the mode is on, so the captain is never woken into nothing", async () => {
    const t = await on();
    // Gone without the guard (a direct delete): the lane is made again, with a line why.
    t.h.majhi.services.store.tasks.remove(t.chat);
    const chat = await t.autonomy.laneChat("acme");
    expect(chat).toBeDefined();
    expect(chat).not.toBe(t.chat);
    expect(t.h.majhi.services.store.tasks.get(chat ?? "")?.team[0]).toBe("boss");
    const events = (await t.h.cmd("autonomy.events", { limit: 20 })).body.events as AutonomyEvent[];
    expect(events[0]?.text).toBe(`The captain works in Acme in its lane ${chat}`);
    // A closed lane is reopened, not replaced.
    t.h.majhi.services.store.tasks.setStatus(chat ?? "", "done", undefined, new Date().toISOString());
    expect(await t.autonomy.laneChat("acme")).toBe(chat);
    expect(t.h.majhi.services.store.tasks.get(chat ?? "")?.status).not.toBe("done");
    // A workspace that is not set to Runs it gets no tick lane; off, no lane at all.
    expect(await t.autonomy.laneChat("private")).toBeUndefined();
    await t.h.cmd("autonomy.stop", { how: "now" });
    expect(await t.autonomy.laneChat("acme")).toBeUndefined();
  });
});

describe("turning Off and On again", () => {
  it("names Autonomous on the paused card, and resumes those tasks on turn-on only when asked", async () => {
    const t = await on();
    const id = await t.ownerTask("Fix the typo on the login page\n\nsmall");
    expect((await t.call("majhi_tasks_start", { id })).isError).toBe(false);
    const task = () => t.h.majhi.services.store.tasks.get(id);
    expect(task()?.status).toBe("running");

    expect((await t.h.cmd("autonomy.stop", { how: "now" })).status).toBe(200);
    expect(task()).toMatchObject({ status: "paused", pausedReason: "owner" });
    expect((await t.status()).stopped).toEqual([id]);
    const items = (await t.h.cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[];
    const card = items.find((i) => i.type === "paused" && i.state === "pending");
    expect(card?.type === "paused" && card.why).toContain("Autonomous was turned off");
    expect(task()?.pausedBy).toBe("autonomy-off");

    // Turned on without resuming: the task stays paused, and is no longer offered.
    expect((await t.h.cmd("autonomy.start", { resumeStopped: false })).status).toBe(200);
    expect(task()?.status).toBe("paused");
    expect((await t.status()).stopped).toEqual([]);

    // Stopped again while running, then turned on with resume: it runs again.
    expect((await t.h.cmd("tasks.start", { id })).status).toBe(200);
    expect(task()?.status).toBe("running");
    expect((await t.h.cmd("autonomy.stop", { how: "now" })).status).toBe(200);
    expect((await t.status()).stopped).toEqual([id]);
    expect((await t.h.cmd("autonomy.start", { resumeStopped: true })).status).toBe(200);
    expect(task()?.status).toBe("running");
    expect((await t.status()).stopped).toEqual([]);
  });
});
