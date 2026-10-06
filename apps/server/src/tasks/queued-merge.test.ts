import type { MergeChecks, MergeVerdict, QueuedMerge } from "@majhi/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../store/migrations.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { type QueuedMergePorts, QueuedMerges } from "./queued-merge.ts";

/**
 * "Merge when checks pass" must never merge ahead of a check: only the exact head the owner asked
 * for, only when its check is green, and only on the owner's say-so.
 */

const HEAD = "api@aaaaaaaaaaaa";

function setup() {
  const db = new Database(":memory:");
  const table = MIGRATIONS.find((m) => m.name === "queued merges");
  if (table === undefined) throw new Error("no migration");
  db.exec(table.sql);
  const log = { merged: [] as QueuedMerge[], refused: [] as string[], said: [] as string[] };
  const state: { checks: MergeChecks; status: string; mergeFails?: string } = {
    checks: { head: HEAD, verdict: { kind: "running" } },
    status: "review",
  };
  const ports: QueuedMergePorts = {
    task: (id) => ({ id, status: state.status, repos: 1 }),
    checks: async () => state.checks,
    run: async (q) => {
      log.merged.push(q);
      return state.mergeFails;
    },
    say: (_t, text) => log.said.push(text),
    refuse: (_t, text) => log.refused.push(text),
    changed: () => undefined,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
  const queued = new QueuedMerges(db, ports);
  const ask = () =>
    queued.request({
      task: "ACM-1",
      action: "merge",
      into: "main",
      method: "merge",
      deleteAfter: false,
      by: "owner",
    });
  const checks = (verdict: MergeVerdict, head = HEAD) => {
    state.checks = { head, verdict };
  };
  return { queued, ask, checks, state, log };
}

describe("queued merge", () => {
  it("merges only when the check of the exact recorded head is green, and only once", async () => {
    const { queued, ask, checks, log } = setup();
    await ask();
    await queued.evaluate("ACM-1");
    expect(log.merged).toHaveLength(0);
    expect(queued.get("ACM-1")?.head).toBe(HEAD);
    checks({ kind: "ok" });
    await queued.evaluate("ACM-1");
    await queued.evaluate("ACM-1");
    expect(log.merged.map((m) => m.head)).toEqual([HEAD]);
    expect(queued.get("ACM-1")).toBeUndefined();
  });

  it("never merges when the head moved, even if the new head is green", async () => {
    const { queued, ask, checks, log } = setup();
    await ask();
    checks({ kind: "ok" }, "api@bbbbbbbbbbbb");
    await queued.evaluate("ACM-1");
    expect(log.merged).toHaveLength(0);
    expect(queued.get("ACM-1")).toBeUndefined();
    expect(log.refused).toHaveLength(1);
  });

  it("never merges when a check failed, or the checks never ran on the head", async () => {
    for (const verdict of [
      { kind: "failed", check: "test" },
      { kind: "blocked", why: "it conflicts with main" },
      { kind: "stale", ran: false },
    ] as const) {
      const { queued, ask, checks, log } = setup();
      await ask();
      checks(verdict);
      await queued.evaluate("ACM-1");
      expect(log.merged).toHaveLength(0);
      expect(queued.get("ACM-1")).toBeUndefined();
      expect(log.refused).toHaveLength(1);
    }
  });

  it("is cancelled with the reason when the merge itself refuses, and does not run again", async () => {
    const { queued, ask, checks, state, log } = setup();
    await ask();
    checks({ kind: "ok" });
    state.mergeFails = "api: main has moved";
    await queued.evaluate("ACM-1");
    await queued.evaluate("ACM-1");
    expect(log.merged).toHaveLength(1);
    expect(log.refused).toEqual(["Did not merge into main when the checks passed: api: main has moved."]);
  });

  it("cannot be queued unless the checks of the head are running", async () => {
    const { ask, checks } = setup();
    checks({ kind: "ok" });
    await expect(ask()).rejects.toThrow("not running");
  });
});

describe("queued merge permission", () => {
  let w: World | undefined;
  afterEach(async () => {
    await w?.cleanup();
    w = undefined;
  });

  it("an agent cannot queue a merge", async () => {
    w = await taskWorld();
    const created = await w.h.cmd("tasks.create", {
      text: "fix api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    const res = await w.h.cmd(
      "tasks.queueMerge",
      { id: created.body.id, action: "merge", into: "main" },
      { actor: { kind: "agent", id: "acme-builder" } },
    );
    expect(res.status).not.toBe(200);
    expect(w.h.majhi.services.queuedMerges.get(created.body.id)).toBeUndefined();
  });
});
