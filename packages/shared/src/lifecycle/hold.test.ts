import { describe, expect, it } from "vitest";
import {
  autoClears,
  type ClearReading,
  conditionMet,
  HOLD_TABLE,
  type Hold,
  type HoldCause,
  type HoldOf,
  HoldSchema,
  type Lifter,
  liftersOf,
  majhiMayLift,
  mergeHold,
  sentenceOf,
} from "./hold.ts";

const AT = "2026-10-05T10:00:00.000Z";

/** One sample per cause. Typed over every cause, so a new kind without a sample fails typecheck. */
const SAMPLES: { [C in HoldCause]: HoldOf<C> } = {
  "owner-stop": { cause: "owner-stop", at: AT },
  "captain-stop": { cause: "captain-stop", at: AT, why: "it was off track" },
  "autopilot-off": { cause: "autopilot-off", at: AT, mode: "now" },
  "budget-limit": { cause: "budget-limit", at: AT, scope: "org", scopeId: "acme", period: "day" },
  "account-limit": { cause: "account-limit", at: AT, account: "claude-acme" },
  offline: { cause: "offline", at: AT },
  "signed-out": { cause: "signed-out", at: AT, account: "claude-acme" },
  error: { cause: "error", at: AT, phase: "turn", error: "boom" },
  "loop-guard": { cause: "loop-guard", at: AT, why: "three answers, no progress" },
  idle: { cause: "idle", at: AT, why: "The lead finished." },
  "dependency-closed": { cause: "dependency-closed", at: AT, on: ["ACME-1"] },
  "dependency-removed": { cause: "dependency-removed", at: AT, on: ["ACME-1"] },
};
const CAUSES = Object.keys(SAMPLES) as HoldCause[];
const hold = (cause: HoldCause): Hold => SAMPLES[cause];

const READING: ClearReading = {
  now: "2026-10-05T12:00:00.000Z",
  online: false,
  accounts: {},
  budgetHasRoom: false,
  autopilot: "off",
  runAtStep: false,
};

/** Who may lift each cause, from the design table (4.3). */
const LIFTERS: Record<HoldCause, Lifter[]> = {
  "owner-stop": ["owner"],
  "captain-stop": ["owner", "captain"],
  "autopilot-off": ["owner", "captain"],
  "budget-limit": ["owner", "majhi"],
  "account-limit": ["majhi", "owner"],
  offline: ["majhi", "owner"],
  "signed-out": ["majhi", "owner"],
  error: ["owner", "captain"],
  "loop-guard": ["owner"],
  idle: ["owner", "captain", "majhi"],
  "dependency-closed": ["owner"],
  "dependency-removed": ["owner"],
};

describe("hold table", () => {
  it("has a row for every cause", () => {
    expect(Object.keys(HOLD_TABLE).sort()).toEqual([...CAUSES].sort());
  });

  it.each(CAUSES)("%s: a sample parses, has lifters and a plain sentence", (cause) => {
    expect(HoldSchema.safeParse(hold(cause)).success).toBe(true);
    expect([...liftersOf(hold(cause))].sort()).toEqual([...LIFTERS[cause]].sort());
    const s = sentenceOf(hold(cause));
    expect(s.length).toBeGreaterThan(10);
    expect(s).not.toMatch(/—|undefined|\{/);
    expect(s).toMatch(/[.!?]$/);
  });

  it("the Auto-pilot step hold is lifted by the owner or majhi, not the captain", () => {
    const step: Hold = { cause: "autopilot-off", at: AT, mode: "step" };
    expect(liftersOf(step)).toEqual(["owner", "majhi"]);
    expect(autoClears(step)).toEqual({ kind: "step-or-autopilot-on" });
  });

  it("owner-only holds never list the captain or majhi", () => {
    for (const cause of ["owner-stop", "loop-guard", "dependency-closed", "dependency-removed"] as const)
      expect(liftersOf(hold(cause))).toEqual(["owner"]);
  });

  it("a hold majhi can lift has a condition, and one it cannot lift never auto-clears", () => {
    for (const c of CAUSES) {
      const majhi = liftersOf(hold(c)).includes("majhi");
      expect(majhi).toBe(autoClears(hold(c)).kind !== "never");
    }
  });

  it("the sentences carry the data of the hold", () => {
    expect(sentenceOf(hold("signed-out"))).toContain("claude-acme");
    expect(sentenceOf(hold("account-limit"))).toContain("claude-acme");
    expect(sentenceOf(hold("dependency-closed"))).toContain("ACME-1");
    expect(sentenceOf(hold("captain-stop"))).toContain("off track");
    expect(sentenceOf({ cause: "captain-stop", at: AT })).toBe("The captain paused it.");
    expect(sentenceOf(hold("budget-limit"))).toContain("acme");
  });
});

describe("auto-clear conditions", () => {
  it("offline clears only when online", () => {
    expect(conditionMet(autoClears(hold("offline")), READING)).toBe(false);
    expect(conditionMet(autoClears(hold("offline")), { ...READING, online: true })).toBe(true);
  });

  it("signed-out clears when that account reads signed in, not another", () => {
    const c = autoClears(hold("signed-out"));
    expect(conditionMet(c, READING)).toBe(false);
    expect(conditionMet(c, { ...READING, accounts: { other: { signedIn: true } } })).toBe(false);
    expect(conditionMet(c, { ...READING, accounts: { "claude-acme": { signedIn: false } } })).toBe(false);
    expect(conditionMet(c, { ...READING, accounts: { "claude-acme": { signedIn: true } } })).toBe(true);
  });

  it("account-limit clears when the window reset, and never for a signed-out account", () => {
    const c = autoClears(hold("account-limit"));
    const at = (limitedUntil: string | undefined, signedIn = true): ClearReading => ({
      ...READING,
      accounts: { "claude-acme": { signedIn, limitedUntil } },
    });
    expect(conditionMet(c, at("2026-10-05T13:00:00.000Z"))).toBe(false);
    expect(conditionMet(c, at("2026-10-05T12:00:00.000Z"))).toBe(true);
    expect(conditionMet(c, at(undefined))).toBe(true);
    expect(conditionMet(c, at(undefined, false))).toBe(false);
    expect(conditionMet(c, READING)).toBe(false);
  });

  it("budget-limit clears on room or when its period end passes", () => {
    const open = { ...SAMPLES["budget-limit"], until: "2026-10-06T00:00:00.000Z" };
    expect(conditionMet(autoClears(open), READING)).toBe(false);
    expect(conditionMet(autoClears(open), { ...READING, budgetHasRoom: true })).toBe(true);
    expect(conditionMet(autoClears(open), { ...READING, now: "2026-10-06T00:00:00.000Z" })).toBe(true);
    expect(conditionMet(autoClears(hold("budget-limit")), READING)).toBe(false);
  });

  it("Auto-pilot step clears at the step or when Auto-pilot is on", () => {
    const c = autoClears({ cause: "autopilot-off", at: AT, mode: "step" });
    expect(conditionMet(c, READING)).toBe(false);
    expect(conditionMet(c, { ...READING, runAtStep: true })).toBe(true);
    expect(conditionMet(c, { ...READING, autopilot: "on" })).toBe(true);
    expect(conditionMet(c, { ...READING, autopilot: "stopping" })).toBe(false);
  });

  it("idle clears on activity after the hold, not before", () => {
    const c = autoClears(hold("idle"));
    expect(conditionMet(c, READING)).toBe(false);
    expect(conditionMet(c, { ...READING, lastActivityAt: "2026-10-05T09:00:00.000Z" })).toBe(false);
    expect(conditionMet(c, { ...READING, lastActivityAt: "2026-10-05T10:00:01.000Z" })).toBe(true);
  });

  it("never means never", () => {
    expect(conditionMet({ kind: "never" }, { ...READING, online: true, budgetHasRoom: true })).toBe(false);
  });

  it("majhiMayLift needs both: being a lifter and the condition", () => {
    const online = { ...READING, online: true };
    expect(majhiMayLift(hold("offline"), online)).toBe(true);
    expect(majhiMayLift(hold("offline"), READING)).toBe(false);
    const everythingOk = { ...online, budgetHasRoom: true, lastActivityAt: "2027-01-01T00:00:00Z" };
    for (const c of ["owner-stop", "loop-guard", "error", "captain-stop"] as const)
      expect(majhiMayLift(hold(c), everythingOk)).toBe(false);
  });
});

describe("mergeHold", () => {
  it("an owner-only hold is not replaced by one majhi can clear", () => {
    expect(mergeHold(hold("owner-stop"), hold("offline")).cause).toBe("owner-stop");
    expect(mergeHold(hold("loop-guard"), hold("account-limit")).cause).toBe("loop-guard");
  });

  it("an owner-only hold replaces one more parties can lift", () => {
    expect(mergeHold(hold("offline"), hold("owner-stop")).cause).toBe("owner-stop");
    expect(mergeHold(hold("captain-stop"), hold("loop-guard")).cause).toBe("loop-guard");
  });

  it("a tie keeps the existing hold", () => {
    expect(mergeHold(hold("owner-stop"), hold("loop-guard")).cause).toBe("owner-stop");
  });

  it("the same cause takes the newer data", () => {
    const newer: Hold = { cause: "signed-out", at: "2026-10-05T11:00:00.000Z", account: "claude-globex" };
    expect(mergeHold(hold("signed-out"), newer)).toEqual(newer);
  });

  it("Auto-pilot now is never downgraded to step, step upgrades to now", () => {
    const now: Hold = { cause: "autopilot-off", at: AT, mode: "now" };
    const step: Hold = { cause: "autopilot-off", at: AT, mode: "step" };
    expect(mergeHold(now, step)).toEqual(now);
    expect(mergeHold(step, now)).toEqual(now);
  });

  it("a removed dependency replaces a closed one", () => {
    expect(mergeHold(hold("dependency-closed"), hold("dependency-removed")).cause).toBe("dependency-removed");
  });

  it("nothing existing takes the incoming hold", () => {
    expect(mergeHold(undefined, hold("offline"))).toEqual(hold("offline"));
  });
});
