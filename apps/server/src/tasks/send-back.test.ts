import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

/** tasks.tell on a task in review sends it back to its lead: a turn with the note, and its card settles. */

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const world = (): World => {
  if (w === undefined) throw new Error("no world");
  return w;
};
const cmd = (name: string, body?: unknown) => world().h.cmd(name, body);
const get = async (): Promise<Task> => (await cmd("tasks.get", { id: "ACM-1" })).body;
const items = async () => (await cmd("room.items", { task: "ACM-1", limit: 300 })).body.items as RoomItem[];

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let prompts: string[] = [];

async function inReview(): Promise<void> {
  prompts = [];
  w = await taskWorld();
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      prompts.push(t.text);
      t.emit({ type: "text", messageId: `m-${Math.random()}`, text: "Done." });
      return "end_turn";
    };
  };
  expect(
    (await cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true })).status,
  ).toBe(200);
  await w.h.majhi.services.runs.idle();
  await until(async () => (await get()).status === "review", "review");
}

describe("sending a task in review back to its lead", () => {
  it("gives the idle lead a turn with the note, settles its card as Sent back, and returns to review", async () => {
    await inReview();
    const before = prompts.length;
    const res = await cmd("tasks.tell", { id: "ACM-1", text: "Merge main in and resolve shared.txt" });
    expect(res.status).toBe(200);
    await until(async () => prompts.length > before, "the lead's turn");
    expect(prompts.slice(before).join("\n")).toContain("Merge main in and resolve shared.txt");
    const card = (await items()).find((i) => i.type === "review" && i.state === "settled");
    expect(card?.type === "review" && card.outcome?.text).toBe("Sent back to the lead");
    const notes = (await items()).flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(notes).toContain("Sent back to @acme-builder by the owner: Merge main in and resolve shared.txt");
    await world().h.majhi.services.runs.idle();
    await until(async () => (await get()).status === "review", "review again");
  });

  it("refuses a paused task: there is no lead working to tell", async () => {
    await inReview();
    expect((await cmd("tasks.stop", { id: "ACM-1" })).status).toBe(200);
    const before = prompts.length;
    const res = await cmd("tasks.tell", { id: "ACM-1", text: "More work" });
    expect(res.status).toBe(409);
    expect((await get()).status).toBe("paused");
    expect(prompts.length).toBe(before);
  });
});
