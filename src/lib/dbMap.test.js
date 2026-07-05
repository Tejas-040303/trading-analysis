import { describe, it, expect } from "vitest";
import {
  wallIsoToDbIso, dbIsoToWallIso,
  positionToRow, rowToPosition,
  balanceOpToRow, rowToBalanceOp,
  candleToRow, rowToCandle,
} from "./dbMap";

const UID = "00000000-0000-0000-0000-000000000001";

// These tests must pass in ANY machine timezone (the conversions are exact
// inverses in every fixed-offset zone), so they assert round-trips and
// component identities rather than hardcoded zone offsets.
describe("wall-clock ↔ DB timestamp conversion", () => {
  it("dbIsoToWallIso puts the UTC digits into local components", () => {
    const wall = dbIsoToWallIso("2026-06-01T14:30:45.000Z");
    const d = new Date(wall);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
    expect(d.getSeconds()).toBe(45);
  });

  it("wallIsoToDbIso puts the local components into UTC digits", () => {
    // Build a wall-clock ISO the way parseMT5DateTime does: local components.
    const local = new Date(2026, 5, 1, 14, 30, 45).toISOString();
    expect(wallIsoToDbIso(local)).toBe("2026-06-01T14:30:45.000Z");
  });

  it("round-trips are identities in both directions", () => {
    const dbIso = "2026-01-15T09:05:00.000Z";
    expect(wallIsoToDbIso(dbIsoToWallIso(dbIso))).toBe(dbIso);
    const wallIso = new Date(2026, 0, 15, 9, 5, 0).toISOString();
    expect(dbIsoToWallIso(wallIsoToDbIso(wallIso))).toBe(wallIso);
  });

  it("handles null/invalid input", () => {
    expect(wallIsoToDbIso(null)).toBeNull();
    expect(wallIsoToDbIso(undefined)).toBeNull();
    expect(wallIsoToDbIso("garbage")).toBeNull();
    expect(dbIsoToWallIso(null)).toBeNull();
    expect(dbIsoToWallIso("garbage")).toBeNull();
  });

  it("accepts the +00:00 offset form PostgREST returns", () => {
    expect(dbIsoToWallIso("2026-06-01T14:30:45+00:00")).toBe(dbIsoToWallIso("2026-06-01T14:30:45.000Z"));
  });
});

describe("position mapping", () => {
  const pos = {
    ticket: "123456",
    openTime: new Date(2026, 2, 3, 10, 15, 0).toISOString(),
    closeTime: new Date(2026, 2, 3, 10, 45, 30).toISOString(),
    symbol: "GOLD",
    type: "buy",
    volume: 0.05,
    openPrice: 2345.67,
    sl: null,
    tp: 2350,
    closePrice: 2348.1,
    commission: -0.35,
    swap: 0,
    profit: 12.15,
    note: "clean OB entry #patience",
  };

  it("round-trips through row form", () => {
    expect(rowToPosition(positionToRow(pos, UID))).toEqual(pos);
  });

  it("stringifies numeric tickets and nulls a missing note", () => {
    const row = positionToRow({ ...pos, ticket: 987, note: undefined }, UID);
    expect(row.ticket).toBe("987");
    expect(row.note).toBeNull();
    expect(row.user_id).toBe(UID);
    // A null note stays OFF the app-side object (matches parseWorkbookRows output).
    expect("note" in rowToPosition(row)).toBe(false);
  });

  it("coerces numeric strings from the wire", () => {
    const row = positionToRow(pos, UID);
    const back = rowToPosition({ ...row, profit: "12.15", volume: "0.05" });
    expect(back.profit).toBe(12.15);
    expect(back.volume).toBe(0.05);
  });
});

describe("balance op mapping", () => {
  const op = {
    dealId: "555",
    time: new Date(2026, 0, 2, 0, 0, 0).toISOString(),
    profit: 500,
    balance: 1500.25,
    comment: "Deposit",
  };

  it("round-trips through row form", () => {
    expect(rowToBalanceOp(balanceOpToRow(op, UID))).toEqual(op);
  });

  it("defaults comment to empty string and null balance stays null", () => {
    const back = rowToBalanceOp(balanceOpToRow({ dealId: 1, time: op.time, profit: 0, balance: null, comment: "" }, UID));
    expect(back.comment).toBe("");
    expect(back.balance).toBeNull();
    expect(back.dealId).toBe("1");
  });
});

describe("candle mapping", () => {
  const candle = {
    time: new Date(2026, 3, 10, 9, 5, 0).toISOString(),
    open: 2301.1,
    high: 2303.9,
    low: 2300.4,
    close: 2302.2,
    tickVolume: 812,
  };

  it("round-trips through row form and carries series identity", () => {
    const row = candleToRow(candle, UID, "GOLD", "M5");
    expect(row.symbol).toBe("GOLD");
    expect(row.timeframe).toBe("M5");
    expect(row.user_id).toBe(UID);
    expect(rowToCandle(row)).toEqual(candle);
  });

  it("defaults missing tickVolume to 0", () => {
    const { tickVolume, ...noVol } = candle;
    expect(rowToCandle(candleToRow(noVol, UID, "GOLD", "M5")).tickVolume).toBe(0);
  });
});
