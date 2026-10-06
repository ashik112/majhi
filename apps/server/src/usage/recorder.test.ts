import type { TurnUsage } from "@majhi/acp";
import { describe, expect, it } from "vitest";
import type { Store } from "../store/index.ts";
import { costTurn, UsageRecorder } from "./recorder.ts";
import type { UsageRepo } from "./repo.ts";

const tokens = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const turn = (extra: Partial<TurnUsage>): TurnUsage => ({ ...tokens, reported: true, ...extra });

describe("costTurn", () => {
  it("takes a reported cost as real on an API-key account", () => {
    expect(costTurn(turn({ costUsd: 0.5, model: "claude-sonnet-5-5" }), "api-key", {})).toEqual({
      costUsd: 0.5,
      costSource: "reported",
      estimated: false,
    });
  });

  it("marks a reported cost on a sign-in account as the estimated API equivalent", () => {
    expect(costTurn(turn({ costUsd: 0.5 }), "login", {})).toEqual({
      costUsd: 0.5,
      costSource: "reported",
      estimated: true,
    });
  });

  it("prices unreported cost from the table, estimated, with the owner's rows first", () => {
    expect(costTurn(turn({ model: "claude-sonnet-5-5" }), "api-key", {})).toEqual({
      costUsd: 3, // 2 + 1
      costSource: "table",
      estimated: true,
    });
    const owner = { "gpt-5.5": { input: 1, output: 10, cache_read: 0.1, cache_write: 0 } };
    expect(costTurn(turn({ model: "gpt-5.5" }), "login", owner).costUsd).toBeCloseTo(2);
  });

  it("leaves a turn unpriced when there is no report and no price", () => {
    expect(costTurn(turn({ model: "gpt-9" }), "api-key", {})).toEqual({
      costUsd: null,
      costSource: "none",
      estimated: true,
    });
    expect(costTurn(turn({ model: "claude-sonnet-5-5", reported: false }), "login", {}).costSource).toBe(
      "none",
    );
  });
});

describe("UsageRecorder", () => {
  /** A recorder over a store that knows task PRV-1 of org acme and nothing else. */
  function recorder() {
    const rows: { org: string | null; project: string | null }[] = [];
    const checked: (string | null)[] = [];
    const store = {
      tasks: {
        get: (id: string) => (id === "PRV-1" ? { org: "acme", repos: [{ project: "api" }] } : undefined),
      },
    } as unknown as Store;
    const repo = {
      insert: (row: { org: string | null; project: string | null }) => rows.push(row),
    } as unknown as UsageRepo;
    const rec = new UsageRecorder({
      repo,
      store,
      prices: async () => ({}),
      afterRecord: async (t) => {
        checked.push(t.org);
      },
    });
    return { rec, rows, checked };
  }
  const base = { agent: "writer", account: "main", tool: "claude", auth: "login" } as const;

  it("counts a pseudo task for the workspace its caller names, in the row and in the budget check", async () => {
    const { rec, rows, checked } = recorder();
    await rec.record(
      { ...base, task: "wiki:acme:api", org: "acme", project: "api" },
      turn({ model: "claude-sonnet-5-5" }),
    );
    expect(rows).toEqual([expect.objectContaining({ org: "acme", project: "api" })]);
    expect(checked).toEqual(["acme"]);
  });

  it("leaves a pseudo task with no named workspace without one, and lets a real task's own row win", async () => {
    const { rec, rows } = recorder();
    await rec.record({ ...base, task: "morning-brief" }, turn({}));
    await rec.record({ ...base, task: "PRV-1", org: "globex" }, turn({}));
    expect(rows).toEqual([
      expect.objectContaining({ org: null, project: null }),
      expect.objectContaining({ org: "acme", project: "api" }),
    ]);
  });
});
