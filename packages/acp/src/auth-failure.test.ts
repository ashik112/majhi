import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpAuthRequired } from "./acp-session.ts";
import { isAuthFailure, looksSignedOut } from "./auth-failure.ts";

describe("isAuthFailure", () => {
  it("knows ACP's auth error by its code", () => {
    expect(isAuthFailure(RequestError.authRequired())).toBe(true);
    expect(isAuthFailure(new AcpAuthRequired("Sign-in required"))).toBe(true);
  });

  it("knows the Claude Code and Codex words", () => {
    for (const text of [
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Invalid API key · Please run /login",
      "OAuth token has been revoked · Please run /login",
      'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      "Your refresh token was already used. Please log out and sign in again.",
      "Not logged in",
      "Authentication required",
    ]) {
      expect(looksSignedOut(text), text).toBe(true);
    }
  });

  it("reads the agent's last line of a failed turn, when it is a short error", () => {
    const err = new Error("Internal error");
    expect(
      isAuthFailure(err, "Failed to authenticate: OAuth session expired and could not be refreshed"),
    ).toBe(true);
    expect(isAuthFailure(err, "Done. The tests pass.")).toBe(false);
    // Prose about authentication is not an auth error.
    const prose = `I added the keyring fallback. ${"The helper now checks the keyring before it asks. ".repeat(10)}Authentication required screens still show.`;
    expect(isAuthFailure(err, prose)).toBe(false);
  });

  it("leaves other failures alone", () => {
    expect(isAuthFailure(new Error("Overloaded"))).toBe(false);
    expect(isAuthFailure(new Error("usage limit reached"))).toBe(false);
    expect(isAuthFailure(new Error("prompt is too long"))).toBe(false);
  });
});
