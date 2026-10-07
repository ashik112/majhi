import type { AutonomyEvent, RoomItem, TaskId } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WAITING_TEXT } from "../admin/service.ts";
import { ASK, RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { UsageRepo } from "../usage/repo.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

type Approval = Extract<RoomItem, { type: "approval" }>;

/** A captain world with Acme set to Runs it and autonomous mode on; the captain calls from Acme's lane. */
async function on() {
  w = await bossWorld({ real: false });
  const world = w;
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const boss = { task: chat, agent: "boss" };
  const call = (tool: string, args: Record<string, unknown>, caller = boss) =>
    h.majhi.services.admin.call(caller, tool, { reason: "the plan says so", ...args });
  const cards = async (task = chat) =>
    (await world.items(task)).filter((i): i is Approval => i.type === "approval");
  const events = async (): Promise<AutonomyEvent[]> =>
    (await h.cmd("autonomy.events", { limit: 100 })).body.events;
  /** A task of Acme the captain created, so it is autonomous. Not started. */
  const acmeTask = async () => {
    const made = await call("majhi_tasks_create", {
      text: "fix the api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(made.isError).toBe(false);
    return (JSON.parse(made.text) as { id: string }).id;
  };
  return { h, chat, boss, call, cards, events, acmeTask };
}

describe("autonomous mode deciding the cards that would wait", () => {
  it("leaves a destructive call for the owner, and it shows as waiting", async () => {
    const t = await on();
    const id = await t.acmeTask();
    const removed = await t.call("majhi_tasks_remove", { id });
    expect(removed).toEqual({ text: "Left for the owner: Only the owner removes things.", isError: false });
    const card = (await t.cards()).find((c) => c.command === "tasks.remove");
    expect(card).toMatchObject({
      state: "pending",
      autonomy: { decision: "left", why: "Only the owner removes things" },
    });
    expect(t.h.majhi.services.store.tasks.get(id)).toBeDefined();
    const status = (await t.h.cmd("autonomy.status", { detail: true })).body;
    expect(status.waiting).toEqual([
      expect.objectContaining({ task: t.chat, kind: "approval", why: "Only the owner removes things" }),
    ]);
    expect((await t.events()).find((e) => e.kind === "approval")).toMatchObject({ outcome: "left" });
    // The owner still decides it as any card.
    const approved = await t.h.cmd("room.approve", { task: t.chat, item: card?.id, decision: "approve" });
    expect(approved.status).toBe(200);
    expect(t.h.majhi.services.store.tasks.get(id)).toBeUndefined();
  });

  it("pushes only where the org lets it", async () => {
    const t = await on();
    const id = await t.acmeTask();
    const before = await t.call("majhi_tasks_push", { id });
    expect(before.text).toBe(
      "Left for the owner: In Acme you decide when work is pushed, so the captain does not push it.",
    );
    const turnedOn = await t.h.cmd("autonomy.configure", {
      orgs: { acme: { authority: { push: "decide" } } },
    });
    expect(turnedOn.status).toBe(200);
    expect(turnedOn.body.settings.orgs.acme).toEqual({ authority: { ...RUNS, push: "decide" } });
    await t.call("majhi_tasks_push", { id });
    const pushes = (await t.cards()).filter((c) => c.command === "tasks.push");
    expect(pushes.map((c) => c.autonomy?.decision)).toEqual(["left", "approved"]);
    // It ran: a task never started has nothing to push, so the call itself failed.
    expect(pushes[1]?.state).toMatch(/applied|failed/);
    // The setting is a config commit, like every change of the owner's.
    expect((await t.h.log())[0]).toContain("autonomy.configure");
  });

  it("refuses what breaks a hard limit, in every mode, with no card", async () => {
    const t = await on();
    const key = `sk-ant-api03-${"Ab3dE5gH7jK9mN1pQ3sT5vX7zB9".repeat(2)}`;
    const leaked = await t.call("majhi_tasks_create", { text: `call the API with ${key}`, start: false });
    expect(leaked.isError).toBe(true);
    expect(leaked.text).toContain("looks like a secret");
    const forced = await t.call("majhi_tasks_push", { id: "ACM-1", deleteAfter: true });
    expect(forced.isError).toBe(true);
    expect(forced.text).toContain("never deletes a worktree");
    expect(
      (await t.cards()).filter((c) => c.command === "tasks.create" || c.command === "tasks.push"),
    ).toEqual([]);
    const refused = (await t.events()).filter((e) => e.kind === "refused");
    expect(refused).toHaveLength(2);
    expect(JSON.stringify(refused)).not.toContain(key);
    // Off, the captain's chat still keeps to the hard limits; its other calls wait for the owner.
    expect((await t.h.cmd("autonomy.stop", { how: "now" })).body.mode).toBe("off");
    expect((await t.call("majhi_tasks_push", { id: "ACM-1", deleteAfter: true })).isError).toBe(true);
    expect((await t.call("majhi_orgs_update", { id: "acme", name: "Acme Two" })).text).toBe(WAITING_TEXT);
  });
});

describe("autonomous mode's reach", () => {
  it("keeps to the caps when a rule, an auto mode or a lead's own start runs the work", async () => {
    const t = await on();
    const id = await t.acmeTask();
    expect((await t.h.cmd("autonomy.configure", { orgs: { acme: { cap: { tokens: 1 } } } })).status).toBe(
      200,
    );
    // One autonomous turn in Acme reaches its cap.
    new UsageRepo(t.h.majhi.services.store.raw).insert({
      at: new Date().toISOString(),
      task: id,
      agent: "acme-builder",
      account: "claude-acme",
      tool: "claude",
      auth: "login",
      org: "acme",
      project: null,
      runId: null,
      model: null,
      inputTokens: 10,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      costSource: "reported",
      estimated: false,
    });
    // The owner lets changes run unasked: the start runs without a card, but not past the cap.
    expect((await t.h.cmd("policy.set", { change: "auto" })).status).toBe(200);
    const held = "Not started: Acme reached its 1 tokens cap for today. It can start when that lifts.";
    expect(await t.call("majhi_tasks_start", { id })).toEqual({ text: held, isError: true });
    expect(t.h.majhi.services.store.tasks.get(id)?.status).toBe("inbox");
    // A lead starting its subtask under lead_start goes the same way.
    const child = await t.call("majhi_tasks_create", { text: "add a test", parent: id, start: false });
    const childId = (JSON.parse(child.text) as { id: string }).id;
    const lead = await t.h.majhi.services.admin.runAllowed(
      { task: id, agent: "acme-builder" },
      "tasks.start",
      { id: childId },
      { reason: "the next step" },
    );
    expect(lead).toEqual({ text: held, isError: true });
    expect(t.h.majhi.services.store.tasks.get(childId)?.status).toBe("inbox");
  });
});

describe("the captain's own tools", () => {
  it("answers an agent's card in an autonomous task through the owner's path, and never secrets or approvals", async () => {
    const t = await on();
    const id = await t.acmeTask();
    const { room } = t.h.majhi.services;
    room.post(id as TaskId, "ask:db", {
      type: "ask",
      agent: "acme-builder",
      questions: [
        {
          id: "q1",
          question: "Which database?",
          options: [{ id: "pg", label: "Postgres" }],
          freeText: false,
        },
      ],
      state: "pending",
    });
    room.post(id as TaskId, "secret:key", {
      type: "secret-request",
      agent: "acme-builder",
      name: "acme-key",
      label: "the Acme API key",
      state: "pending",
    });
    const answered = await t.call("majhi_autonomy_answer", {
      task: id,
      item: "ask:db",
      answers: { q1: "pg" },
    });
    expect(answered.isError).toBe(false);
    // The captain's answer, not the owner's: the card says so, and no owner message is posted.
    expect(room.get(id, "ask:db")).toMatchObject({ state: "answered", answers: { q1: "pg" }, by: "captain" });
    const items = (await w?.items(id)) ?? [];
    const lines = items.flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(lines).toContain("Captain answered: Postgres (the plan says so)");
    expect(items.some((i) => i.type === "owner" && i.text.includes("chose"))).toBe(false);
    expect((await t.events()).find((e) => e.kind === "answer")).toMatchObject({ task: id, item: "ask:db" });

    expect((await t.call("majhi_autonomy_answer", { task: id, item: "secret:key", option: "x" })).text).toBe(
      "Only the owner gives secrets.",
    );
    // A card of a task autonomous mode does not run is the owner's.
    const own = (await t.h.cmd("tasks.create", { text: "the owner's own task", start: false })).body
      .id as string;
    room.post(own as TaskId, "ask:own", {
      type: "ask",
      agent: "acme-builder",
      questions: [{ id: "q1", question: "Go?", options: [{ id: "y", label: "Yes" }], freeText: false }],
      state: "pending",
    });
    expect(
      (await t.call("majhi_autonomy_answer", { task: own, item: "ask:own", answers: { q1: "y" } })).text,
    ).toBe(
      "Refused: this lane works in Acme only, and the call is about Private. Each workspace has its own lane.",
    );
    // Where you answer the questions, the captain leaves them to you, in any task of the workspace.
    const mine = (
      await t.h.cmd("tasks.create", {
        text: "the owner's api task",
        repos: [{ project: "acme-api" }],
        start: false,
      })
    ).body.id as string;
    room.post(mine as TaskId, "ask:mine", {
      type: "ask",
      agent: "acme-builder",
      questions: [{ id: "q1", question: "Go?", options: [{ id: "y", label: "Yes" }], freeText: false }],
      state: "pending",
    });
    expect((await t.h.cmd("autonomy.configure", { orgs: { acme: { authority: ASK } } })).status).toBe(200);
    expect(
      (await t.call("majhi_autonomy_answer", { task: mine, item: "ask:mine", answers: { q1: "y" } })).text,
    ).toContain("Refused: in Acme you decide how agents' questions are answered");
  });
});
