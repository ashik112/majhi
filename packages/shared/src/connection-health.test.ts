import { describe, expect, it } from "vitest";
import {
  type CheckOutcome,
  type ConnectionHealth,
  ConnectionHealthSchema,
  failureFromError,
  failureFromExit,
  failureFromHttp,
  failureFromMcpCode,
  nextHealth,
} from "./connection-health.ts";

const T1 = "2026-10-05T10:00:00.000Z";
const T2 = "2026-10-05T14:00:00.000Z";
const pass: CheckOutcome = {
  ok: true,
  checked: ["Asked GitHub who the token belongs to"],
  account: "acme-dev",
};
const fail = (reason: "rejected" | "unreachable" = "rejected", status?: number): CheckOutcome => ({
  ok: false,
  failure: { reason, ...(status === undefined ? {} : { status }) },
});

const connected = (): ConnectionHealth =>
  nextHealth(nextHealth(undefined, { type: "start", at: T1 }), { type: "result", at: T1, outcome: pass });

describe("nextHealth", () => {
  it("connect only becomes connected after a passing check", () => {
    const connecting = nextHealth(undefined, { type: "start", at: T1 });
    expect(connecting).toEqual({ state: "connecting", since: T1 });
    const done = nextHealth(connecting, { type: "result", at: T2, outcome: pass });
    expect(done).toEqual({
      state: "connected",
      verifiedAt: T2,
      checked: ["Asked GitHub who the token belongs to"],
      account: "acme-dev",
    });
    expect(ConnectionHealthSchema.safeParse(done).success).toBe(true);
  });

  it("a connecting attempt that fails is failed with a typed reason and the exact fix", () => {
    const connecting = nextHealth(undefined, { type: "start", at: T1 });
    const failed = nextHealth(connecting, { type: "result", at: T2, outcome: fail("rejected", 401) });
    expect(failed).toMatchObject({ state: "failed", reason: "rejected", status: 401, at: T2 });
    expect(failed.state === "failed" && failed.fix.length > 0).toBe(true);
  });

  it("keeps the check's own fix and fix link", () => {
    const failed = nextHealth(undefined, {
      type: "result",
      at: T1,
      outcome: {
        ok: false,
        failure: {
          reason: "setup-needed",
          fix: "Turn on the Gmail API.",
          fixUrl: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
        },
      },
    });
    expect(failed).toMatchObject({
      state: "failed",
      fix: "Turn on the Gmail API.",
      fixUrl: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
    });
  });

  it("a re-check failure moves connected to needs-attention and keeps when it last passed", () => {
    const next = nextHealth(connected(), { type: "result", at: T2, outcome: fail("rejected", 401) });
    expect(next).toMatchObject({
      state: "needs-attention",
      reason: "rejected",
      lastVerifiedAt: T1,
      account: "acme-dev",
    });
  });

  it("needs-attention keeps the first lastVerifiedAt through more failures and heals on a pass", () => {
    const attention = nextHealth(connected(), { type: "result", at: T2, outcome: fail("unreachable") });
    const again = nextHealth(attention, {
      type: "result",
      at: "2026-10-05T18:00:00.000Z",
      outcome: fail("rejected", 401),
    });
    expect(again).toMatchObject({ state: "needs-attention", reason: "rejected", lastVerifiedAt: T1 });
    const healed = nextHealth(again, { type: "result", at: T2, outcome: pass });
    expect(healed.state).toBe("connected");
  });

  it("a failed connection never becomes needs-attention, and a pass makes it connected", () => {
    const failed = nextHealth(undefined, { type: "result", at: T1, outcome: fail() });
    expect(nextHealth(failed, { type: "result", at: T2, outcome: fail("unreachable") }).state).toBe("failed");
    expect(nextHealth(failed, { type: "result", at: T2, outcome: pass }).state).toBe("connected");
  });

  it("start moves any state to connecting", () => {
    for (const prev of [connected(), nextHealth(connected(), { type: "result", at: T2, outcome: fail() })]) {
      expect(nextHealth(prev, { type: "start", at: T2 })).toEqual({ state: "connecting", since: T2 });
    }
  });

  it("a pass with no recorded steps still says what it did", () => {
    const done = nextHealth(undefined, { type: "result", at: T1, outcome: { ok: true, checked: [] } });
    expect(done.state === "connected" && done.checked.length).toBe(1);
  });
});

describe("reading a call's result", () => {
  it("maps HTTP statuses", () => {
    expect(failureFromHttp(200)).toBeUndefined();
    expect(failureFromHttp(204)).toBeUndefined();
    expect(failureFromHttp(401)).toBe("rejected");
    expect(failureFromHttp(403)).toBe("forbidden");
    expect(failureFromHttp(404)).toBe("not-found");
    expect(failureFromHttp(429)).toBe("rate-limited");
    expect(failureFromHttp(503)).toBe("service-down");
    expect(failureFromHttp(302)).toBe("unexpected");
  });

  it("maps MCP error codes, and HTTP statuses the SDK puts in the code", () => {
    expect(failureFromMcpCode(401)).toBe("rejected");
    expect(failureFromMcpCode(-32001)).toBe("timeout");
    expect(failureFromMcpCode(-32000)).toBe("unreachable");
    expect(failureFromMcpCode(-32601)).toBe("mcp-error");
  });

  it("maps command exit codes", () => {
    expect(failureFromExit(0, false)).toBeUndefined();
    expect(failureFromExit(127, false)).toBe("tool-missing");
    expect(failureFromExit(1, true)).toBe("tool-missing");
    expect(failureFromExit(1, false)).toBe("not-signed-in");
    expect(failureFromExit(null, false)).toBe("timeout");
  });

  it("reads a thrown error's code and never its message", () => {
    const refused = Object.assign(new Error("401 unauthorized: please log in"), { code: "ECONNREFUSED" });
    expect(failureFromError(refused)).toBe("unreachable");
    const nested = new Error("fetch failed", { cause: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) });
    expect(failureFromError(nested)).toBe("timeout");
    const http = Object.assign(new Error("connection reset"), { code: 403 });
    expect(failureFromError(http)).toBe("forbidden");
    // The message says "Unauthorized"; with no code the answer is the same as any unreadable error.
    expect(failureFromError(new Error("Unauthorized"))).toBe("unreachable");
  });
});
