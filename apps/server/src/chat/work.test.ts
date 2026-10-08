import { describe, expect, it, vi } from "vitest";
import type { Parsed } from "../memory/housekeeper.ts";
import { CONN, envelope, world } from "./testing/world.ts";
import { ClientTriage, type TriageDeps } from "./triage.ts";
import { ChatWork } from "./work.ts";

/**
 * A chat the captain holds is handled end to end whatever Auto-pilot and the Start row say: the chat's work never reads
 * either, it starts tasks by the path the incident engine uses.
 */
describe("a captain chat", () => {
  async function chat(decision: string, text: string) {
    const w = world({ tell: "decide", holds: { firstContact: false } });
    const room = await w.linked();
    const started: string[] = [];
    const told: string[] = [];
    let status = "running";
    let said = false;
    let itemId = "";
    const store = Object.assign(Object.create(w.store), {
      tasks: {
        get: () => ({ status, origin: { kind: "client", room, item: itemId } }),
      },
      room: {
        get: (r: string, id: string) => w.store.room.get(r, id),
        page: (r: string, n: number) =>
          r === "ACM-7"
            ? {
                items: said
                  ? [{ type: "agent", agent: "lead", text: "Found it: a bad redirect. Fixed." }]
                  : [],
              }
            : w.store.room.page(r, n),
      },
    });
    const work = new ChatWork({
      store,
      room: w.room,
      findings: { adopt: () => ({}) as never },
      create: async () => ({ id: "ACM-7" }),
      start: async (task) => void started.push(task),
      tell: async (_task, line) => void told.push(line),
      replies: w.replies,
      write: async () => ({ text: "The orders page is fixed.", flags: w.flags() }),
      history: undefined,
      changed: () => undefined,
    });
    const model = async (_o: string, _k: string, _p: string, parse: (t: string) => Parsed<unknown>) => {
      const parsed = parse(decision);
      if (!parsed.ok) throw new Error(parsed.problem);
      return parsed.value;
    };
    const triage = new ClientTriage({
      store: w.store,
      room: w.room,
      model,
      findings: { report: async () => ({ finding: { id: 1 } }), dismiss: vi.fn(), toTask: vi.fn() },
      replies: w.replies,
      wiki: async () => ({ answer: "", found: false }),
      rest: async () => undefined,
      incidents: () => [],
      incident: { linked: () => false, answer: async () => undefined },
      work,
    } as unknown as TriageDeps);
    await w.ingest.deliver(CONN, envelope({ message: "30", text }));
    const item = w.store.room.page(room, 10).items.find((i) => i.type === "client");
    if (item?.type !== "client") throw new Error("no message");
    itemId = item.id;
    await triage.run(w.rooms.room(room), item);
    const outcome = () => {
      const now = w.store.room.get(room, item.id);
      return now?.type === "client" ? now.outcome : undefined;
    };
    return {
      w,
      room,
      work,
      started,
      told,
      outcome,
      finish: (s: string) => {
        status = s;
        said = true;
      },
    };
  }

  it("starts a client's request, and answers the client when it is done", async () => {
    const t = await chat('{"action":"task","reason":"A bug report"}', "The orders page redirects in a loop");
    expect(t.started).toEqual(["ACM-7"]);
    expect(t.outcome()).toMatchObject({ state: "handled", task: "ACM-7", work: "request" });
    await t.work.changedTasks(["ACM-7"]);
    expect(t.w.sent).toEqual([]);
    t.finish("done");
    await t.work.changedTasks(["ACM-7"]);
    await t.work.changedTasks(["ACM-7"]);
    expect(t.w.sent.map((s) => s.text)).toEqual(["The orders page is fixed."]);
    expect(t.outcome()).toMatchObject({ work: "told" });
  });

  it("looks into a question the wiki cannot answer, read only, and sends the answer from the look", async () => {
    const t = await chat('{"action":"answer","reason":"A question"}', "Which region is our database in?");
    expect(t.started).toEqual(["ACM-7"]);
    expect(t.told[0]).toContain("Read only");
    expect(t.outcome()).toMatchObject({ state: "handled", task: "ACM-7", work: "look" });
    t.finish("review");
    await t.work.changedTasks(["ACM-7"]);
    expect(t.w.sent).toHaveLength(1);
  });
});
