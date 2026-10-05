import type { HomeCheck, MergeVerdict, OwnerDecision } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { backgroundLine, checkLine, checkState, duration, ordinal } from "./check-state.ts";
import { needsActions } from "./home-model.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const MIN = 60_000;

function fact(verdict: MergeVerdict, over: Partial<HomeCheck> = {}): HomeCheck {
  return { task: "ACM-1", checks: { verdict, head: "web@abc" }, ...over };
}

const shipDecision: OwnerDecision = {
  id: "room:ACM-1:ship",
  kind: "ship",
  task: "ACM-1",
  taskTitle: "Fix the invoice total",
  title: "@lead finished it",
  options: [{ id: "merge", label: "Merge", primary: true }],
  at: "2026-10-05T10:00:00Z",
  link: { kind: "task", id: "ACM-1", item: "ship" },
};

describe("what a review row says and offers for its checks", () => {
  it.each([
    ["green", fact({ kind: "ok" }), "Ready to merge", "merge", "Merge"],
    [
      "no checks set up",
      fact({ kind: "ok", noChecks: true }),
      "Ready to merge, no checks set up",
      "merge",
      "Merge",
    ],
    [
      "tests failed",
      fact({ kind: "failed", check: "test" }, { failedStep: { id: "tests", status: "fail", ms: 31_000 } }),
      "Tests failed after 31s",
      "see-failure",
      "See failure",
    ],
    [
      "build failed, no timing",
      fact({ kind: "failed", check: "build" }, { failedStep: { id: "build", status: "fail" } }),
      "Build failed",
      "see-failure",
      "See failure",
    ],
    [
      "tests timed out",
      fact(
        { kind: "failed", check: "test" },
        { failedStep: { id: "tests", status: "timeout", ms: 30 * MIN } },
      ),
      "Tests timed out at 30m",
      "check-again",
      "Check again",
    ],
    [
      "tests flaky",
      fact({ kind: "failed", check: "test" }, { failedStep: { id: "tests", status: "flaky" } }),
      "Tests flaky: failed, then passed on a retry",
      "see-failure",
      "See failure",
    ],
    [
      "secret in the diff",
      fact({ kind: "failed", check: "secret" }),
      "The diff holds what looks like a secret",
      "see-failure",
      "See failure",
    ],
    [
      "checks ran on an older commit",
      fact({ kind: "stale", ran: true }),
      "Checks not run on the latest commit",
      "check-again",
      "Check again",
    ],
    [
      "checks never ran",
      fact({ kind: "stale", ran: false }),
      "Checks not run on the latest commit",
      "check-again",
      "Check again",
    ],
    [
      "running tests for 4 minutes",
      fact(
        { kind: "running" },
        { activity: { phase: "running", step: "tests", since: new Date(NOW - 4 * MIN).toISOString() } },
      ),
      "Checking: tests 4m",
      "wait",
      "Checking",
    ],
    [
      "running beats an old failed verdict",
      fact(
        { kind: "failed", check: "test" },
        { activity: { phase: "running", step: "lint", since: new Date(NOW - 20_000).toISOString() } },
      ),
      "Checking: lint 20s",
      "wait",
      "Checking",
    ],
    [
      "queued second",
      fact(
        { kind: "running" },
        { activity: { phase: "queued", since: new Date(NOW).toISOString(), position: 2 } },
      ),
      "Queued for checks (2nd)",
      "wait",
      "Queued",
    ],
  ])("%s", (_name, f, line, button, label) => {
    const state = checkState(f);
    expect(checkLine(f, NOW)).toBe(line);
    expect(state.button).toBe(button);
    expect(state.label).toBe(label);
  });

  it("offers Merge anyway only for a failed check the owner may judge", () => {
    const failed = checkState(
      fact({ kind: "failed", check: "test" }, { failedStep: { id: "tests", status: "fail" } }),
    );
    const timedOut = checkState(
      fact({ kind: "failed", check: "build" }, { failedStep: { id: "build", status: "timeout" } }),
    );
    expect(failed.mergeAnyway).toBe(true);
    expect(timedOut.mergeAnyway).toBe(true);
    expect(checkState(fact({ kind: "failed", check: "secret" })).mergeAnyway).toBe(false);
    expect(checkState(fact({ kind: "stale", ran: true })).mergeAnyway).toBe(false);
    expect(checkState(fact({ kind: "ok" })).mergeAnyway).toBe(false);
  });

  it("counts the minutes and the place in the queue in words", () => {
    expect([0, 45_000, 4 * MIN, 65 * MIN, 120 * MIN].map(duration)).toEqual([
      "0s",
      "45s",
      "4m",
      "1h 5m",
      "2h",
    ]);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
    ]);
  });
});

describe("the buttons of a ship decision follow its checks", () => {
  const labels = (f: HomeCheck | undefined) => needsActions(shipDecision, undefined, f).map((a) => a.label);

  it("keeps the decision's own Merge when the checks are green or unknown", () => {
    expect(labels(fact({ kind: "ok" }))[0]).toBe("Merge");
    expect(labels(undefined)[0]).toBe("Merge");
  });

  it("leads with See failure, and Merge anyway second", () => {
    const f = fact({ kind: "failed", check: "test" }, { failedStep: { id: "tests", status: "fail" } });
    expect(labels(f)).toEqual(["See failure", "Merge anyway"]);
    expect(labels(fact({ kind: "failed", check: "secret" }))).toEqual(["See failure"]);
  });

  it("leads with Check again for a timeout or a stale check", () => {
    const timeout = fact(
      { kind: "failed", check: "test" },
      { failedStep: { id: "tests", status: "timeout" } },
    );
    expect(labels(timeout)[0]).toBe("Check again");
    expect(needsActions(shipDecision, undefined, timeout)[0]).toEqual({
      kind: "recheck",
      task: "ACM-1",
      label: "Check again",
    });
    expect(labels(fact({ kind: "stale", ran: false }))).toEqual(["Check again", "Review"]);
  });

  it("has nothing to press while a check runs", () => {
    const running = fact(
      { kind: "running" },
      { activity: { phase: "running", step: "tests", since: new Date(NOW).toISOString() } },
    );
    expect(needsActions(shipDecision, undefined, running)[0]?.kind).toBe("wait");
  });
});

describe("a background row says what runs", () => {
  it("names a check step, a process and a preview", () => {
    const base = { task: "ACM-1", since: "2026-10-05T11:00:00Z" } as const;
    expect(backgroundLine({ ...base, kind: "check", label: "tests" })).toBe("Checking: tests");
    expect(backgroundLine({ ...base, kind: "check", label: "ready" })).toBe("Checking: starting");
    expect(backgroundLine({ ...base, kind: "queued-check", label: "checks", position: 1 })).toBe(
      "Queued for checks (1st)",
    );
    expect(backgroundLine({ ...base, kind: "process", label: "pnpm dev" })).toBe("Process: pnpm dev");
    expect(backgroundLine({ ...base, kind: "preview", label: "web" })).toBe("Preview: web");
  });
});
