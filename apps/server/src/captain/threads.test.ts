import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { ASK, RUNS } from "./authority-fixtures.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("the captain's threads", () => {
  it("Start fresh ends the session, starts a new one and keeps a summary item in the thread", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { services } = h.majhi;
    const sessions: string[] = [];
    h.runtime.onSession = (session) => {
      sessions.push("session");
      session.script = async (turn) => {
        turn.emit({
          type: "text",
          messageId: `m${session.prompts.length}`,
          text: "Handoff: Acme api work is on track.",
        });
        return "end_turn";
      };
    };
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await services.autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no thread for Acme");

    // The thread has a session once the owner talks in it.
    await services.tasks.send({ task: chat, text: "How is Acme doing?", attachments: [], mode: "queue" });
    await w.until(() => sessions.length === 1, "the thread's first session");
    await services.runs.idle(chat);

    const before = (await w.items(chat)).length;
    const fresh = await h.cmd("captain.startFresh", { org: "acme" });
    expect(fresh.status).toBe(200);
    // The old messages stay, and the summary is an item of the thread.
    const after = await w.items(chat);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((i) => i.id === fresh.body.item.id)).toBe(true);
    // The next message opens a new session instead of resuming the old one.
    await services.tasks.send({ task: chat, text: "Anything new?", attachments: [], mode: "queue" });
    await w.until(() => sessions.length === 2, "a new session");
  });

  it("an owner message opens a thread in a workspace where the captain does not think, bound to that workspace", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { services } = h.majhi;
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: ASK } } })).status).toBe(200);
    expect(await services.autonomy.thinksIn()).not.toContain("acme");
    expect(services.autonomy.laneChats()).toEqual([]);
    const sent = await h.cmd("autonomy.guide", {
      text: "What is going on in Acme?",
      keep: false,
      org: "acme",
    });
    expect(sent.status).toBe(200);
    const chat = String(sent.body.chat);
    // The thread exists and belongs to Acme only; the wake rule is unchanged.
    expect(services.autonomy.laneOrg(chat)).toBe("acme");
    expect(services.autonomy.laneChats()).toEqual([chat]);
    expect(await services.autonomy.thinksIn()).not.toContain("acme");
    expect(services.autonomy.laneOrg(chat)).not.toBe("private");
  });

  it("keeps a standing instruction for the workspace it was given in", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: ASK } } })).status).toBe(200);
    const sent = await h.cmd("autonomy.guide", { text: "Ship kilby first.", keep: true, org: "acme" });
    expect(sent.status).toBe(200);
    expect(sent.body.instruction).toMatchObject({ text: "Ship kilby first.", org: "acme" });
    const status = await h.cmd("autonomy.status", {});
    expect(status.body.settings.instructions.map((i: { org?: string }) => i.org)).toEqual(["acme"]);
  });

  it("refuses Start fresh in a workspace with no thread", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const none = await h.cmd("captain.startFresh", { org: "acme" });
    expect(none.status).toBe(404);
  });
});
