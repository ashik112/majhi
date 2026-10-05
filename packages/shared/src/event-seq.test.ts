import { describe, expect, it } from "vitest";
import { EventSeq, seqGap } from "./event-seq.ts";

describe("event feed numbering", () => {
  it("counts up by one from 1, per connection", () => {
    const a = new EventSeq();
    const b = new EventSeq();
    expect([a.next(), a.next(), a.next()]).toEqual([1, 2, 3]);
    expect(b.next()).toBe(1);
  });

  it("calls a skipped, repeated or restarted number a gap, and the first frame none", () => {
    expect(seqGap(undefined, 1)).toBe(false);
    expect(seqGap(1, 2)).toBe(false);
    expect(seqGap(2, 4)).toBe(true);
    expect(seqGap(4, 4)).toBe(true);
    expect(seqGap(7, 1)).toBe(true);
    expect(seqGap(3, undefined)).toBe(false);
  });
});
