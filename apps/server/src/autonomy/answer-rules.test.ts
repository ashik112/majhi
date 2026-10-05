import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
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
