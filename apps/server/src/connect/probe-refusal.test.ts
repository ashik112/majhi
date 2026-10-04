import { describe, expect, it } from "vitest";
import { probeToken, refusalReason } from "./oauth.ts";

type Fetch = Parameters<typeof probeToken>[2];

const answer = (status: number, body: string, headers: Record<string, string> = {}): Fetch =>
  (async () => new Response(body, { status, headers })) as unknown as Fetch;

describe("probeToken", () => {
  it("a 403 without insufficient_scope is a refusal with its status and reason, not unreachable", async () => {
    const probe = await probeToken(
      "https://gitlab.example/api/v4/mcp",
      "tok-secret",
      answer(403, JSON.stringify({ message: "403 Forbidden - MCP is not enabled" })),
    );
    expect(probe).toEqual({ kind: "other", status: 403, reason: "403 Forbidden - MCP is not enabled" });
  });

  it("a redirect is a refusal that names where it went, not unreachable", async () => {
    const probe = await probeToken(
      "https://gitlab.example/api/v4/mcp",
      "t",
      answer(302, "", { location: "https://gitlab.example/users/sign_in" }),
    );
    expect(probe).toEqual({
      kind: "other",
      status: 302,
      reason: "it sent majhi to gitlab.example/users/sign_in",
    });
  });

  it("no answer in time is slow, not unreachable", async () => {
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))),
      )) as unknown as Fetch;
    expect(await probeToken("https://gitlab.example/mcp", "t", hang, 20)).toEqual({ kind: "slow" });
  });

  it("a network error is unreachable", async () => {
    const fail = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as Fetch;
    expect(await probeToken("https://gitlab.example/mcp", "t", fail)).toEqual({ kind: "unreachable" });
  });

  it("the reason never carries a token and stays short", () => {
    const r = refusalReason(null, JSON.stringify({ error: "bad Bearer abc123 here" }));
    expect(r).not.toContain("abc123");
    expect(refusalReason(null, JSON.stringify({ message: "m".repeat(500) })).length).toBe(200);
  });
});
