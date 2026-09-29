import type { OrgView } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  authInfo,
  barTone,
  defaultOrgId,
  failingStep,
  formatIn,
  formatPct,
  isUsableStatus,
  orgIdFromName,
  orgLabel,
  resetFull,
  resetLabel,
  statusInfo,
  statusText,
  suggestOrgColor,
  usageRows,
  usageRowText,
  usageTone,
} from "./model";

describe("orgIdFromName", () => {
  it("makes a lowercase dashed id", () => {
    expect(orgIdFromName("Acme Corp.")).toBe("acme-corp");
    expect(orgIdFromName("  Globex  ")).toBe("globex");
    expect(orgIdFromName("Café & Co")).toBe("cafe-co");
  });
  it("returns empty when nothing usable is left", () => {
    expect(orgIdFromName("!!!")).toBe("");
  });
  it("avoids reserved ids", () => {
    expect(orgIdFromName("Personal")).toBe("personal-org");
    expect(orgIdFromName("Private")).toBe("private-org");
    expect(orgIdFromName("Root")).toBe("root-org");
  });
  it("caps the length at 63 without a trailing dash", () => {
    const id = orgIdFromName(`${"a".repeat(62)} b`);
    expect(id).toBe("a".repeat(62));
  });
});

describe("suggestOrgColor", () => {
  it("cycles the palette", () => {
    expect(suggestOrgColor(0)).not.toBe(suggestOrgColor(1));
    expect(suggestOrgColor(0)).toBe(suggestOrgColor(5));
  });
});

describe("statusInfo", () => {
  it("labels statuses in plain words", () => {
    expect(statusInfo("needs-login")).toEqual({ label: "Needs login", tone: "red" });
    expect(statusInfo("healthy").tone).toBe("green");
  });
  it("counts only signed-in states as usable", () => {
    expect(isUsableStatus("healthy")).toBe(true);
    expect(isUsableStatus("relogin-soon")).toBe(true);
    expect(isUsableStatus("unknown")).toBe(false);
    expect(isUsableStatus("needs-login")).toBe(false);
  });
});

describe("orgLabel", () => {
  const orgs: OrgView[] = [
    { id: "acme", name: "Acme", key: "ACM", color: "#8ab8f5", accountCount: 1, agentCount: 0 },
  ];
  it("resolves private, known and unknown orgs", () => {
    expect(orgLabel("private", orgs)).toEqual({ name: "Private" });
    expect(orgLabel("personal", orgs)).toEqual({ name: "Private" });
    expect(orgLabel("acme", orgs)).toEqual({ name: "Acme", color: "#8ab8f5" });
    expect(orgLabel("gone", orgs)).toEqual({ name: "gone" });
  });
});

describe("usage formatting", () => {
  // Local time, so the tests do not depend on the machine's zone.
  const now = new Date(2026, 8, 29, 10, 0).getTime();
  const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();

  it("rounds percentages", () => {
    expect(formatPct(41.6)).toBe("42%");
    expect(formatPct(0)).toBe("0%");
  });

  it("turns amber at 80 and red at 100", () => {
    expect(usageTone(79.9)).toBe("neutral");
    expect(usageTone(80)).toBe("amber");
    expect(usageTone(99)).toBe("amber");
    expect(usageTone(100)).toBe("red");
  });

  it("shows only the time for a reset today", () => {
    expect(resetLabel(at(29, 21, 30), now, "en-US")).toBe("9:30 PM");
  });

  it("shows the weekday for another day and the date after a week", () => {
    // 2026-10-01 is a Thursday.
    expect(resetLabel(new Date(2026, 9, 1, 12).toISOString(), now, "en-US")).toBe("Thu");
    expect(resetLabel(new Date(2026, 9, 8, 12).toISOString(), now, "en-US")).toBe("Oct 8");
  });

  it("formats the full reset", () => {
    expect(resetFull(new Date(2026, 9, 3, 0, 0).toISOString(), "en-US")).toBe("Sat, Oct 3, 12:00 AM");
    expect(resetFull("nope")).toBe("unknown time");
  });

  it("builds the 5h and Week rows", () => {
    const rows = usageRows(
      {
        window: { usedPct: 42, resetsAt: at(29, 21, 30) },
        weekly: { usedPct: 85 },
        models: [],
        estimated: false,
        updatedAt: at(29, 10),
      },
      now,
      "en-US",
    );
    expect(rows.map(usageRowText)).toEqual(["5h 42% · 9:30 PM", "Week 85%"]);
    expect(rows.map((r) => r.tone)).toEqual(["neutral", "amber"]);
  });

  it("has no rows without usage or windows", () => {
    expect(usageRows(undefined, now)).toEqual([]);
    expect(usageRows({ models: [], estimated: false, updatedAt: "x", error: "boom" }, now)).toEqual([]);
  });
});

describe("formatIn", () => {
  it("rounds to a friendly unit", () => {
    const now = Date.parse("2026-09-29T10:00:00Z");
    expect(formatIn("2026-09-29T09:00:00Z", now)).toBe("now");
    expect(formatIn("2026-09-29T10:35:00Z", now)).toBe("in 35 min");
    expect(formatIn("2026-10-02T10:00:00Z", now)).toBe("in 3 days");
  });
});

describe("failingStep", () => {
  it("finds the first failing step", () => {
    const health = {
      ok: false,
      checkedAt: "x",
      durationMs: 1,
      steps: [
        { name: "cli" as const, ok: true, detail: "1.0" },
        { name: "auth" as const, ok: false, detail: "not signed in" },
      ],
    };
    expect(failingStep(health)?.name).toBe("auth");
    expect(failingStep({ ...health, steps: [] })).toBeUndefined();
  });
});

describe("health table text", () => {
  const at = Date.parse("2026-10-01T10:00:00Z");
  it("turns bars green, amber and red", () => {
    expect([10, 79, 80, 99, 100].map(barTone)).toEqual(["green", "green", "amber", "amber", "red"]);
  });

  it("puts the reset time on an account at its limit", () => {
    const usage = {
      window: { usedPct: 100, resetsAt: "2026-10-01T15:40:00Z" },
      models: [],
      estimated: false,
      updatedAt: "",
    };
    const text = statusText({ status: "at-limit", usage }, at, "en-US");
    expect(text.tone).toBe("red");
    expect(text.label).toMatch(/^Limit reached · \d{1,2}:40/);
    expect(statusText({ status: "at-limit" }, at)).toEqual({ label: "Limit reached", tone: "red" });
    expect(statusText({ status: "healthy" }, at)).toEqual({ label: "Healthy", tone: "green" });
  });

  it("says what is wrong with the login", () => {
    expect(authInfo({ auth: "login", status: "healthy" })).toEqual({ label: "Signed in", tone: "green" });
    expect(authInfo({ auth: "login", status: "needs-login" })).toEqual({ label: "Needs login", tone: "red" });
    expect(authInfo({ auth: "login", status: "relogin-soon" }).tone).toBe("amber");
    expect(authInfo({ auth: "api-key", status: "needs-login" })).toEqual({ label: "API key", tone: "green" });
  });
});

describe("defaultOrgId", () => {
  const ids = (...list: string[]) => list.map((id) => ({ id }));
  it("prefers the org filter", () => {
    expect(defaultOrgId(ids("private", "acme", "zed"), "zed")).toBe("zed");
  });
  it("takes the only other org", () => {
    expect(defaultOrgId(ids("private", "acme"))).toBe("acme");
  });
  it("falls back to private", () => {
    expect(defaultOrgId(ids("private"))).toBe("private");
    expect(defaultOrgId(ids("private", "acme", "zed"))).toBe("private");
    expect(defaultOrgId(ids("private", "acme"), "gone")).toBe("acme");
  });
});
