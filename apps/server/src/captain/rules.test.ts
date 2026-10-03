import { ALL_ASK, type Authority, AutonomySettingsSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { authorityOf, choresNow, choresOf, effectiveAuthority, migratePickOrgs } from "./levels.ts";
import { branchAllowed, presenceWhy, providerAllowed, restWhy } from "./rules.ts";

const settings = (raw: unknown) => AutonomySettingsSchema.parse(raw);

describe("the authority table per workspace", () => {
  const rows = (
    start: string,
    questions: string,
    approvals: string,
    upkeep: string,
    merge: string,
    push: string,
  ) => ({
    start,
    questions,
    approvals,
    upkeep,
    merge,
    push,
  });

  it("defaults to Keeps things tidy for Private and Ask me with upkeep for every other workspace", () => {
    const s = settings({});
    expect(authorityOf(s, "private")).toEqual(rows("ask", "decide", "decide", "decide", "ask", "ask"));
    expect(authorityOf(s, "acme")).toEqual(rows("ask", "ask", "ask", "decide", "ask", "ask"));
  });

  it("reads the three old levels into rows", () => {
    const s = settings({
      orgs: {
        acme: { level: "ask" },
        globex: { level: "tidy", push: true, merge: true },
        northwind: { level: "runs" },
        initech: { level: "runs", merge: true },
        umbrella: { level: "runs", push: true, merge: true },
      },
    });
    expect(authorityOf(s, "acme")).toEqual(rows("ask", "ask", "ask", "ask", "ask", "ask"));
    // Tidy never merged or pushed, whatever the old switches said.
    expect(authorityOf(s, "globex")).toEqual(rows("ask", "decide", "decide", "decide", "ask", "ask"));
    expect(authorityOf(s, "northwind")).toEqual(rows("decide", "decide", "decide", "decide", "ask", "ask"));
    expect(authorityOf(s, "initech")).toEqual(rows("decide", "decide", "decide", "decide", "decide", "ask"));
    expect(authorityOf(s, "umbrella")).toEqual(
      rows("decide", "decide", "decide", "decide", "decide", "decide"),
    );
  });

  it("lets an explicit authority win over the old fields", () => {
    const s = settings({
      orgs: {
        acme: {
          level: "runs",
          merge: true,
          authority: rows("ask", "ask", "ask", "ask", "ask", "decide"),
        },
      },
    });
    expect(authorityOf(s, "acme")).toEqual(rows("ask", "ask", "ask", "ask", "ask", "decide"));
  });

  it("acts only while Autonomous is on", () => {
    const all = rows("decide", "decide", "decide", "decide", "decide", "decide") as Authority;
    expect(effectiveAuthority(all, "on")).toEqual(all);
    // Not On: everything is "You decide" except upkeep, which keeps its choice (memory and cleanup only).
    for (const mode of ["off", "paused", "stopping"] as const) {
      expect(effectiveAuthority(all, mode)).toEqual({ ...ALL_ASK, upkeep: "decide" });
      expect(effectiveAuthority({ ...all, upkeep: "ask" }, mode)).toEqual(ALL_ASK);
      expect(choresNow(all, mode)).toEqual(["memory", "cleanup"]);
    }
    expect(choresNow(all, "on")).toEqual(choresOf(all));
  });

  it("runs each chore on its own row", () => {
    const only = (row: keyof Authority): Authority => ({ ...ALL_ASK, [row]: "decide" });
    expect(choresOf(ALL_ASK)).toEqual([]);
    expect(choresOf(only("approvals"))).toEqual(["cards"]);
    expect(choresOf(only("questions"))).toEqual(["questions"]);
    expect(choresOf(only("merge"))).toEqual(["ship"]);
    expect(choresOf(only("upkeep"))).toEqual(["ship", "memory", "projects", "triage", "cleanup", "stuck"]);
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
