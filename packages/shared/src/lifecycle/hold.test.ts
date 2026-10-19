import { describe, expect, it } from "vitest";
import {
  autoClears,
  type ClearReading,
  conditionMet,
  type Hold,
  type HoldCause,
  type HoldOf,
  HoldSchema,
  type Lifter,
  liftersOf,
  mergeHold,
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
  preempted: { cause: "preempted", at: AT },
  "agents-down": {
    cause: "agents-down",
    at: AT,
    down: [{ account: "claude-acme", state: "signed-out" }],
  },
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
  preempted: ["majhi", "owner"],
  "agents-down": ["majhi", "owner"],
  "dependency-closed": ["owner", "majhi"],
  "dependency-removed": ["owner", "majhi"],
};

describe("auto-clear conditions", () => {
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
});
