import { describe, expect, it } from "vitest";
import { MAX_FLOW_MS, SignInFlows } from "./flows.ts";

const owner = { actor: { kind: "owner" as const } };

function clock(start = Date.parse("2026-10-02T10:00:00Z")) {
  let now = start;
  return { now: () => now, tick: (ms: number) => (now += ms) };
}

function device(flows: SignInFlows, org = "acme", host = "github.com", expiresInMs = 900_000) {
  return flows.start({
    org,
    kind: "github",
    host,
    expiresInMs,
    meta: owner,
    secret: { kind: "device", clientId: "Ov23liAcmeExample01", deviceCode: "dev", intervalMs: 5000 },
    shown: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" },
  });
}

describe("SignInFlows", () => {
  it("moves pending to exactly one end state and never back", () => {
    const flows = new SignInFlows();
    const f = device(flows);
    expect(flows.denied(f.id)).toBe(true);
    expect(flows.done(f.id, { account: "octo-acme", alsoUsedBy: [] })).toBe(false);
    expect(flows.cancel(f.id)).toBe(false);
    expect(flows.failed(f.id, "x")).toBe(false);
    expect(flows.get(f.id)?.status.state).toBe("denied");
  });

  it("ends as expired when read past the deadline, never longer than 15 minutes", () => {
    const c = clock();
    const flows = new SignInFlows(c.now);
    const f = device(flows, "acme", "github.com", 60 * 60_000);
    expect(f.expiresAt - c.now()).toBe(MAX_FLOW_MS);
    c.tick(MAX_FLOW_MS - 1);
    expect(flows.get(f.id)?.status.state).toBe("pending");
    c.tick(1);
    expect(flows.get(f.id)?.status.state).toBe("expired");
  });

  it("a confirm waiting past the deadline expires and drops the held token", () => {
    const c = clock();
    const flows = new SignInFlows(c.now);
    const f = device(flows);
    expect(
      flows.toConfirm(f.id, { account: "octo-acme", alsoUsedBy: ["globex"] }, { token: "gho_held" }),
    ).toBe(true);
    c.tick(900_000);
    const after = flows.get(f.id);
    expect(after?.status.state).toBe("expired");
    expect(after?.held).toBeUndefined();
  });

  it("a new start cancels the open flow of the same workspace and host only", () => {
    const flows = new SignInFlows();
    const first = device(flows, "acme");
    const other = device(flows, "globex");
    const again = device(flows, "acme");
    expect(flows.get(first.id)?.status.state).toBe("cancelled");
    expect(flows.get(other.id)?.status.state).toBe("pending");
    expect(flows.get(again.id)?.status.state).toBe("pending");
  });
});
