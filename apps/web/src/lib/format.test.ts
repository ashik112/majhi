import { describe, expect, it } from "vitest";
import { formatMoney, formatTokens } from "./format";

describe("formatMoney", () => {
  it("shows cents, and never rounds a small cost to zero", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(0.004)).toBe("<$0.01");
    expect(formatMoney(0.0099)).toBe("<$0.01");
    expect(formatMoney(0.01)).toBe("$0.01");
    expect(formatMoney(4.2)).toBe("$4.20");
    expect(formatMoney(1284.5)).toBe("$1,284.50");
  });
});

describe("formatTokens", () => {
  it("compacts thousands and millions", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(34_200)).toBe("34k");
    expect(formatTokens(999_400)).toBe("999k");
    expect(formatTokens(999_600)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(34_000_000)).toBe("34M");
  });
});
