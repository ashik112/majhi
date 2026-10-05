import type { PermissionAsk } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { RunLive } from "./live.ts";
import { PermissionFlow } from "./permission-flow.ts";
import type { AgentRun } from "./run.ts";

/** A flow over fakes: the room keeps items by id, the store keeps allowances. Only what the flow calls. */
function flow() {
  const items = new Map<string, RoomItem>();
  const allowances = new Set<string>();
  const room = {
    post: (task: string, id: string, payload: object) => {
      items.set(id, { id, task, seq: items.size, at: "2026-10-04T12:00:00Z", ...payload } as RoomItem);
    },
    get: (_task: string, id: string) => items.get(id),
  } as unknown as RoomService;
  const store = {
    permissions: {
      allow: (_task: string, key: string) => allowances.add(key),
      allowed: (_task: string, key: string) => allowances.has(key),
      log: () => {},
    },
  } as unknown as Store;
  const live = { set: () => {} } as unknown as RunLive;
  const run = {
    task: "PYZ-8",
    agent: "acme-claude",
    runId: 4,
    permSeq: 0,
    perms: [],
    pending: new Map(),
    live: { status: "working" },
  } as unknown as AgentRun;
  const permissions = new PermissionFlow({ store, room }, live, () => new Date("2026-10-04T12:00:00Z"));
  const ask = (title: string): PermissionAsk =>
    ({
      title,
      kind: "other",
      options: [
        { id: "once", name: "Yes", kind: "allow_once" },
        { id: "task", name: "Allow for this task", kind: "allow_always" },
        { id: "no", name: "Deny", kind: "reject_once" },
      ],
    }) as PermissionAsk;
  return { permissions, run, ask, allowances, items };
}

describe("the captain's Allow for this task", () => {
  it("lets that tool run unasked for the rest of the task, and no other tool of its kind", async () => {
    const { permissions, run, ask, allowances, items } = flow();
    const signal = new AbortController().signal;
    const first = permissions.ask(run, ask("mcp__majhi-containers__service_start"), signal);
    permissions.answer(run, "PYZ-8", "perm:4:1", "task", true);
    expect(await first).toBe("task");
    expect([...allowances]).toEqual(["tool:majhi-containers.service_start"]);

    const again = await permissions.ask(run, ask("mcp__majhi-containers__service_start"), signal);
    expect(again).toBe("once");
    expect(items.get("perm:4:2")).toMatchObject({ state: "auto" });

    // Another tool of the same kind still asks.
    void permissions.ask(run, ask("mcp__other__deploy"), signal);
    expect(items.get("perm:4:3")).toMatchObject({ state: "pending" });
  });
});
