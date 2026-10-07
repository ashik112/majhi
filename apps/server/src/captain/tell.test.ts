import { AUTONOMY_CHAT_BRIEF, CHAT_BRIEF } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { CaptainRepo } from "./repo.ts";
import { CaptainTell } from "./tell.ts";

/** `tasks.tell`: who may write to a lead, and where. How often is keyed by the lead's turns: keys.test.ts. */

function setup() {
  const state = {
    now: new Date("2026-10-04T10:00:00.000Z"),
    boss: "boss" as string | undefined,
    fail: undefined as string | undefined,
  };
  let turn = 0;
  const sent: { task: string; agent?: string | undefined; text: string; by: string }[] = [];
  const tasks = {
    captainTell: async (input: { task: string; agent?: string | undefined; text: string; by: string }) => {
      if (state.fail !== undefined) throw new Error(state.fail);
      sent.push(input);
      return { id: input.task, agent: input.agent ?? "acme-builder" };
    },
  };
  const orgs: Record<string, string | undefined> = { "ACM-1": "acme", "GLX-1": "globex", "PRV-1": undefined };
  const lanes = {
    boss: async () => state.boss,
    orgOf: (task: string) => ({ "LOCAL-1": "acme", "LOCAL-2": "globex" })[task],
  };
  // The captain's root chat, another agent's chat with the owner, and the autonomy chat: none is a lane.
  const chats: Record<string, { brief: string; team: string[] }> = {
    "LOCAL-18": { brief: CHAT_BRIEF, team: ["boss"] },
    "LOCAL-19": { brief: CHAT_BRIEF, team: ["acme-builder"] },
    "LOCAL-20": { brief: AUTONOMY_CHAT_BRIEF, team: ["boss"] },
  };
  const store = {
    tasks: {
      get: (id: string) => {
        const chat = chats[id];
        if (chat !== undefined) return { id, kind: "chat", org: undefined, ...chat };
        return id in orgs ? { id, kind: "code", org: orgs[id], team: ["acme-builder"] } : undefined;
      },
    },
  };
  const owner: Record<string, string[]> = {};
  const tell = new CaptainTell({
    tasks,
    lanes,
    store: {
      ...store,
      room: { ofType: (task: string) => (owner[task] ?? []).map((text) => ({ type: "owner", text })) },
    },
    keys: new CaptainRepo(new Store(":memory:").raw),
    // The lead took a new turn before each note, so the key never refuses here (keys.test.ts has the repeats).
    lastTurn: () => ++turn,
    now: () => state.now,
  } as unknown as ConstructorParameters<typeof CaptainTell>[0]);
  return { state, sent, tell, owner };
}

const lane = { kind: "agent", id: "boss", task: "LOCAL-1" } as const;
const say = (text = "Please also cover the empty state") => ({ id: "ACM-1", text });

describe("tasks.tell", () => {
  it("refuses another workspace's task, and a task of no workspace, from a lane", async () => {
    const t = setup();
    await expect(t.tell.tell({ id: "GLX-1", text: "hi" }, lane)).rejects.toThrow(/another workspace/);
    await expect(t.tell.tell({ id: "PRV-1", text: "hi" }, lane)).rejects.toThrow(/another workspace/);
    await expect(t.tell.tell({ id: "NOPE-1", text: "hi" }, lane)).rejects.toThrow(/no task/);
    expect(t.sent).toEqual([]);
  });

  it("refuses an ordinary agent, and the captain outside a lane", async () => {
    const t = setup();
    await expect(t.tell.tell(say(), { kind: "agent", id: "acme-builder", task: "ACM-1" })).rejects.toThrow(
      /Only the captain/,
    );
    await expect(t.tell.tell(say(), { kind: "agent", id: "boss", task: "ACM-1" })).rejects.toThrow(/lane/);
    await expect(t.tell.tell(say(), { kind: "agent", id: "boss" })).rejects.toThrow(/lane/);
    t.state.boss = undefined;
    await expect(t.tell.tell(say(), lane)).rejects.toThrow(/Only the captain/);
    expect(t.sent).toEqual([]);
  });

  it("lets the captain in its root chat write to a task of any workspace (PRV-139)", async () => {
    const t = setup();
    const root = { kind: "agent", id: "boss", task: "LOCAL-18" } as const;
    await expect(t.tell.tell(say(), root)).resolves.toMatchObject({ id: "ACM-1", told: true });
    await expect(t.tell.tell({ id: "GLX-1", text: "hi" }, root)).resolves.toMatchObject({ told: true });
    await expect(t.tell.tell({ id: "PRV-1", text: "hi" }, root)).resolves.toMatchObject({ told: true });
    expect(t.sent.map((s) => [s.task, s.by])).toEqual([
      ["ACM-1", "boss"],
      ["GLX-1", "boss"],
      ["PRV-1", "boss"],
    ]);
  });

  it("refuses the captain in a chat that is not its root chat, and another agent in a chat with no link to the task", async () => {
    const t = setup();
    await expect(t.tell.tell(say(), { kind: "agent", id: "boss", task: "LOCAL-19" })).rejects.toThrow(/lane/);
    await expect(t.tell.tell(say(), { kind: "agent", id: "boss", task: "LOCAL-20" })).rejects.toThrow(/lane/);
    await expect(t.tell.tell(say(), { kind: "agent", id: "acme-builder", task: "LOCAL-19" })).rejects.toThrow(
      /not a task this chat made/,
    );
    // An agent in a task, not a chat, is not the captain either.
    await expect(t.tell.tell(say(), { kind: "agent", id: "acme-builder", task: "ACM-1" })).rejects.toThrow(
      /Only the captain/,
    );
    expect(t.sent).toEqual([]);
  });

  it("lets an agent in its own chat write to a task the owner named there, as itself", async () => {
    const t = setup();
    t.owner["LOCAL-19"] = ["can you tell the lead of ACM-1 to cover the empty state?"];
    const chat = { kind: "agent", id: "acme-builder", task: "LOCAL-19" } as const;
    await expect(t.tell.tell(say(), chat)).resolves.toMatchObject({ id: "ACM-1", told: true });
    expect(t.sent).toMatchObject([{ task: "ACM-1", by: "acme-builder" }]);
    await expect(t.tell.tell({ id: "GLX-1", text: "hi" }, chat)).rejects.toThrow(/not a task this chat made/);
  });
});
