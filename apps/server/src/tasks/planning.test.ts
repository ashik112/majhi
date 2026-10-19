import { describe, expect, it } from "vitest";
import { fitsAccount } from "./planning.ts";

describe("limits", () => {
  const window = (usedPct: number) => ({ window: { usedPct }, weekly: { usedPct: 10 } });

  it("fits a free account and an account without numbers", () => {
    expect(fitsAccount({ usage: window(20), running: 0 }, "normal").fits).toBe(true);
    expect(fitsAccount({ usage: null, running: 5 }, "large").fits).toBe(true);
  });

  it("counts the tasks already running on the account", () => {
    expect(fitsAccount({ usage: window(70), running: 0 }, "normal").fits).toBe(true);
    expect(fitsAccount({ usage: window(70), running: 3 }, "normal").fits).toBe(false);
  });

  it("stops on the weekly window too", () => {
    const fit = fitsAccount({ usage: { weekly: { usedPct: 94 } }, running: 0 }, "large");
    expect(fit.fits).toBe(false);
    expect(fit.why).toContain("weekly window");
  });
});
