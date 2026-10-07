import type { HomeCheck, MergeVerdict, OwnerDecision } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { checkState } from "./check-state.ts";
import { needsActions } from "./home-model.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");

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
});

describe("the buttons of a ship decision follow its checks", () => {
  const labels = (f: HomeCheck | undefined) => needsActions(shipDecision, undefined, f).map((a) => a.label);

  it("leads with See failure, and Merge anyway second", () => {
    const f = fact({ kind: "failed", check: "test" }, { failedStep: { id: "tests", status: "fail" } });
    expect(labels(f)).toEqual(["See failure", "Merge anyway"]);
    expect(labels(fact({ kind: "failed", check: "secret" }))).toEqual(["See failure"]);
  });

  it("has nothing to press while a check runs", () => {
    const running = fact(
      { kind: "running" },
      { activity: { phase: "running", step: "tests", since: new Date(NOW).toISOString() } },
    );
    expect(needsActions(shipDecision, undefined, running)[0]?.kind).toBe("wait");
  });
});
