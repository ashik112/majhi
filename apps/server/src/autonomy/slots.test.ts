import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("Autonomous and the places to run", () => {
  it("works on at most 2 tasks at once, refuses the third with one line, and never holds the owner's own start", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    // Agents work until the test ends their turns, so the tasks stay running.
    const waiting: (() => void)[] = [];
    h.runtime.onSession = (session) => {
      session.script = async (turn) => {
        await new Promise<void>((end) => waiting.push(end));
        turn.emit({ type: "text", messageId: `m${session.prompts.length}`, text: "ok" });
        return "end_turn";
      };
    };
    expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);
    expect((await h.cmd("autonomy.start", { until: null })).status).toBe(200);
    const chat = await h.majhi.services.autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const call = (tool: string, args: Record<string, unknown>) =>
      h.majhi.services.admin.call({ task: chat, agent: "boss" }, tool, { reason: "it is next", ...args });
    const ownerTask = async (text: string): Promise<string> => {
      const made = await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: false });
      expect(made.status).toBe(200);
      return (made.body as Task).id;
    };
    const status = (id: string) => h.majhi.services.store.tasks.get(id)?.status;

    const [first, second, third] = [
      await ownerTask("Fix the typo on the login page"),
      await ownerTask("Add a CSV export"),
      await ownerTask("Update the README"),
    ] as [string, string, string];
    expect((await call("majhi_tasks_start", { id: first })).isError).toBe(false);
    expect((await call("majhi_tasks_start", { id: second })).isError).toBe(false);
    await w.until(() => status(first) === "running" && status(second) === "running", "two tasks to run");

    const refused = await call("majhi_tasks_start", { id: third });
    expect(refused).toEqual({
      isError: true,
      text: `Autonomous works on 2 tasks at once and ${first}, ${second} are running. ${third} waits.`,
    });
    expect(status(third)).toBe("inbox");

    // The owner's own start is not held by it.
    const mine = await ownerTask("Rename the billing module");
    expect((await h.cmd("tasks.start", { id: mine })).status).toBe(200);
    expect(status(mine)).toBe("running");

    for (const end of waiting.splice(0)) end();
  });
});
