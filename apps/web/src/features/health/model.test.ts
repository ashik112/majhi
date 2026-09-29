import { describe, expect, it } from "vitest";
import { type CheckRow, checksNeedingYou, checksSummary, checkTone, groupChecks } from "./model";

const row = (id: string, group: CheckRow["group"], level: "pass" | "warn" | "fail"): CheckRow => ({
  id,
  group,
  label: id,
  ok: level !== "fail",
  level,
  detail: "",
});

const checks = [
  row("git", "majhi", "pass"),
  row("config", "majhi", "fail"),
  row("root:/a", "host", "fail"),
  row("account:a", "accounts", "fail"),
  row("ssh-agent", "ssh", "warn"),
  row("tool:claude", "majhi", "warn"),
];

describe("groupChecks", () => {
  it("groups in a fixed order with failures first and drops empty groups", () => {
    const groups = groupChecks(checks);
    expect(groups.map((g) => g.id)).toEqual(["majhi", "host", "ssh", "accounts"]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["config", "tool:claude", "git"]);
  });
});

describe("checksNeedingYou", () => {
  it("counts failures outside accounts, because accounts count themselves", () => {
    expect(checksNeedingYou(checks)).toBe(2);
    expect(checksNeedingYou(undefined)).toBe(0);
  });
});

describe("checkTone and summary", () => {
  it("maps levels to dots and reads a plain summary", () => {
    expect(checkTone(row("a", "majhi", "pass"))).toBe("green");
    expect(checkTone(row("a", "majhi", "warn"))).toBe("amber");
    expect(checkTone(row("a", "majhi", "fail"))).toBe("red");
    expect(checksSummary(checks)).toBe("3 failed, 2 warnings");
    expect(checksSummary([row("a", "majhi", "pass")])).toBe("All checks passed");
  });

  it("treats a row without a level by its ok flag", () => {
    expect(checkTone({ ok: false })).toBe("red");
    expect(checkTone({ ok: true })).toBe("green");
  });
});
