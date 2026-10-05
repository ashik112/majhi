import type { ServerEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { feedStep, planEvent } from "./events-model";
import { queryKeys } from "./queries";

const changed = (extra: { seq?: number; tasks?: string[]; rows?: true }): ServerEvent => ({
  type: "changed",
  topics: ["tasks"],
  ...extra,
});

describe("what a feed event asks the board to read", () => {
  it("reads only the named tasks when only their rows changed", () => {
    expect(planEvent(changed({ tasks: ["ACM-1"], rows: true }))).toEqual({
      keys: [],
      tasks: ["ACM-1"],
      waits: [],
    });
  });

  it("also reads what waits in those tasks and the agenda when a named task changed otherwise", () => {
    const plan = planEvent(changed({ tasks: ["ACM-1", "ACM-2"] }));
    expect(plan.tasks).toEqual(["ACM-1", "ACM-2"]);
    expect(plan.waits).toEqual(["ACM-1", "ACM-2"]);
    expect(plan.keys).toEqual([queryKeys.agenda]);
  });

  it("reads the lists when no task is named", () => {
    const plan = planEvent(changed({}));
    expect(plan.tasks).toEqual([]);
    expect(plan.keys).toEqual([queryKeys.tasks, queryKeys.decisions, queryKeys.agenda]);
  });
});

describe("the feed's numbering on the client", () => {
  it("reads everything once when a number is skipped, and not before", () => {
    let last: number | undefined;
    const seen: boolean[] = [];
    for (const seq of [1, 2, 3, 5, 6]) {
      const step = feedStep(last, changed({ seq }));
      seen.push(step.full);
      last = step.seq;
    }
    expect(seen).toEqual([false, false, false, true, false]);
  });
});
