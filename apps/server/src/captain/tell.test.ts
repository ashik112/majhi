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
  const store = {
    tasks: {
      get: (id: string) => (id in orgs ? { id, org: orgs[id], team: ["acme-builder"] } : undefined),
    },
  };
  const tell = new CaptainTell({
    tasks,
    lanes,
    store,
    keys: new CaptainRepo(new Store(":memory:").raw),
    // The lead took a new turn before each note, so the key never refuses here (keys.test.ts has the repeats).
    lastTurn: () => ++turn,
    now: () => state.now,
  } as unknown as ConstructorParameters<typeof CaptainTell>[0]);
  return { state, sent, tell };
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
});
