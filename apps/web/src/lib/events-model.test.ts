import type { ServerEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ALL_TOPICS, feedStep, planEvent, topicQueryKeys } from "./events-model";
import { healthEveryMs } from "./feed-status";
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

describe("which queries a topic refetches", () => {
  const touches = (topic: (typeof ALL_TOPICS)[number], key: readonly string[]) =>
    topicQueryKeys(topic).some((k) => k[0] === key[0]);

  it("refetches the ops reads only for the ops topic", () => {
    for (const topic of ALL_TOPICS) expect(touches(topic, queryKeys.ops)).toBe(topic === "ops");
  });

  it("never names a decision detail, so a list refetch does not read the details again", () => {
    for (const topic of ALL_TOPICS) {
      for (const key of topicQueryKeys(topic)) expect(key[0]).not.toBe("decision-detail");
    }
  });

  it("maps a captain event to the captain reads, the decisions and the agenda", () => {
    expect(topicQueryKeys("captain")).toEqual([queryKeys.captain, queryKeys.decisions, queryKeys.agenda]);
  });

  it("asks /health slowly while the socket is up and fast while it is down", () => {
    expect(healthEveryMs(true)).toBe(30_000);
    expect(healthEveryMs(false)).toBe(1500);
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
