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

  it("says which window runs out and when it resets", () => {
    const fit = fitsAccount(
      { usage: { window: { usedPct: 90, resetsAt: "2026-10-01T10:00:00Z" } }, running: 0 },
      "normal",
    );
    expect(fit.fits).toBe(false);
    expect(fit.why).toContain("5-hour window");
    expect(fit.resetsAt).toBe("2026-10-01T10:00:00Z");
  });

  it("stops on the weekly window too", () => {
    const fit = fitsAccount({ usage: { weekly: { usedPct: 94 } }, running: 0 }, "large");
    expect(fit.fits).toBe(false);
    expect(fit.why).toContain("weekly window");
  });
});
