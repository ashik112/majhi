import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem, TaskId } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const idle = () => w.h.majhi.services.runs.idle();
const items = async (id = "ACM-1") =>
  ((await w.h.cmd("room.items", { task: id, limit: 200 })).body.items as RoomItem[]).reverse();
const ofType = async <T extends RoomItem["type"]>(type: T) =>
  (await items()).filter((i): i is Extract<RoomItem, { type: T }> => i.type === type);
const status = async () => (await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status as string;

/** The agent says `text`, and writes a file in the worktree first when `write` is set. */
function agentSays(text: string, write = false): void {
  let n = 0;
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      if (write) await writeFile(join(w.taskDir("ACM-1"), "acme-api", `work${++n}.txt`), "work\n");
      t.emit({ type: "text", messageId: "m", text });
      return "end_turn";
    };
  };
}

async function reviewTask(text = "Done.", write = false): Promise<void> {
  agentSays(text, write);
  expect(
    (await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true }))
      .status,
  ).toBe(200);
  await idle();
  expect(await status()).toBe("review");
}

describe("the review card", () => {
  it("merges from the card once, and refuses a second click", async () => {
    w = await taskWorld();
    await reviewTask("Done.", true);
    const [card] = await ofType("review");
    const act = (action: string) =>
      w.h.cmd("room.cardAction", { task: "ACM-1", item: card?.id, action, into: "main" });

    const [a, b] = await Promise.all([act("merge"), act("merge")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    expect(ok.body.results).toMatchObject([{ project: "acme-api", into: "main", ok: true }]);
    expect(ok.body.item).toMatchObject({
      state: "settled",
      outcome: { text: "Merged into main and marked done", by: "owner" },
    });
    expect(await status()).toBe("done");
    expect(await git(w.repo("api"), "ls-tree", "--name-only", "main")).toContain("work1.txt");

    const again = await act("merge");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("This card was already answered.");
    expect((await act("done")).status).toBe(409);
  });
});

describe("an ask card", () => {
  it("starts the idea an option names when the owner picks it, and never on the captain's pick", async () => {
    w = await taskWorld();
    agentSays("Asked.");
    must200(
      await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true }),
    );
    await idle();
    const { tasks, coordinator } = w.h.majhi.services;
    const idea = await tasks.create({
      text: "add uptime watches",
      name: "Uptime watches",
      repos: [{ project: "acme-api" }],
      provenance: { kind: "in-chat", room: "ACM-1" as TaskId },
      gate: "agent",
      agent: "acme-builder",
      attachments: [],
      start: false,
    });
    expect(tasks.get(idea.id).idea).toBeDefined();
    const ask = () =>
      coordinator.postAskCard("ACM-1", "acme-builder", [
        {
          id: "q",
          question: "Start the watches now?",
          options: [
            { id: "now", label: "Start it now", start: idea.id },
            { id: "later", label: "Later" },
          ],
          freeText: false,
        },
      ]);

    // The captain's pick starts nothing: an idea waits for the owner.
    const first = await ask();
    await tasks.answerAsk("ACM-1", first.id, { q: "now" }, "majhi-captain");
    expect(tasks.get(idea.id).status).toBe("inbox");

    // The owner's pick is the owner's start.
    const second = await ask();
    must200(await w.h.cmd("room.answerAsk", { task: "ACM-1", item: second.id, answers: { q: "now" } }));
    await idle();
    expect(tasks.get(idea.id).idea).toBeUndefined();
    expect(["running", "review", "done"]).toContain(tasks.get(idea.id).status);
  });
});

function must200(res: { status: number; body: unknown }): void {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
