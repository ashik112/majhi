import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** Above the sandbox (it removes something outside the task), harmless (the folder is not there), and it prints. */
const LINE = "echo ok-$(printf %s done) && rm -rf /tmp/acme-no-such-folder-9f3a";

describe("the captain in a workspace lane never waits on a card", () => {
  it("is refused at once, keeps the card for the owner, and the owner's Allow runs the command in the lane with the output in its next turn", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { services } = h.majhi;
    expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);
    expect((await h.cmd("autonomy.start", { until: null })).status).toBe(200);
    const lane = await services.autonomy.laneChat("acme");
    if (lane === undefined) throw new Error("no lane for Acme");

    // The captain's first turn asks to run the command, as its own shell would, and goes on.
    let outcome: string | undefined = "not asked";
    h.runtime.onSession = (session) => {
      session.script = async (turn) => {
        if (JSON.stringify(turn.blocks).includes("run the check")) {
          outcome = await turn.ask({
            title: LINE,
            kind: "execute",
            command: LINE,
            toolCallId: "t1",
            options: [
              { id: "allow", name: "Allow", kind: "allow_once" },
              { id: "reject", name: "Deny", kind: "reject_once" },
            ],
          });
        }
        return "end_turn";
      };
    };
    services.runs.notify(lane, "boss", "run the check");
    await w.until(() => outcome !== "not asked", "the captain's call to be answered");
    // Answered at once with the refusal; no prompt holds the run.
    expect(outcome).toBe("reject");

    const items = async (): Promise<RoomItem[]> => (await w?.items(lane)) ?? [];
    const card = (await items()).find((i) => i.type === "permission");
    expect(card).toMatchObject({ state: "pending" });
    // The card is the owner's to answer, and the captain cannot.
    expect(() => services.tasks.answerPermission(lane, card?.id ?? "", "allow", "boss")).toThrow(/owner/);

    // The owner clicks Allow: the command runs in the lane's own sandbox through the real process manager.
    expect((await h.cmd("room.permission", { task: lane, item: card?.id, option: "allow" })).status).toBe(
      200,
    );
    await w.until(
      () => services.processes.list(lane).some((p) => p.status !== "running"),
      "the process to end",
    );
    const [proc] = services.processes.list(lane);
    expect(proc?.command).toBe(LINE);
    expect(services.processes.output(lane, proc?.id ?? "", 10)).toContain("ok-done");
    expect((await items()).find((i) => i.type === "permission")).toMatchObject({
      state: "answered",
      chosen: "allow",
    });

    // The captain's next turn carries the result, and nothing says majhi fell back to asking again.
    await w.until(
      () => h.runtime.sessions.some((s) => JSON.stringify(s.prompts).includes("ok-done")),
      "the output to reach the captain's next turn",
    );
    const heard = JSON.stringify(h.runtime.sessions.map((s) => s.prompts));
    expect(heard).not.toContain("could not start it for you");
    expect(heard).not.toContain("Run it again now");
  });
});
