import type { Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { Store } from "../store/index.ts";
import { Lanes } from "./lanes.ts";
import type { CaptainRepo } from "./repo.ts";

/** Urgent work has its own lane chat, so it never queues behind the backlog turn that is running. */
function world() {
  const tasks = new Map<string, Task>();
  const lanes = new Map<string, string>();
  const told: { task: string; text: string }[] = [];
  const repo = {
    lane: (org: string, job = "backlog") => lanes.get(`${org}/${job}`),
    setLane: (org: string, chat: string, _at: string, job = "backlog") =>
      void lanes.set(`${org}/${job}`, chat),
    laneOrg: (chat: string) => [...lanes].find(([, c]) => c === chat)?.[0].split("/")[0],
  } as unknown as CaptainRepo;
  const store = {
    tasks: {
      get: (id: string) => tasks.get(id),
      has: (id: string) => tasks.has(id),
      setText: (id: string, title: string) => {
        const t = tasks.get(id);
        if (t !== undefined) tasks.set(id, { ...t, title });
      },
    },
  } as unknown as Store;
  const config = {
    sections: async () => ({
      boss: "captain",
      orgs: { acme: { name: "Acme" } },
      accounts: { "claude-acme": { org: "acme", tool: "claude" } },
    }),
    settings: async () => ({ autonomy: { orgs: { acme: { account: "claude-acme" } } } }),
  } as unknown as ConfigService;
  const agents = {
    get: async () => ({ ok: true, agent: { frontmatter: { account: "claude-acme" } } }),
  } as unknown as AgentStore;
  const made = {
    create: async () => {
      const id = `T-${tasks.size + 1}`;
      const task = { id, title: "", brief: "lane", status: "running", team: ["captain"] } as unknown as Task;
      tasks.set(id, task);
      return task;
    },
    reopen: async (id: string) => tasks.get(id) as Task,
    tellAgent: async (input: { task: string; text: string }) => void told.push(input),
  };
  const lane = new Lanes({ repo, store, tasks: made, config, agents, now: () => new Date() });
  return { lane, told, tasks };
}

describe("captain lanes by job", () => {
  it("sends reacting work to a second chat of the same captain, and backlog to the first", async () => {
    const w = world();
    const backlog = await w.lane.tell("acme", "tidy", "x", "backlog");
    const urgent = await w.lane.tell("acme", "site is down", "x", "reacting");
    const again = await w.lane.tell("acme", "still down", "x", "reacting");
    expect(backlog).toEqual({ sent: true, chat: "T-1" });
    expect(urgent).toEqual({ sent: true, chat: "T-2" });
    expect(again).toEqual({ sent: true, chat: "T-2" });
    expect(w.tasks.get("T-2")?.title).toBe("Captain: Acme (on call)");
    expect(w.tasks.get("T-1")?.title).toBe("Captain: Acme");
    expect(w.lane.chat("acme")).toBe("T-1");
    expect(w.lane.chat("acme", "reacting")).toBe("T-2");
  });
});
