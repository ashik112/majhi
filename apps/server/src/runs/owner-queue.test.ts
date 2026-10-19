import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const services = () => w.h.majhi.services;

async function owner(id: string): Promise<Extract<RoomItem, { type: "owner" }>> {
  const item = services().room.get("ACM-1", id);
  if (item?.type !== "owner") throw new Error("not an owner item");
  return item;
}

/** A started task whose agent finished its first turn, with another agent holding its worktree. */
async function lockedTask() {
  w = await taskWorld();
  const res = await w.h.cmd("tasks.create", {
    text: "fix api",
    repos: [{ project: "acme-api" }],
    start: true,
  });
  expect(res.status).toBe(200);
  await until(
    () =>
      w.h.runtime.sessions[0]?.prompts.length === 1 &&
      services().room.getLive("ACM-1", "acme-builder")?.status === "idle",
    "first turn done",
  );
  const worktree = services().store.tasks.get("ACM-1")?.repos[0]?.worktree;
  if (worktree === undefined) throw new Error("no worktree");
  const release = await services().runs.locks.acquire([worktree], "ACM-1\u0000acme-lead");
  const session = w.h.runtime.sessions[0];
  if (session === undefined) throw new Error("no session");
  const sent = session.prompts.length;
  const say = async (text: string) => {
    const r = await w.h.cmd("room.send", { task: "ACM-1", text });
    expect(r.status).toBe(200);
    return (r.body.item as RoomItem).id;
  };
  return { session, release, sent, say };
}

describe("owner messages waiting for a worktree", () => {
  it("stay queued with the reason until the prompt is sent", async () => {
    const { session, release, sent, say } = await lockedTask();
    const id = await say("no backend changes");
    await until(() => services().room.getLive("ACM-1", "acme-builder")?.lockedBy === "acme-lead", "waiting");
    expect((await owner(id)).queued).toBe(true);
    expect(session.prompts.length).toBe(sent);
    release();
    await until(() => session.prompts.length === sent + 1, "prompt");
    await services().runs.idle();
    expect((await owner(id)).queued).toBe(false);
  });
});
