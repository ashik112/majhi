import type { ConnectionHealth, ConnectionTestResult } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ConnectionHealthService, outcomeOfTest } from "./health.ts";

class MemoryRepo {
  readonly rows = new Map<string, ConnectionHealth>();
  get(id: string) {
    return this.rows.get(id);
  }
  all() {
    return new Map(this.rows);
  }
  set(id: string, health: ConnectionHealth) {
    this.rows.set(id, health);
  }
  delete(id: string) {
    this.rows.delete(id);
  }
}

const pass = (account?: string): ConnectionTestResult => ({
  ok: true,
  detail: "fine",
  warnings: [],
  at: "2026-10-05T10:00:00.000Z",
  durationMs: 1,
  checked: ["Called the service with the stored sign-in"],
  ...(account === undefined ? {} : { account }),
});
const fail = (reason: "rejected" | "unreachable" | "timeout", status?: number): ConnectionTestResult => ({
  ok: false,
  detail: "a sentence that says everything is fine",
  warnings: [],
  at: "2026-10-05T10:00:00.000Z",
  durationMs: 1,
  failure: { reason, ...(status === undefined ? {} : { status }) },
});

interface Rig {
  health: ConnectionHealthService;
  repo: MemoryRepo;
  changed: number;
  attention: { org: string; key: string; title: string; detail: string }[];
  checks: string[];
  /** What the next checks answer, by connection. */
  next: Map<string, ConnectionTestResult>;
}

function rig(connections = ["acme-gh", "acme-linear"]): Rig {
  const repo = new MemoryRepo();
  const r: Rig = {
    repo,
    changed: 0,
    attention: [],
    checks: [],
    next: new Map(),
    health: undefined as never,
  };
  let health: ConnectionHealthService;
  r.health = health = new ConnectionHealthService({
    repo,
    list: async () => connections.map((id) => ({ id, org: "acme", name: id })),
    check: async (id) => {
      r.checks.push(id);
      const result = r.next.get(id) ?? pass();
      health.observe(id, result);
      return result;
    },
    changed: () => {
      r.changed += 1;
    },
    attention: (item) => r.attention.push(item),
    gap: async () => undefined,
  });
  return r;
}

describe("ConnectionHealthService", () => {
  it("never shows connected without a pass: a failed result with no reason is failed, not a pass", () => {
    const r = rig();
    const state = r.health.observe("acme-gh", { ...fail("rejected"), failure: undefined });
    expect(state).toMatchObject({ state: "failed", reason: "unexpected" });
    expect(outcomeOfTest({ ...fail("rejected"), failure: undefined })).toEqual({
      ok: false,
      failure: { reason: "unexpected" },
    });
  });

  it("a pass is connected with when and what was checked; the state is saved", () => {
    const r = rig();
    r.health.start("acme-gh");
    expect(r.health.get("acme-gh")?.state).toBe("connecting");
    r.health.observe("acme-gh", pass("acme-dev"));
    expect(r.repo.get("acme-gh")).toMatchObject({
      state: "connected",
      checked: ["Called the service with the stored sign-in"],
      account: "acme-dev",
    });
  });

  it("states survive a restart", () => {
    const r = rig();
    r.health.observe("acme-gh", pass());
    const again = new ConnectionHealthService({
      repo: r.repo,
      list: async () => [],
      check: async () => pass(),
      changed: () => undefined,
    });
    expect(again.get("acme-gh")?.state).toBe("connected");
  });

  it("a re-check that fails moves a connected connection to needs-attention, and asks the owner once", async () => {
    const r = rig();
    r.health.observe("acme-gh", pass());
    r.health.observe("acme-gh", fail("rejected", 401));
    expect(r.health.get("acme-gh")).toMatchObject({
      state: "needs-attention",
      reason: "rejected",
      status: 401,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.attention).toHaveLength(1);
    expect(r.attention[0]).toMatchObject({ org: "acme", key: "health:acme-gh:rejected" });
    // The same failure again does not ask again.
    r.health.observe("acme-gh", fail("rejected", 401));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.attention).toHaveLength(1);
  });

  it("a network blip changes the state but never asks the owner to do anything", async () => {
    const r = rig();
    r.health.observe("acme-gh", pass());
    r.health.observe("acme-gh", fail("unreachable"));
    expect(r.health.get("acme-gh")?.state).toBe("needs-attention");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.attention).toEqual([]);
    r.health.observe("acme-gh", pass());
    expect(r.health.get("acme-gh")?.state).toBe("connected");
  });

  it("a connection that never passed stays failed through more failures", () => {
    const r = rig();
    r.health.observe("acme-gh", fail("rejected", 401));
    r.health.observe("acme-gh", fail("timeout"));
    expect(r.health.get("acme-gh")).toMatchObject({ state: "failed", reason: "timeout" });
  });

  it("checks what was never checked once, and sets each state from its own result", async () => {
    const r = rig(["acme-gh", "acme-linear", "acme-sentry"]);
    r.health.observe("acme-sentry", pass());
    r.next.set("acme-gh", pass("acme-dev"));
    r.next.set("acme-linear", fail("rejected", 401));
    await r.health.checkMissing();
    expect(r.checks.sort()).toEqual(["acme-gh", "acme-linear"]);
    expect(r.health.get("acme-gh")?.state).toBe("connected");
    expect(r.health.get("acme-linear")).toMatchObject({ state: "failed", reason: "rejected" });
    expect(r.health.get("acme-sentry")?.state).toBe("connected");
  });

  it("the background pass checks everything except a connection that is connecting", async () => {
    const r = rig();
    r.health.start("acme-linear");
    r.next.set("acme-gh", fail("rejected", 401));
    r.health.observe("acme-gh", pass());
    await r.health.checkAll();
    expect(r.checks).toEqual(["acme-gh"]);
    expect(r.health.get("acme-gh")?.state).toBe("needs-attention");
    expect(r.health.get("acme-linear")?.state).toBe("connecting");
  });

  it("two checks of one connection at once share one call", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.health.check("acme-gh"), r.health.check("acme-gh")]);
    expect(r.checks).toEqual(["acme-gh"]);
    expect(a).toBe(b);
  });

  it("removing a connection drops its state", () => {
    const r = rig();
    r.health.observe("acme-gh", pass());
    r.health.remove("acme-gh");
    expect(r.health.get("acme-gh")).toBeUndefined();
    expect(r.repo.get("acme-gh")).toBeUndefined();
  });

  it("holds nothing but typed facts: no token can enter a state through a detail line", () => {
    const r = rig();
    const state = r.health.observe("acme-gh", {
      ...fail("rejected", 401),
      detail: "Bearer sk-live-0123456789abcdef was refused",
    });
    expect(JSON.stringify(state)).not.toContain("sk-live");
  });
});
