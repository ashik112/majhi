import type { AutonomyEvent, RoomItem, TaskId } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WAITING_TEXT } from "../admin/service.ts";
import { ASK, RUNS, TIDY } from "../captain/authority-fixtures.ts";
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
  it("approves a pending change within its limits, with the why, an audit row and an event", async () => {
    const t = await on();
    // A change waits for the owner under `when-asked`; ownerAsked counts for nothing now.
    const renamed = await t.call("majhi_orgs_update", { id: "acme", name: "Acme Co", ownerAsked: true });
    expect(renamed.isError).toBe(false);
    expect(renamed.text).not.toBe(WAITING_TEXT);
    const card = (await t.cards()).find((c) => c.command === "orgs.update");
    expect(card).toMatchObject({
      state: "applied",
      autonomy: { decision: "approved", why: "A change within the limits" },
    });
    const audit = (await t.h.cmd("audit.list", { kinds: ["orgs.update"] })).body.entries;
    expect(audit[0]).toMatchObject({ by: "autonomy", decision: "allow", agent: "boss" });
    const approval = (await t.events()).find((e) => e.kind === "approval");
    expect(approval).toMatchObject({
      outcome: "applied",
      command: "orgs.update",
      reason: "the plan says so",
    });
    expect((await t.h.cmd("orgs.list")).body.find((o: { id: string }) => o.id === "acme")?.name).toBe(
      "Acme Co",
    );
  });

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
    const status = (await t.h.cmd("autonomy.status")).body;
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

  it("counts an agent of an autonomous task as autonomous, and adopts what it creates", async () => {
    const t = await on();
    const id = await t.acmeTask();
    const agent = { task: id, agent: "acme-builder" };
    const made = await t.call("majhi_tasks_create", { text: "add a test", start: false }, agent);
    const child = (JSON.parse(made.text) as { id: string }).id;
    expect((await t.cards(id)).find((c) => c.command === "tasks.create")?.autonomy?.decision).toBe(
      "approved",
    );
    const now = (await t.h.cmd("autonomy.status")).body.now.map((n: { task: string }) => n.task);
    expect(now).toEqual(expect.arrayContaining([id, child]));
  });
});

describe("autonomous mode's reach", () => {
  it("counts any other agent in the autonomy chat as autonomous, with none of the captain's tools", async () => {
    const t = await on();
    // A second root agent, made by the owner, that the captain brought into its chat.
    const made = await t.h.cmd("agents.create", {
      id: "helper",
      frontmatter: {
        scope: "root",
        role: "Builder",
        account: "claude-acme",
        model: "sonnet",
        effort: "high",
      },
      instructions: "Help.\n",
    });
    expect(made.status).toBe(200);
    await t.h.majhi.services.tasks.addToTeam(t.chat, "helper");
    const helper = { task: t.chat, agent: "helper" };
    const key = `sk-ant-api03-${"Ab3dE5gH7jK9mN1pQ3sT5vX7zB9".repeat(2)}`;
    const leaked = await t.call("majhi_tasks_create", { text: `use ${key}`, start: false }, helper);
    expect(leaked.isError).toBe(true);
    expect(leaked.text).toContain("looks like a secret");
    // Its change waits for no one: autonomous mode decides it, as for the captain.
    await t.call("majhi_orgs_update", { id: "acme", name: "Acme Helped" }, helper);
    const card = (await t.cards()).find((c) => c.agent === "helper" && c.command === "orgs.update");
    expect(card?.autonomy?.decision).toBe("approved");
    expect((await t.call("majhi_autonomy_plan", { items: [] }, helper)).text).toBe(
      "autonomy.plan is a tool of the captain in its lanes.",
    );
  });

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
  it("are the captain's in its lanes only, and need Autonomous on", async () => {
    const t = await on();
    const id = await t.acmeTask();
    const plan = { items: [{ title: "Ship the api fix", task: id, why: "It is the top task" }] };
    expect(await t.call("majhi_autonomy_plan", plan)).toEqual({
      text: JSON.stringify({ queue: 1 }, null, 2),
      isError: false,
    });
    // A lane's plan is its workspace's.
    expect((await t.h.cmd("autonomy.status")).body.queue).toEqual(
      plan.items.map((i) => ({ ...i, org: "acme" })),
    );
    // An agent of an autonomous task, and the captain in another chat, get an error.
    const agent = await t.call("majhi_autonomy_plan", plan, { task: id, agent: "acme-builder" });
    expect(agent).toMatchObject({
      isError: true,
      text: "autonomy.plan is a tool of the captain in its lanes.",
    });
    const cmdJ = (await t.h.cmd("boss.chat")).body.id as string;
    expect((await t.call("majhi_autonomy_note", { text: "x" }, { task: cmdJ, agent: "boss" })).isError).toBe(
      true,
    );

    const noted = await t.call("majhi_autonomy_note", {
      text: "Waiting for Globex's reset at 14:00",
      unsure: true,
    });
    expect(noted.isError).toBe(false);
    expect((await t.events()).find((e) => e.kind === "decision")).toMatchObject({
      text: "Waiting for Globex's reset at 14:00",
      unsure: true,
      reason: "the plan says so",
    });
    // No card for any of them.
    expect((await t.cards()).filter((c) => c.command.startsWith("autonomy."))).toEqual([]);

    // On, the captain answers; a card that is not there says so.
    const answer = await t.call("majhi_autonomy_answer", { task: id, item: "ask:1", option: "a" });
    expect(answer.text).toBe(`There is no card ask:1 in ${id}.`);
    // Off, the captain acts only when asked: every tool refuses with the same line.
    expect((await t.h.cmd("autonomy.stop", { how: "now" })).body.mode).toBe("off");
    const off = { isError: true, text: "Autonomous is off, so the captain acts only when you ask." };
    expect(await t.call("majhi_autonomy_plan", plan)).toEqual(off);
    expect(await t.call("majhi_autonomy_note", { text: "Off, waiting" })).toEqual(off);
    expect(await t.call("majhi_autonomy_answer", { task: id, item: "ask:1", option: "a" })).toEqual(off);
  });

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

  it("answers questions and routine approval cards on their own rows", async () => {
    const t = await on();
    const id = await t.acmeTask();
    const { room } = t.h.majhi.services;
    room.post(id as TaskId, "ask:q", {
      type: "ask",
      agent: "acme-builder",
      questions: [{ id: "q1", question: "Go?", options: [{ id: "y", label: "Yes" }], freeText: false }],
      state: "pending",
    });
    room.post(id as TaskId, "perm:p", {
      type: "permission",
      agent: "acme-builder",
      title: "Run the tests",
      options: [{ id: "allow", name: "Allow", kind: "allow_once" }],
      state: "pending",
    });
    const answerQuestion = () =>
      t.call("majhi_autonomy_answer", { task: id, item: "ask:q", answers: { q1: "y" } });
    const answerPermission = () =>
      t.call("majhi_autonomy_answer", { task: id, item: "perm:p", option: "allow" });
    const configure = async (authority: Record<string, string>) =>
      expect((await t.h.cmd("autonomy.configure", { orgs: { acme: { authority } } })).status).toBe(200);

    // Questions on "Ask me": left for the owner. Approvals on "Captain decides" does not change that.
    await configure({ questions: "ask", approvals: "decide" });
    expect((await answerQuestion()).text).toBe(
      "Refused: in Acme you decide how agents' questions are answered, so the captain does not answer them. Leave it to the owner.",
    );
    // The routine approval card is the captain's, the question still waits.
    // It gets past the row; the prompt itself is no live one here, so the answer reports that.
    expect((await answerPermission()).text).toBe("That prompt is not waiting for an answer any more.");
    // Approvals on "Ask me": the next card waits.
    room.post(id as TaskId, "perm:p2", {
      type: "permission",
      agent: "acme-builder",
      title: "Run the linter",
      options: [{ id: "allow", name: "Allow", kind: "allow_once" }],
      state: "pending",
    });
    await configure({ questions: "decide", approvals: "ask" });
    expect(
      (await t.call("majhi_autonomy_answer", { task: id, item: "perm:p2", option: "allow" })).text,
    ).toContain("Refused: in Acme you decide routine approval cards");
    expect((await answerQuestion()).isError).toBe(false);
  });

  it("waits while the owner types in that task, and answers in another", async () => {
    const t = await on();
    const { room, events } = t.h.majhi.services;
    const ask = (task: string) =>
      room.post(task as TaskId, "ask:db", {
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
    const tab = {};
    const first = await t.acmeTask();
    const second = await t.acmeTask();
    ask(first);
    ask(second);
    events.typing.report(tab, first);
    const held = await t.call("majhi_autonomy_answer", {
      task: first,
      item: "ask:db",
      answers: { q1: "pg" },
    });
    expect(held).toEqual({
      isError: true,
      text: `waiting: you are typing in ${first}. The captain tries again when you send or leave.`,
    });
    expect(room.get(first, "ask:db")).toMatchObject({ state: "pending" });
    // Another task is not held.
    const other = await t.call("majhi_autonomy_answer", {
      task: second,
      item: "ask:db",
      answers: { q1: "pg" },
    });
    expect(other.isError).toBe(false);
    // Sending or leaving ends the wait.
    events.typing.report(tab, undefined);
    const after = await t.call("majhi_autonomy_answer", {
      task: first,
      item: "ask:db",
      answers: { q1: "pg" },
    });
    expect(after.isError).toBe(false);
  });
});
