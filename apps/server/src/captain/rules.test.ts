import { ALL_ASK, type Authority, AutonomySettingsSchema, restOf } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { choresNow, choresOf, migratePickOrgs } from "./levels.ts";
import { branchAllowed, providerAllowed } from "./rules.ts";

const settings = (raw: unknown) => AutonomySettingsSchema.parse(raw);

describe("the authority table per workspace", () => {
  it("runs reacting chores whatever Auto-pilot says, the scheduled upkeep only while it is on, and nothing under Stop everything", () => {
    const all: Authority = {
      ...ALL_ASK,
      start: "decide",
      questions: "decide",
      approvals: "decide",
      upkeep: "decide",
      merge: "decide",
      push: "decide",
      own: "decide",
    };
    expect(choresNow(all, { mode: "on" })).toEqual(choresOf(all));
    for (const mode of ["off", "paused", "stopping"] as const) {
      expect(choresNow(all, { mode })).toEqual(["ship", "cards", "questions", "memory", "cleanup"]);
    }
    expect(choresNow(all, { mode: "on", stopped: true })).toEqual([]);
  });

  it("moves the old list of workspaces autonomous mode may work in to Runs it, once, keeping each choice made", () => {
    const old = settings({
      orgs: { acme: { push: true }, globex: { level: "tidy" } },
      pick: { size: "medium", orgs: ["acme", "globex", "private"] },
    });
    expect(migratePickOrgs(old)).toEqual({
      orgs: {
        acme: { level: "runs", push: true },
        // A workspace that already has a choice keeps it: the stricter rule wins.
        globex: { level: "tidy" },
        private: { level: "runs" },
      },
      pick: { size: "medium" },
    });
    // No list: nothing to move, and every other workspace keeps its default.
    expect(migratePickOrgs(settings({ pick: { size: "small" } }))).toBeUndefined();
  });
});

describe("the rules that always hold", () => {
  const at = (iso: string) => new Date(iso);
  const rest = (rules: Omit<Parameters<typeof restOf>[0], "tz">, now: Date, tz: string) =>
    restOf({ ...rules, tz }, now);

  it("rests outside working hours in the workspace's zone, also over midnight", () => {
    const night = { push: false, merge: false, hours: { from: "22:00", to: "06:00" } };
    // 23:30 in Berlin (UTC+2 in October) is inside 22:00 to 06:00.
    expect(rest(night, at("2026-10-03T21:30:00Z"), "Europe/Berlin")).toBeUndefined();
    expect(rest(night, at("2026-10-03T03:59:00Z"), "Europe/Berlin")).toBeUndefined();
    expect(rest(night, at("2026-10-03T04:00:00Z"), "Europe/Berlin")).toBeDefined();
    const day = { push: false, merge: false, hours: { from: "09:00", to: "17:00" } };
    expect(rest(day, at("2026-10-03T08:59:00Z"), "UTC")).toBeDefined();
    expect(rest(day, at("2026-10-03T09:00:00Z"), "UTC")).toBeUndefined();
  });

  it("rests on freeze dates, judged by the day in the workspace's zone", () => {
    const rules = {
      push: false,
      merge: false,
      freeze: [
        { from: "2026-12-24", to: "2026-12-26" },
        { from: "2026-10-04", to: "2026-10-04" },
      ],
    };
    expect(rest(rules, at("2026-12-25T12:00:00Z"), "UTC")).toBeDefined();
    // 23:30 UTC on the 3rd is already the 4th in Dhaka.
    expect(rest(rules, at("2026-10-03T23:30:00Z"), "Asia/Dhaka")).toBeDefined();
    expect(rest(rules, at("2026-10-03T23:30:00Z"), "UTC")).toBeUndefined();
  });

  it("ships only to the workspace's branches, or each project's base without a list, and only with allowed providers", () => {
    const none = { push: false, merge: true };
    expect(branchAllowed(none, "develop", "develop")).toBe(true);
    expect(branchAllowed(none, "main", "develop")).toBe(false);
    const listed = { ...none, branches: ["main"] };
    expect(branchAllowed(listed, "main", "develop")).toBe(true);
    expect(branchAllowed(listed, "develop", "develop")).toBe(false);
    expect(providerAllowed(none, "codex")).toBe(true);
    expect(providerAllowed({ ...none, providers: ["claude"] }, "codex")).toBe(false);
  });
});
