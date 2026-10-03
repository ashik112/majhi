import type { AutonomyEvent, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { captainScript } from "../testing/captainScript.ts";
import { RUNS } from "./authority-fixtures.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** Acme on "Runs it", autonomous mode on, and a backlog task. Returns the lane's chat. */
async function lane(text = "Fix the typo on the login page\n\nsmall") {
  w = await bossWorld();
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  const made = await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: false });
  expect(made.status).toBe(200);
  return { w, h, chat, task: (made.body as Task).id };
}

const events = async (world: BossWorld): Promise<AutonomyEvent[]> =>
  (await world.h.cmd("autonomy.events", { limit: 100 })).body.events;

describe("captain script mode of the fake agent", () => {
  it("runs a lane turn through the real MCP tools: starts a backlog task and logs a note", async () => {
    const { w: world, h, chat, task } = await lane();
    const seen: string[] = [];
    const script = await captainScript(
      world,
      [
        {
          when: /Wake: queue/,
          steps: [
            { tool: "majhi_tasks_start", args: { id: task, reason: "it is next" } },
            { tool: "majhi_autonomy_note", args: { text: "Started the login typo fix", reason: "queue" } },
            { say: "Started it." },
          ],
        },
      ],
      { task: chat, onResult: (r) => seen.push(r.tool) },
    );

    const told = await h.majhi.services.lanes.tell("acme", "Wake: queue has work", "wake");
    expect(told).toEqual({ sent: true, chat });
    const calls = await script.calls(2);

    expect(calls.map((c) => [c.tool, c.isError])).toEqual([
      ["majhi_tasks_start", false],
      ["majhi_autonomy_note", false],
    ]);
    expect(seen).toEqual(["majhi_tasks_start", "majhi_autonomy_note"]);
    expect(h.majhi.services.store.tasks.get(task)?.status).toBe("running");
    expect(
      (await events(world)).some((e) => e.kind === "decision" && e.text === "Started the login typo fix"),
    ).toBe(true);
    await world.until(
      async () => (await world.items(chat)).some((i) => JSON.stringify(i).includes("Started it.")),
      "the captain's reply",
    );
  });

  it("hands a refused call's text to the capture hook", async () => {
    const { w: world, h, chat, task } = await lane("Rework the billing export\n\nlarge");
    h.majhi.services.autonomy.sizes.useRater(async () => ({
      level: "large",
      confidence: 0.7,
      counted: true,
      why: "",
      decisionId: "dec_test",
      provider: "laya",
      by: "Laya",
    }));
    expect((await h.cmd("autonomy.configure", { pick: { size: "small" } })).status).toBe(200);
    const texts: string[] = [];
    const script = await captainScript(
      world,
      [{ when: "Wake", steps: [{ tool: "majhi_tasks_start", args: { id: task, reason: "it is next" } }] }],
      { task: chat, onResult: (r) => texts.push(r.text) },
    );

    await h.majhi.services.lanes.tell("acme", "Wake: queue has work", "wake");
    const [call] = await script.calls(1);

    expect(call?.isError).toBe(true);
    expect(texts).toEqual([
      `Refused: ${task} was not started: it is large, and the size rule is Small only. Pick work the size rule allows.`,
    ]);
    expect(h.majhi.services.store.tasks.get(task)?.status).toBe("inbox");
  });
});
