import { afterEach, describe, expect, it } from "vitest";
import { agentInput } from "../rooms/mcp.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { adminTools } from "./tools.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

/** The agent says the owner asked: under the default `when-asked` mode that skips the card. */
const asked = { ownerAsked: true, reason: "the owner asked" };

describe("what an agent can never ask for", () => {
  it("has no push in its merge tools, and a push sent anyway is refused", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const merge = adminTools().find((t) => t.command === "tasks.merge");
    expect(Object.keys(merge?.inputSchema.properties ?? {})).not.toContain("push");
    expect(Object.keys(agentInput("tasks.merge").shape)).not.toContain("push");
    expect(Object.keys(agentInput("tasks.merge").shape)).toContain("into");

    const task = (
      await h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: false })
    ).body as { id: string };
    const caller = { task: task.id, agent: "acme-builder" };
    const pushed = await h.majhi.services.admin.call(caller, "majhi_tasks_merge", {
      id: task.id,
      push: true,
      ...asked,
    });
    expect(pushed.isError).toBe(true);
    expect((await w.items(task.id)).filter((i) => i.type === "approval")).toEqual([]);
  });
});
