import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const box = (extra: Record<string, unknown> = {}) => ({
  text: "Announce faster search",
  repos: [],
  kind: "ops",
  start: false,
  ...extra,
});
const post = { type: "post", draft: "Search is 3x faster.", channel: "LinkedIn, Acme page" } as const;

describe("a task's kind fields", () => {
  it("are checked against the task's type on write", async () => {
    w = await taskWorld();
    const { tasks } = w.h.majhi.services;
    const bug = (await w.h.cmd("tasks.create", box({ type: "bug" }))).body as Task;
    expect(() => tasks.setFields(bug.id, post)).toThrow(/do not fit/);
    expect(tasks.get(bug.id).fields).toBeUndefined();

    const made = (await w.h.cmd("tasks.create", box({ type: "post" }))).body as Task;
    tasks.setFields(made.id, post);
    expect(tasks.get(made.id).fields).toEqual(post);
    expect(() => tasks.setType(made.id, "bug", "owner")).toThrow(/stays a post/);
  });
});
