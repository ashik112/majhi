import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { agentInput } from "../rooms/mcp.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { WAITING_TEXT } from "./service.ts";
import { adminTools } from "./tools.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

/** The agent says the owner asked: under the default `when-asked` mode that skips the card. */
const asked = { ownerAsked: true, reason: "the owner asked" };

describe("an agent saying the owner asked", () => {
  it("skips the card for a low-risk change only", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const { admin } = h.majhi.services;
    const task = (await h.cmd("tasks.create", { text: "fix api", start: false })).body as { id: string };
    const caller = { task: task.id, agent: "acme-builder" };
    const cards = async () =>
      (await w.items(task.id)).filter(
        (i): i is Extract<RoomItem, { type: "approval" }> => i.type === "approval",
      );

    // Low risk: an org's name, a task with no repo. They run at once.
    const renamed = await admin.call(caller, "majhi_orgs_update", { id: "acme", name: "Acme Co", ...asked });
    expect(renamed.text).not.toBe(WAITING_TEXT);
    const chat = await admin.call(caller, "majhi_tasks_create", {
      text: "write release notes",
      start: false,
      ...asked,
    });
    expect(chat.text).not.toBe(WAITING_TEXT);

    // Git accounts, identity, projects, workspace roots, repos attached: the card always shows.
    const waiting = [
      ["majhi_orgs_update", { id: "acme", identity: { name: "Mallory", email: "m@acme.test" } }],
      ["majhi_orgs_update", { id: "acme", lead_start: "org" }],
      ["majhi_orgs_setGitAccount", { id: "acme", host: "github.com", account: "mallory" }],
      ["majhi_projects_update", { id: "acme-api", org: "acme", aliases: ["api"] }],
      ["majhi_projects_remove", { id: "acme-api" }],
      ["majhi_workspaces_set", { workspaces: ["/Users/owner"] }],
      ["majhi_tasks_create", { text: "fix the login bug in api", start: true }],
      ["majhi_tasks_split", { task: task.id, children: [{ text: "api: add a test" }] }],
      ["majhi_tasks_start", { id: task.id }],
    ] as const;
    for (const [tool, input] of waiting) {
      const result = await admin.call(caller, tool, { ...input, ...asked });
      expect([tool, result.text]).toEqual([tool, WAITING_TEXT]);
    }
    expect((await cards()).filter((c) => c.state === "pending")).toHaveLength(waiting.length);
    expect(
      (await h.cmd("orgs.list")).body.find((o: { id: string }) => o.id === "acme")?.identity,
    ).toBeUndefined();
  });

  it("does not change what the owner set: an auto mode still runs", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    expect((await h.cmd("policy.set", { change: "auto" })).status).toBe(200);
    const task = (await h.cmd("tasks.create", { text: "fix api", start: false })).body as { id: string };
    const result = await h.majhi.services.admin.call(
      { task: task.id, agent: "acme-builder" },
      "majhi_orgs_update",
      {
        id: "acme",
        identity: { name: "Ada", email: "ada@acme.test" },
        ownerAsked: false,
        reason: "set up",
      },
    );
    expect(result.text).not.toBe(WAITING_TEXT);
  });
});

describe("what an agent can never ask for", () => {
  it("has no push in its merge tools, and a push sent anyway is refused", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const merge = adminTools().find((t) => t.command === "tasks.merge");
    expect(Object.keys(merge?.inputSchema.properties ?? {})).not.toContain("push");
    expect(Object.keys(agentInput("tasks.merge").shape)).not.toContain("push");
    expect(Object.keys(agentInput("tasks.merge").shape)).toContain("into");

    const task = (await h.cmd("tasks.create", { text: "fix api", start: false })).body as { id: string };
    const caller = { task: task.id, agent: "acme-builder" };
    const pushed = await h.majhi.services.admin.call(caller, "majhi_tasks_merge", {
      id: task.id,
      push: true,
      ...asked,
    });
    expect(pushed).toEqual({
      text: "Agents never push. Merge without push; the owner pushes from Ship.",
      isError: true,
    });
    expect((await w.items(task.id)).filter((i) => i.type === "approval")).toEqual([]);
  });

  it("cannot force a task's removal over uncommitted work", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const remove = adminTools().find((t) => t.command === "tasks.remove");
    expect(Object.keys(remove?.inputSchema.properties ?? {})).not.toContain("force");
    const task = (await h.cmd("tasks.create", { text: "fix api", start: false })).body as { id: string };
    const forced = await h.majhi.services.admin.call(
      { task: task.id, agent: "acme-builder" },
      "majhi_tasks_remove",
      {
        id: task.id,
        force: true,
        ...asked,
      },
    );
    expect(forced.isError).toBe(true);
    expect(forced.text).toContain("Agents cannot remove a task with force");
  });
});
