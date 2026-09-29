import type { OrgView } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  failingStep,
  formatIn,
  isUsableStatus,
  orgIdFromName,
  orgLabel,
  statusInfo,
  suggestOrgColor,
  usageLines,
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
  const orgs: OrgView[] = [{ id: "acme", name: "Acme", color: "#8ab8f5", accountCount: 1, agentCount: 0 }];
  it("resolves personal, known and unknown orgs", () => {
    expect(orgLabel("personal", orgs)).toEqual({ name: "Personal" });
    expect(orgLabel("acme", orgs)).toEqual({ name: "Acme", color: "#8ab8f5" });
    expect(orgLabel("gone", orgs)).toEqual({ name: "gone" });
  });
});

describe("usageLines", () => {
  const now = Date.parse("2026-09-29T10:00:00Z");
  it("is empty without usage", () => {
    expect(usageLines(undefined, now)).toEqual([]);
  });
  it("shows window and week, and marks estimates", () => {
    const lines = usageLines(
      {
        window: { usedPct: 41.6, resetsAt: "2026-09-29T12:00:00Z" },
        weekly: { usedPct: 12 },
        estimated: true,
        updatedAt: "2026-09-29T10:00:00Z",
      },
      now,
    );
    expect(lines).toEqual(["42% of current window, resets in 2 h (estimated)", "12% this week (estimated)"]);
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
