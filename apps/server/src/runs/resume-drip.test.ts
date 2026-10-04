import { describe, expect, it } from "vitest";
import { ResumeDrip } from "./resume-drip.ts";

describe("ResumeDrip", () => {
  it("brings runs back one by one, a gap apart", async () => {
    const log: string[] = [];
    const drip = new ResumeDrip({
      gapMs: 20_000,
      ready: async () => true,
      sleep: async (ms) => void log.push(`wait ${ms}`),
    });
    await drip.run(["a", "b", "c"], (x) => log.push(`start ${x}`));
    expect(log).toEqual(["start a", "wait 20000", "start b", "wait 20000", "start c"]);
  });

  it("holds the next run while the cap or the machine says no", async () => {
    const log: string[] = [];
    let busy = 2;
    const drip = new ResumeDrip({
      gapMs: 20_000,
      ready: async () => busy-- <= 0,
      sleep: async (ms) => void log.push(`wait ${ms}`),
    });
    await drip.run(["a"], (x) => log.push(`start ${x}`));
    expect(log).toEqual(["wait 20000", "wait 20000", "start a"]);
  });

  it("stops handing out runs once stopped", async () => {
    const started: string[] = [];
    const drip = new ResumeDrip({
      ready: async () => true,
      sleep: async () => drip.stop(),
    });
    await drip.run(["a", "b"], (x) => started.push(x));
    expect(started).toEqual(["a"]);
  });
});
