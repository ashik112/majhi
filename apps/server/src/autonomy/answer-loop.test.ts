import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("autonomy.answer and an agent that keeps asking", () => {
  it("answers a question once, then refuses the same question again with one line and tells the agent once", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { autonomy, room, runs } = h.majhi.services;
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const made = await h.cmd("tasks.create", {
      text: "Fix the api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    const task = (made.body as { id: string }).id;
    const told: string[] = [];
    runs.notify = (_task, agent, text) => {
      told.push(`${agent}: ${text}`);
    };
    const ask = (id: string) =>
      room.post(task, id, {
        type: "choice",
        agent: "acme-builder",
        question: "Should I go on with the migration?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        state: "pending",
      });
    const answer = (id: string) =>
      h.majhi.services.admin.call({ task: chat, agent: "boss" }, "majhi_autonomy_answer", {
        reason: "the brief settles it",
        task,
        item: id,
        option: "yes",
      });

    ask("q1");
    expect((await answer("q1")).isError).toBe(false);
    expect(room.get(task, "q1")).toMatchObject({ state: "answered", by: "captain" });

    for (const id of ["q2", "q3", "q4"]) {
      ask(id);
      const res = await answer(id);
      expect(res).toEqual({
        isError: true,
        text: `@acme-builder keeps asking in ${task} (2 times in 10 minutes); it may be stuck. It is left for the owner. Do not answer it.`,
      });
      expect(room.get(task, id)).toMatchObject({ state: "pending" });
    }
    // One message to the agent for the whole loop.
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("do not ask it again");
  });
});

describe("autonomy.answer and permission prompts", () => {
  it("refuses to approve a prompt with no text or a dangerous one, and lets a rejection through", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { autonomy, room } = h.majhi.services;
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const made = await h.cmd("tasks.create", {
      text: "Fix the api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    const task = (made.body as { id: string }).id;
    const prompt = (id: string, title: string) =>
      room.post(task, id, {
        type: "permission",
        agent: "acme-builder",
        title,
        options: [
          { id: "once", name: "Allow once", kind: "allow_once" },
          { id: "no", name: "Reject", kind: "reject_once" },
        ],
        state: "pending",
      });
    const answer = (item: string, option: string) =>
      h.majhi.services.admin.call({ task: chat, agent: "boss" }, "majhi_autonomy_answer", {
        reason: "test",
        task,
        item,
        option,
      });
    prompt("p1", "…");
    expect((await answer("p1", "once")).text).toContain("no readable tool text");
    prompt("p2", "Bash: git push --force origin main");
    expect((await answer("p2", "once")).text).toContain("it force-pushes");
    // A rejection passes the rule table. (No agent waits on this fake prompt, so majhi says so.)
    expect((await answer("p2", "no")).text).not.toContain("Refused");
    expect(room.get(task, "p1")).toMatchObject({ state: "pending" });
  });
});
