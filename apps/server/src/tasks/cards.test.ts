import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
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
  expect((await w.h.cmd("tasks.create", { text: "fix api", start: true })).status).toBe(200);
  await idle();
  expect(await status()).toBe("review");
}

describe("the review card", () => {
  it("is posted when the task reaches review, and a later review replaces a pending one", async () => {
    w = await taskWorld();
    await reviewTask();
    const [first] = await ofType("review");
    expect(first).toMatchObject({ state: "pending", lead: "acme-builder" });

    // The owner writes back: the card settles with who and what, and the next review posts a new one.
    await w.h.cmd("room.send", { task: "ACM-1", text: "one more thing" });
    await idle();
    const cards = await ofType("review");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      id: first?.id,
      state: "settled",
      outcome: { text: "Replied to @acme-builder", by: "owner" },
    });
    expect(cards[1]).toMatchObject({ state: "pending" });

    // A second review while one is pending never stacks: the older one is replaced.
    const task = w.h.majhi.services.tasks.get("ACM-1");
    w.h.majhi.services.tasks.cards.review(task);
    const after = await ofType("review");
    expect(after.filter((c) => c.state === "pending")).toHaveLength(1);
    expect(after.find((c) => c.id === cards[1]?.id)).toMatchObject({ state: "replaced" });
  });

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

  it("refuses what the state no longer allows", async () => {
    w = await taskWorld();
    await reviewTask();
    const [card] = await ofType("review");
    const act = (action: string, item = card?.id) =>
      w.h.cmd("room.cardAction", { task: "ACM-1", item, action });

    // Nothing was committed: no merge.
    const merge = await act("merge");
    expect(merge.status).toBe(409);
    expect(merge.body.error).toBe("Nothing to merge: no commits ahead of main.");
    // Resume is for paused cards.
    expect((await act("resume")).status).toBe(409);

    // The task moved on (stopped): the review card settled, and a paused card took over.
    expect((await w.h.cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    const done = await act("done");
    expect(done.status).toBe(409);
    expect(done.body.error).toBe("This card was already answered.");
    const [paused] = await ofType("paused");
    expect(paused).toMatchObject({ state: "pending", reason: "owner" });

    // The task was resumed elsewhere: the paused card's Resume is refused.
    expect((await w.h.cmd("tasks.start", { id: "ACM-1" })).status).toBe(200);
    const resume = await act("resume", paused?.id);
    expect(resume.status).toBe(409);
    expect(resume.body.error).toBe("This card was already answered.");
    expect((await ofType("paused"))[0]).toMatchObject({ state: "settled", outcome: { text: "Resumed" } });
  });

  it("Mark done is refused for a parent with open subtasks", async () => {
    w = await taskWorld();
    await reviewTask();
    expect(
      (await w.h.cmd("tasks.create", { text: "child on api", start: false, parent: "ACM-1" })).status,
    ).toBe(200);
    const options = await w.h.cmd("tasks.shipOptions", { id: "ACM-1" });
    expect(options.body.done).toEqual({
      ok: false,
      why: "1 subtask is not done (ACM-2). It closes by itself when they are.",
    });
    const [card] = await ofType("review");
    const done = await w.h.cmd("room.cardAction", { task: "ACM-1", item: card?.id, action: "done" });
    expect(done.status).toBe(409);
    expect(await status()).toBe("review");
  });
});

describe("owner questions in plain text", () => {
  it("puts the choices under the message, and sends the one picked back to the agent once", async () => {
    w = await taskWorld();
    await reviewTask("The branch is ready. Should I use SQLite or Postgres?");
    const [q] = await ofType("owner-question");
    expect(q).toMatchObject({
      agent: "acme-builder",
      choices: ["Use SQLite", "Postgres"],
      state: "pending",
    });
    const pick = (choice: string) => w.h.cmd("room.answerQuestion", { task: "ACM-1", item: q?.id, choice });
    expect((await pick("MySQL")).status).toBe(409);
    const res = await pick("Postgres");
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ state: "answered", chosen: "Postgres" });
    expect((await pick("Use SQLite")).status).toBe(409);
    const owner = (await items()).filter((i) => i.type === "owner").at(-1);
    expect(owner).toMatchObject({ text: "Owner chose: Postgres", to: "acme-builder" });
  });

  it("gets no buttons when the message is not for the owner", async () => {
    w = await taskWorld();
    await reviewTask("Added the endpoint and its tests.");
    expect(await ofType("owner-question")).toEqual([]);
  });
});
