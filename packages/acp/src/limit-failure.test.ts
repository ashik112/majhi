import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { limitFailure, limitLine, parseReset } from "./limit-failure.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
const iso = (s: string): string => new Date(s).toISOString();

describe("limitFailure: Claude Code login", () => {
  it("knows every message", () => {
    for (const text of [
      "Claude AI usage limit reached|1791040000",
      "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
      "5-hour limit reached ∙ resets 3pm",
      "Weekly limit reached ∙ resets Oct 9, 3pm",
      "Opus weekly limit reached ∙ resets Oct 9, 3pm",
      "You've hit your limit · resets 3pm (Europe/Berlin)",
      "You’ve hit your weekly limit · resets Oct 9, 3pm (Europe/Berlin)",
      "You've hit your Opus limit · resets 3pm (Europe/Berlin)",
    ]) {
      expect(limitFailure(new Error(text), undefined, "claude", NOW, "UTC"), text).toBeDefined();
      expect(limitFailure(new Error("Internal error"), text, "claude", NOW, "UTC"), text).toBeDefined();
      expect(limitLine(text, "claude", NOW, "UTC"), text).toBeDefined();
    }
  });

  it("reads the reset: an epoch, or the next 3pm in the zone", () => {
    const epoch = Math.floor(NOW.getTime() / 1000) + 3600;
    expect(
      limitFailure(new Error(`Claude AI usage limit reached|${epoch}`), "", "claude", NOW, "UTC"),
    ).toEqual({
      detail: `Claude AI usage limit reached|${epoch}`,
      resetsAt: iso("2026-10-03T13:00:00Z"),
    });
    expect(
      limitFailure(
        new Error("Claude usage limit reached. Your limit will reset at 3pm (America/New_York)"),
        "",
        "claude",
        NOW,
        "UTC",
      )?.resetsAt,
    ).toBe(iso("2026-10-03T19:00:00Z"));
    expect(
      limitFailure(new Error("You've hit your limit · resets 3pm (Europe/Berlin)"), "", "claude", NOW, "UTC")
        ?.resetsAt,
    ).toBe(iso("2026-10-03T13:00:00Z"));
  });
});

describe("limitFailure: Claude API key", () => {
  it("knows rate, credit and 429 errors, also in the details of an ACP error", () => {
    for (const text of [
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization"}}',
      "rate_limit_error",
      "This request would exceed the rate limit of 50 requests per minute",
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      "Credit balance is too low · Add funds: https://console.anthropic.com/settings/billing",
    ]) {
      expect(limitFailure(new Error(text), undefined, "claude", NOW, "UTC"), text).toBeDefined();
    }
    const acp = new RequestError(-32603, "Internal error", { details: "429 rate_limit_error" });
    expect(limitFailure(acp, undefined, "claude", NOW, "UTC")?.detail).toBe("429 rate_limit_error");
  });

  it("has no reset when the error names none", () => {
    expect(limitFailure(new Error("429 rate_limit_error"), "", "claude", NOW, "UTC")).toEqual({
      detail: "429 rate_limit_error",
    });
  });
});

describe("limitFailure: Codex login", () => {
  it("knows the usage limit and reads a time or a wait", () => {
    const at = limitFailure(
      new Error("You've hit your usage limit. Upgrade to Pro, or try again at 3:40 PM."),
      "",
      "codex",
      NOW,
      "UTC",
    );
    expect(at?.resetsAt).toBe(iso("2026-10-03T15:40:00Z"));
    const wait = limitFailure(
      new Error("You've hit your usage limit. Try again in 2 days 3 hours 4 minutes."),
      "",
      "codex",
      NOW,
      "UTC",
    );
    expect(wait?.resetsAt).toBe(new Date(NOW.getTime() + ((2 * 24 + 3) * 60 + 4) * 60_000).toISOString());
    expect(limitFailure(new Error('{"type":"usage_limit_reached"}'), "", "codex", NOW, "UTC")).toBeDefined();
  });

  it("reads a time of day in the zone it is given, the next day when it passed", () => {
    const text = "You've hit your usage limit. Try again at 11:00 AM.";
    expect(limitFailure(new Error(text), "", "codex", NOW, "UTC")?.resetsAt).toBe(
      iso("2026-10-04T11:00:00Z"),
    );
    expect(limitFailure(new Error(text), "", "codex", NOW, "Asia/Tokyo")?.resetsAt).toBe(
      iso("2026-10-04T02:00:00Z"),
    );
  });

  it("reads a date with the time", () => {
    expect(parseReset("try again at Oct 9th, 2026 3:40 PM", NOW, "UTC")?.toISOString()).toBe(
      iso("2026-10-09T15:40:00Z"),
    );
    expect(parseReset("resets Oct 9, 3pm (Europe/Berlin)", NOW, "UTC")?.toISOString()).toBe(
      iso("2026-10-09T13:00:00Z"),
    );
  });
});

describe("limitFailure: Codex API key", () => {
  it("knows rate limits, quota and the wait", () => {
    const rate = limitFailure(
      new Error(
        "Rate limit reached for gpt-5 in organization org-x on tokens per min. Please try again in 20s.",
      ),
      "",
      "codex",
      NOW,
      "UTC",
    );
    expect(rate?.resetsAt).toBe(new Date(NOW.getTime() + 20_000).toISOString());
    expect(
      limitFailure(
        new Error("1m30.5s"),
        "Rate limit reached for gpt-5. Please try again in 1m30.5s.",
        "codex",
        NOW,
      )?.resetsAt,
    ).toBe(new Date(NOW.getTime() + 90_500).toISOString());
    for (const text of [
      '{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}',
      "You exceeded your current quota, please check your plan and billing details.",
      "429 Too Many Requests",
    ]) {
      expect(limitFailure(new Error(text), undefined, "codex", NOW, "UTC"), text).toBeDefined();
    }
  });
});

describe("parseReset", () => {
  it("lands on the next occurrence across a change of offset", () => {
    const before = new Date("2026-10-24T12:00:00Z");
    // Berlin leaves summer time that night: 3am on the 25th is CET, UTC+1.
    expect(parseReset("resets 3am (Europe/Berlin)", before, "UTC")?.toISOString()).toBe(
      iso("2026-10-25T02:00:00Z"),
    );
  });

  it("knows 12am and 12pm", () => {
    expect(parseReset("resets 12am (UTC)", NOW, "UTC")?.toISOString()).toBe(iso("2026-10-04T00:00:00Z"));
    expect(parseReset("resets 12pm (UTC)", NOW, "UTC")?.toISOString()).toBe(iso("2026-10-04T12:00:00Z"));
  });

  it("names no reset for a time that has passed or an unknown form", () => {
    expect(parseReset("Claude AI usage limit reached|1700000000", NOW, "UTC")).toBeUndefined();
    expect(parseReset("try again at Nov 17th, 2025 3:40 PM", NOW, "UTC")).toBeUndefined();
    expect(parseReset("You've hit your limit", NOW, "UTC")).toBeUndefined();
  });
});

describe("limitFailure: not limits", () => {
  it("leaves context-window errors alone", () => {
    for (const text of [
      "input length and max_tokens exceed context limit: 190000 + 32000 > 200000",
      "prompt is too long: 213000 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "context_length_exceeded: 429 tokens over",
    ]) {
      expect(limitFailure(new Error(text), text, "claude", NOW, "UTC"), text).toBeUndefined();
      expect(limitFailure(new Error(text), text, "codex", NOW, "UTC"), text).toBeUndefined();
    }
  });

  it("leaves overloads, auth errors and plain failures alone", () => {
    for (const text of [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "529 Overloaded",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Authentication required",
      "Internal error",
      "spawn ENOENT",
    ]) {
      expect(limitFailure(new Error(text), text, "claude", NOW, "UTC"), text).toBeUndefined();
      expect(limitFailure(new Error(text), text, "codex", NOW, "UTC"), text).toBeUndefined();
    }
  });

  it("does not read an agent's prose about limits", () => {
    const prose = [
      "I added a rate limit to the login route and a test that hits the limit reached case.",
      "The usage limit reached banner now shows the reset time.",
      "You've hit your limit of 3 retries, so the job gives up.",
    ];
    for (const text of prose) {
      expect(limitFailure(new Error("Internal error"), text, "claude", NOW, "UTC"), text).toBeUndefined();
    }
    expect(
      limitLine(`${prose[0]}\nMore text.\nYou've hit your limit · resets 3pm`, "claude", NOW, "UTC"),
    ).toBeUndefined();
    expect(limitLine("Done. All tests pass.", "claude", NOW, "UTC")).toBeUndefined();
    expect(limitLine("x".repeat(500), "claude", NOW, "UTC")).toBeUndefined();
  });

  it("reads only the first line of a failed turn's text", () => {
    const text = "Working on it.\nYou've hit your limit · resets 3pm";
    expect(limitFailure(new Error("Internal error"), text, "claude", NOW, "UTC")).toBeUndefined();
  });
});
