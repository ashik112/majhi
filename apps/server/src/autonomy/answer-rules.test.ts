import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("autonomy.answer and permission prompts", () => {
  it("never answers a permission prompt: a card is there because the workspace's level does not cover it", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { autonomy, room } = h.majhi.services;
    expect((await h.cmd("authority.set", { org: "acme", level: "full" })).status).toBe(200);
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
    prompt("p1", "Bash: git push --force origin main");
    for (const option of ["once", "no"]) {
      expect((await answer("p1", option)).text).toContain("only the owner answers it");
    }
    expect(room.get(task, "p1")).toMatchObject({ state: "pending" });
  });
});
