import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const input = (requestId?: string) => ({
  text: "fix api",
  repos: [{ project: "acme-api" }],
  start: false,
  ...(requestId === undefined ? {} : { requestId }),
});

describe("tasks.create request id", () => {
  it("makes one task however many times the same id arrives", async () => {
    w = await taskWorld();
    const sent = await Promise.all([
      w.h.cmd("tasks.create", input("req-aaaa-0001")),
      w.h.cmd("tasks.create", input("req-aaaa-0001")),
      w.h.cmd("tasks.create", input("req-aaaa-0001")),
    ]);
    expect(sent.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(sent.map((r) => (r.body as Task).id)).size).toBe(1);
    const list = (await w.h.cmd("tasks.list", {})).body as Task[];
    expect(list).toHaveLength(1);
  });
});
