import { describe, it, expect } from "vitest";
import { round2, round1, fmtMoney, fmtPct } from "./format.js";

describe("round helpers", () => {
  it("rounds to 2 and 1 decimals", () => {
    expect(round2(1.236)).toBe(1.24);
    expect(round2(-0.005)).toBe(-0); // banker-free Math.round
    expect(round1(12.34)).toBe(12.3);
  });
});

describe("fmtMoney", () => {
  it("formats positive and negative dollars", () => {
    expect(fmtMoney(1234.5)).toBe("$1234.50");
    expect(fmtMoney(-42)).toBe("-$42.00");
    expect(fmtMoney(0)).toBe("$0.00");
  });
  it("renders an em dash for null/NaN", () => {
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
    expect(fmtMoney(NaN)).toBe("—");
  });
});

describe("fmtPct", () => {
  it("appends a percent sign and dashes out null/NaN", () => {
    expect(fmtPct(51.94)).toBe("51.9%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(NaN)).toBe("—");
  });
});
