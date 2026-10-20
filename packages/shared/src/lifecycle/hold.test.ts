import { describe, expect, it } from "vitest";
import {
  autoClears,
  type ClearReading,
  conditionMet,
  type Hold,
  type HoldCause,
  type HoldOf,
} from "./hold.ts";

const AT = "2026-10-05T10:00:00.000Z";

/** One sample per cause. Typed over every cause, so a new kind without a sample fails typecheck. */
const SAMPLES: { [C in HoldCause]: HoldOf<C> } = {
  "owner-stop": { cause: "owner-stop", at: AT },
  "captain-stop": { cause: "captain-stop", at: AT, why: "it was off track" },
  "autonomous-off": { cause: "autonomous-off", at: AT, mode: "now" },
  "autonomous-stop": { cause: "autonomous-stop", at: AT, why: "it failed twice" },
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
const hold = (cause: HoldCause): Hold => SAMPLES[cause];

const READING: ClearReading = {
  now: "2026-10-05T12:00:00.000Z",
  online: false,
  accounts: {},
  budgetHasRoom: false,
  autonomous: "off",
  runAtStep: false,
};

describe("auto-clear conditions", () => {
  const signedIn = (account: string, limitedUntil?: string, isIn = true): ClearReading => ({
    ...READING,
    accounts: { [account]: { signedIn: isIn, ...(limitedUntil === undefined ? {} : { limitedUntil }) } },
  });
  const openBudget: Hold = { ...SAMPLES["budget-limit"], until: "2026-10-06T00:00:00.000Z" };

  it.each<[string, Hold, ClearReading, boolean]>([
    ["offline, still offline", hold("offline"), READING, false],
    ["offline, back online", hold("offline"), { ...READING, online: true }, true],
    ["signed out, no reading", hold("signed-out"), READING, false],
    ["signed out, another account signed in", hold("signed-out"), signedIn("other"), false],
    [
      "signed out, that account still signed out",
      hold("signed-out"),
      signedIn("claude-acme", undefined, false),
      false,
    ],
    ["signed out, that account signed in again", hold("signed-out"), signedIn("claude-acme"), true],
    [
      "account limit, window not over",
      hold("account-limit"),
      signedIn("claude-acme", "2026-10-05T13:00:00.000Z"),
      false,
    ],
    [
      "account limit, window reset",
      hold("account-limit"),
      signedIn("claude-acme", "2026-10-05T12:00:00.000Z"),
      true,
    ],
    ["account limit, no limit any more", hold("account-limit"), signedIn("claude-acme"), true],
    [
      "account limit, but signed out",
      hold("account-limit"),
      signedIn("claude-acme", undefined, false),
      false,
    ],
    ["account limit, no reading", hold("account-limit"), READING, false],
    ["budget limit, no room", openBudget, READING, false],
    ["budget limit, room again", openBudget, { ...READING, budgetHasRoom: true }, true],
    ["budget limit, period over", openBudget, { ...READING, now: "2026-10-06T00:00:00.000Z" }, true],
    ["budget limit with no end, no room", hold("budget-limit"), READING, false],
    ["idle, no activity", hold("idle"), READING, false],
    [
      "idle, activity before the hold",
      hold("idle"),
      { ...READING, lastActivityAt: "2026-10-05T09:00:00.000Z" },
      false,
    ],
    [
      "idle, activity after the hold",
      hold("idle"),
      { ...READING, lastActivityAt: "2026-10-05T10:00:01.000Z" },
      true,
    ],
  ])("clears a hold only when its cause is gone: %s", (_name, held, reading, clears) => {
    expect(conditionMet(autoClears(held), reading)).toBe(clears);
  });
});
