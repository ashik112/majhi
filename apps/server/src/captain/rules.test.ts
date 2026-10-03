import { AutonomySettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { effectiveLevel, levelOf, migratePickOrgs } from "./levels.ts";
import { branchAllowed, presenceWhy, providerAllowed, restWhy } from "./rules.ts";

const settings = (raw: unknown) => AutonomySettingsSchema.parse(raw);

describe("the choice per workspace", () => {
  it("defaults to Keeps things tidy for Private and Only when I ask for every other workspace", () => {
    const s = settings({ orgs: { globex: { level: "runs" } } });
    expect(levelOf(s, "private")).toBe("tidy");
    expect(levelOf(s, "acme")).toBe("ask");
    expect(levelOf(s, "globex")).toBe("runs");
  });

  it("lets Runs it act only while autonomous mode is on, and never wakes Only when I ask", () => {
    expect(effectiveLevel("runs", "on")).toBe("runs");
    for (const mode of ["off", "paused", "stopping"] as const)
      expect(effectiveLevel("runs", mode)).toBe("tidy");
    for (const mode of ["off", "on"] as const) expect(effectiveLevel("ask", mode)).toBe("ask");
  });

  it("moves the old list of workspaces autonomous mode may work in to Runs it, once, keeping each choice made", () => {
    const old = settings({
      orgs: { acme: { push: true }, globex: { level: "tidy" } },
      pick: { size: "medium", orgs: ["acme", "globex", "private"] },
    });
    expect(migratePickOrgs(old)).toEqual({
      orgs: {
        acme: { level: "runs", push: true, merge: false },
        // A workspace that already has a choice keeps it: the stricter rule wins.
        globex: { level: "tidy", push: false, merge: false },
        private: { level: "runs", push: false, merge: false },
      },
      pick: { size: "medium" },
    });
    // No list: nothing to move, and every other workspace keeps its default.
    expect(migratePickOrgs(settings({ pick: { size: "small" } }))).toBeUndefined();
  });
});

describe("the rules that always hold", () => {
  const at = (iso: string) => new Date(iso);

  it("rests outside working hours in the workspace's zone, also over midnight", () => {
    const night = { push: false, merge: false, hours: { from: "22:00", to: "06:00" } };
    // 23:30 in Berlin (UTC+2 in October) is inside 22:00 to 06:00.
    expect(restWhy(night, at("2026-10-03T21:30:00Z"), "Europe/Berlin")).toBeUndefined();
    expect(restWhy(night, at("2026-10-03T03:59:00Z"), "Europe/Berlin")).toBeUndefined();
    expect(restWhy(night, at("2026-10-03T04:00:00Z"), "Europe/Berlin")).toBe(
      "outside working hours (22:00 to 06:00)",
    );
    const day = { push: false, merge: false, hours: { from: "09:00", to: "17:00" } };
    expect(restWhy(day, at("2026-10-03T08:59:00Z"), "UTC")).toBe("outside working hours (09:00 to 17:00)");
    expect(restWhy(day, at("2026-10-03T09:00:00Z"), "UTC")).toBeUndefined();
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
    expect(restWhy(rules, at("2026-12-25T12:00:00Z"), "UTC")).toBe("2026-12-24 to 2026-12-26 is a freeze");
    // 23:30 UTC on the 3rd is already the 4th in Dhaka.
    expect(restWhy(rules, at("2026-10-03T23:30:00Z"), "Asia/Dhaka")).toBe("2026-10-04 is a freeze date");
    expect(restWhy(rules, at("2026-10-03T23:30:00Z"), "UTC")).toBeUndefined();
  });

  it("keeps out of a task the owner acted in during the last 10 minutes", () => {
    const now = at("2026-10-03T12:00:00Z");
    expect(presenceWhy("2026-10-03T11:51:00Z", now)).toBe("the owner acted in it 9 minutes ago");
    expect(presenceWhy("2026-10-03T11:59:40Z", now)).toBe("the owner acted in it 1 minute ago");
    expect(presenceWhy("2026-10-03T11:50:00Z", now)).toBeUndefined();
    expect(presenceWhy(undefined, now)).toBeUndefined();
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
