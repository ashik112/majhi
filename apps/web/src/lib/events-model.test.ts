import type { ServerEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { feedStep } from "./events-model";

const changed = (extra: { seq?: number; tasks?: string[]; rows?: true }): ServerEvent => ({
  type: "changed",
  topics: ["tasks"],
  ...extra,
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
