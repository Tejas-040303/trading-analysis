import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  UploadCloud, RotateCcw, AlertTriangle, TrendingUp, TrendingDown,
  CircleCheck, Flame, Wallet, Target, Percent, Calendar,
  Settings, Download, Upload, X, BarChart3, ChevronDown, ChevronRight,
  ArrowUpDown, Filter,
} from "lucide-react";
import * as XLSX from "xlsx";
import { storage, estimateUsageBytes } from "./lib/storage";
import { parseCandleCSV, inferSymbolTimeframe, mergeCandles, candleStorageKey } from "./lib/candleParser";
import { computeTradeVerdicts, precomputeSmcState, scanSetups } from "./lib/smc";

// User-editable settings, persisted to tj_settings via the Settings panel.
const DEFAULT_SETTINGS = {
  overtradeThreshold: 15,     // trades/day at or above which a day is flagged "Busy"
  tiltStreakMin: 3,           // consecutive losses that make a tilt cluster
  revengeWindowMin: 3,        // minutes: a same-symbol re-entry after a loss within this is "revenge"
  brokerGmtOffsetHours: null, // reserved for the upcoming session view (Asian/London/NY)
  seriousStart: "2026-05-28", // YYYY-MM-DD; trades before this are archived as the beginner era
  swingLookback: 5,           // fractal pivot lookback for SMC swing detection
};

const C = {
  bg: "#04070D",
  panel: "#0B121C",
  panelAlt: "#101A28",
  border: "#1C2A3A",
  borderSoft: "#152233",
  text: "#E6EDF5",
  textMuted: "#8B9AAE",
  textFaint: "#5B6B80",
  amber: "#FBB94B",
  amberDim: "#7A5A1E",
  emerald: "#39C29A",
  emeraldDim: "#1C4A3B",
  rose: "#E5697A",
  roseDim: "#5A2530",
};

// Balance-operation kinds, for the deposits/withdrawals/transfers ledger.
const OP_KIND = {
  deposit:      { label: "Deposit",      color: C.emerald, bg: C.emeraldDim },
  withdrawal:   { label: "Withdrawal",   color: C.rose,    bg: C.roseDim },
  transfer_out: { label: "Transfer out", color: C.amber,   bg: C.amberDim },
  transfer_in:  { label: "Transfer in",  color: C.emerald, bg: C.emeraldDim },
};

const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const fmtMoney = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const v = round2(n);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
};
const fmtPct = (n) => (n == null || Number.isNaN(n) ? "—" : `${round1(n)}%`);
const fmtDateLabel = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const fmtTime = (d) =>
  new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const fmtDateFull = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};
const fmtDateTimeShort = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Single source of truth for which calendar day a trade belongs to. Uses the
// Date's LOCAL components, which reproduce the original MT5 server wall-clock
// (parseMT5DateTime built the Date from those wall-clock numbers). Never use
// toISOString()/UTC for bucketing — that silently shifts near-midnight trades
// onto the wrong day, and disagreed with the day-of-week chart (which uses
// Date.getDay(), also local). Both now derive from the same local wall-clock.
// (An offset arg for explicit GMT/session bucketing arrives with the Settings panel.)
function tradeDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseMT5DateTime(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const m = value.match(/^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    return new Date(y, mo - 1, d, h, mi, s);
  }
  if (typeof value === "number") {
    return new Date(Math.round((value - 25569) * 86400 * 1000));
  }
  return null;
}
const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
};
const cleanSymbol = (s) => String(s || "").replace("#", "").replace(".i", "");

export function parseWorkbookRows(rows) {
  const idxPositions = rows.findIndex((r) => r[0] === "Positions");
  const idxOrders = rows.findIndex((r) => r[0] === "Orders");
  const idxDeals = rows.findIndex((r) => r[0] === "Deals");

  const positions = [];
  let skipped = 0; // rows that looked like trades (had a ticket) but had unreadable dates
  if (idxPositions !== -1) {
    const dataStart = idxPositions + 2;
    const dataEnd = idxOrders !== -1 ? idxOrders : rows.length;
    for (let i = dataStart; i < dataEnd; i++) {
      const r = rows[i];
      if (!r || r[1] == null) continue;
      const openTime = parseMT5DateTime(r[0]);
      const closeTime = parseMT5DateTime(r[8]);
      if (!openTime || !closeTime) { skipped++; continue; }
      positions.push({
        ticket: String(r[1]),
        openTime: openTime.toISOString(),
        closeTime: closeTime.toISOString(),
        symbol: cleanSymbol(r[2]),
        type: r[3],
        volume: numOrNull(r[4]) ?? 0,
        openPrice: numOrNull(r[5]),
        sl: numOrNull(r[6]),
        tp: numOrNull(r[7]),
        closePrice: numOrNull(r[9]),
        commission: numOrNull(r[10]) ?? 0,
        swap: numOrNull(r[11]) ?? 0,
        profit: numOrNull(r[12]) ?? 0,
      });
    }
  }

  const balanceOps = [];
  if (idxDeals !== -1) {
    const dataStart = idxDeals + 2;
    for (let i = dataStart; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r[0] === "Balance:") break;
      if (r[1] == null || r[3] !== "balance") continue;
      const time = parseMT5DateTime(r[0]);
      if (!time) continue;
      balanceOps.push({
        dealId: String(r[1]),
        time: time.toISOString(),
        profit: numOrNull(r[11]) ?? 0,
        balance: numOrNull(r[12]),
        comment: r[13] || "",
      });
    }
  }

  const meta = {};
  const headerEnd = idxPositions === -1 ? Math.min(6, rows.length) : idxPositions;
  for (let i = 0; i < headerEnd; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r[0] === "Name:") meta.name = r[3];
    if (r[0] === "Account:") meta.account = r[3];
    if (r[0] === "Company:") meta.company = r[3];
  }
  return { positions, balanceOps, meta, skipped };
}

export function computeAnalytics(rawPositions, rawBalanceOps, settings = DEFAULT_SETTINGS) {
  if (!rawPositions.length) return null;
  const pos = rawPositions
    .map((p) => {
      const openTime = new Date(p.openTime);
      const closeTime = new Date(p.closeTime);
      return { ...p, openTime, closeTime, durationMin: (closeTime - openTime) / 60000 };
    })
    .sort((a, b) => a.openTime - b.openTime);

  const dateKey = tradeDate; // local MT5 wall-clock day — consistent with the day-of-week chart
  const dailyMap = new Map();
  pos.forEach((p) => {
    const k = dateKey(p.openTime);
    if (!dailyMap.has(k)) dailyMap.set(k, []);
    dailyMap.get(k).push(p);
  });

  const tiltClusters = [];
  dailyMap.forEach((dayTrades, dateStr) => {
    let streak = [];
    const flush = () => {
      if (streak.length >= settings.tiltStreakMin) {
        const pl = streak.reduce((s, t) => s + t.profit, 0);
        let lotEsc = false;
        for (let i = 1; i < streak.length; i++) if (streak[i].volume > streak[i - 1].volume) lotEsc = true;
        tiltClusters.push({
          date: dateStr,
          start: streak[0].openTime,
          end: streak[streak.length - 1].closeTime,
          count: streak.length,
          pl: round2(pl),
          symbols: [...new Set(streak.map((t) => t.symbol))],
          lotEscalation: lotEsc,
        });
      }
      streak = [];
    };
    dayTrades.forEach((t) => (t.profit < 0 ? streak.push(t) : flush()));
    flush();
  });
  const tiltDates = new Set(tiltClusters.map((c) => c.date));

  let prev = null;
  let revengeCount = 0,
    revengePl = 0;
  pos.forEach((p) => {
    if (prev) {
      const gap = (p.openTime - prev.closeTime) / 60000;
      if (prev.profit < 0 && gap <= settings.revengeWindowMin && gap >= 0 && p.symbol === prev.symbol) {
        revengeCount++;
        revengePl += p.profit;
      }
    }
    prev = p;
  });

  const dailyStats = Array.from(dailyMap.entries())
    .map(([date, trades]) => {
      const profit = trades.reduce((s, t) => s + t.profit, 0);
      const disciplined = trades.filter((t) => t.durationMin >= 3).reduce((s, t) => s + t.profit, 0);
      const wins = trades.filter((t) => t.profit > 0).length;
      return {
        date,
        trades: trades.length,
        profit: round2(profit),
        disciplinedProfit: round2(disciplined),
        winRate: round1((wins / trades.length) * 100),
        overtrading: trades.length >= settings.overtradeThreshold,
        hasTiltCluster: tiltDates.has(date),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  let cum = 0;
  let cumDisc = 0;
  dailyStats.forEach((d) => {
    cum += d.profit;
    cumDisc += d.disciplinedProfit;
    d.cumProfit = round2(cum);
    d.cumDisciplined = round2(cumDisc); // cumulative P/L if under-3-min trades were excluded
    d.label = fmtDateLabel(d.date);
  });

  const bucketDefs = [
    { label: "<1m", min: 0, max: 1 },
    { label: "1-3m", min: 1, max: 3 },
    { label: "3-10m", min: 3, max: 10 },
    { label: "10-30m", min: 10, max: 30 },
    { label: ">30m", min: 30, max: Infinity },
  ];
  const durationBuckets = bucketDefs.map((b) => {
    const trades = pos.filter((p) => p.durationMin >= b.min && p.durationMin < b.max);
    const netPl = trades.reduce((s, t) => s + t.profit, 0);
    const wins = trades.filter((t) => t.profit > 0).length;
    return {
      label: b.label,
      n: trades.length,
      netPl: round2(netPl),
      winRate: trades.length ? round1((wins / trades.length) * 100) : 0,
    };
  });

  const shortTrades = pos.filter((p) => p.durationMin < 3);
  const longTrades = pos.filter((p) => p.durationMin >= 3);

  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowMap = new Map();
  pos.forEach((p) => {
    const d = p.openTime.getDay();
    if (!dowMap.has(d)) dowMap.set(d, []);
    dowMap.get(d).push(p);
  });
  const dowStats = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const trades = dowMap.get(d) || [];
    return { day: dowNames[d], trades: trades.length, profit: round2(trades.reduce((s, t) => s + t.profit, 0)) };
  });

  const symMap = new Map();
  pos.forEach((p) => {
    if (!symMap.has(p.symbol)) symMap.set(p.symbol, []);
    symMap.get(p.symbol).push(p);
  });
  const symbolStats = Array.from(symMap.entries())
    .map(([symbol, trades]) => {
      const wins = trades.filter((t) => t.profit > 0).length;
      return {
        symbol,
        n: trades.length,
        winRate: round1((wins / trades.length) * 100),
        netPl: round2(trades.reduce((s, t) => s + t.profit, 0)),
      };
    })
    .sort((a, b) => b.n - a.n);

  const wins = pos.filter((p) => p.profit > 0);
  const losses = pos.filter((p) => p.profit < 0);
  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = losses.reduce((s, t) => s + t.profit, 0);
  const netProfit = grossProfit + grossLoss;

  // Win/loss streaks — single walk over time-sorted positions (pos is already
  // sorted by openTime). Breakeven trades (profit === 0) reset the streak.
  let longestWinStreak = 0, longestLossStreak = 0;
  let runDir = 0, runLen = 0; // runDir: 1 win, -1 loss, 0 none
  pos.forEach((p) => {
    const d = p.profit > 0 ? 1 : p.profit < 0 ? -1 : 0;
    if (d !== 0 && d === runDir) runLen++;
    else { runDir = d; runLen = d === 0 ? 0 : 1; }
    if (runDir === 1 && runLen > longestWinStreak) longestWinStreak = runLen;
    if (runDir === -1 && runLen > longestLossStreak) longestLossStreak = runLen;
  });
  const currentStreak = { dir: runDir === 1 ? "win" : runDir === -1 ? "loss" : "none", len: runLen };

  // Expectancy: average $ won/lost per trade. avgLoss is negative, so adding.
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0; // negative
  const winFrac = pos.length ? wins.length / pos.length : 0;
  const lossFrac = pos.length ? losses.length / pos.length : 0;
  const expectancy = winFrac * avgWin + lossFrac * avgLoss;

  const bops = rawBalanceOps.map((b) => ({ ...b, time: new Date(b.time) })).sort((a, b) => a.time - b.time);
  let depositsTotal = 0;
  bops.forEach((b) => {
    const c = (b.comment || "").toLowerCase();
    if (!c.includes("transfer to") && !c.includes("transfer from")) depositsTotal += b.profit;
  });

  // Classify each balance op for the ledger (display only — depositsTotal/roiPct unchanged).
  const classifyOp = (b) => {
    const c = (b.comment || "").toLowerCase();
    if (c.includes("transfer to")) return "transfer_out";
    if (c.includes("transfer from")) return "transfer_in";
    return b.profit >= 0 ? "deposit" : "withdrawal";
  };
  const balanceOpsList = bops
    .map((b) => ({
      dealId: b.dealId,
      time: b.time.toISOString(),
      profit: round2(b.profit),
      balance: b.balance != null ? round2(b.balance) : null,
      comment: b.comment || "",
      kind: classifyOp(b),
    }))
    .sort((x, y) => new Date(y.time) - new Date(x.time));
  const sumKind = (k) => round2(bops.reduce((s, b) => s + (classifyOp(b) === k ? b.profit : 0), 0));
  const depositsSum = sumKind("deposit");
  const withdrawalsSum = sumKind("withdrawal");
  const transferOutSum = sumKind("transfer_out");
  const transferInSum = sumKind("transfer_in");
  // True current balance: anchor on the running balance after the last balance op
  // (deposit/withdrawal/transfer), then add the net result of every trade that closed
  // AFTER it. A balance op's `balance` field reflects deposits/withdrawals only — not
  // the trades since — so using it alone leaves the figure stale (e.g. showing the
  // post-deposit balance, not the real post-trading balance).
  let currentBalance = null;
  if (bops.length) {
    const lastOp = bops[bops.length - 1];
    if (lastOp.balance != null) {
      const lastOpMs = lastOp.time.getTime();
      const plAfter = pos.reduce(
        (s, p) => s + (p.closeTime.getTime() > lastOpMs ? p.profit + (p.commission || 0) + (p.swap || 0) : 0),
        0
      );
      currentBalance = lastOp.balance + plAfter;
    }
  }
  // True equity-curve drawdown (spec §6/§7): replay each closed trade's net result
  // in close-time order against the period's opening balance, then take the worst
  // peak-to-trough drop on that curve. Deposits/withdrawals are flows, not trading
  // P/L, so the curve is trades-only — this measures how far your *trading* fell
  // from its high-water mark, in $ and as % of that peak.
  const startEquity = bops.length && bops[0].balance != null ? bops[0].balance : 0;
  const tradeFlows = pos
    .map((p) => ({ t: p.closeTime.getTime(), pl: p.profit + (p.commission || 0) + (p.swap || 0) }))
    .sort((a, b) => a.t - b.t);
  let equity = startEquity;
  let peakEquity = startEquity;
  let maxDrawdownAmt = 0;
  let maxDrawdownPct = 0;
  tradeFlows.forEach((f) => {
    equity += f.pl;
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    if (dd > maxDrawdownAmt) maxDrawdownAmt = dd;
    if (peakEquity > 0) {
      const ddPct = (dd / peakEquity) * 100;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }
  });
  // Session stats (GMT) — requires brokerGmtOffsetHours; null until the user sets it
  // in Settings. Convert each trade's MT5 server hour (local wall-clock component) to
  // GMT via the offset, then bucket into Asian / London / New York / off-hours.
  let sessionStats = null;
  if (settings.brokerGmtOffsetHours != null) {
    const offset = Number(settings.brokerGmtOffsetHours) || 0;
    const sessions = [
      { session: "Asian", lo: 0, hi: 8 },
      { session: "London", lo: 8, hi: 13 },
      { session: "New York", lo: 13, hi: 21 },
      { session: "Off-hours", lo: 21, hi: 24 },
    ];
    sessionStats = sessions.map((s) => {
      const trades = pos.filter((p) => {
        let gmtHour = (p.openTime.getHours() - offset) % 24;
        if (gmtHour < 0) gmtHour += 24;
        return gmtHour >= s.lo && gmtHour < s.hi;
      });
      const w = trades.filter((t) => t.profit > 0).length;
      return {
        session: s.session,
        trades: trades.length,
        profit: round2(trades.reduce((a, t) => a + t.profit, 0)),
        winRate: trades.length ? round1((w / trades.length) * 100) : 0,
      };
    });
  }
  const roiPct = depositsTotal > 0 ? (netProfit / depositsTotal) * 100 : null;

  // R-multiples. Point value per symbol is derived empirically — the median of
  // profit / (signedMove × volume) across that symbol's trades — so we never need
  // hardcoded XM contract specs. Risk = |openPrice − sl| × volume × pointValue;
  // R = profit / risk for trades that carried a stop.
  const pvBySymbol = {};
  symMap.forEach((trades, symbol) => {
    const ests = [];
    trades.forEach((t) => {
      if (t.openPrice == null || t.closePrice == null || !t.volume) return;
      const move = t.type === "sell" ? t.openPrice - t.closePrice : t.closePrice - t.openPrice;
      if (Math.abs(move) < 1e-9) return;
      const pv = t.profit / (move * t.volume);
      if (Number.isFinite(pv) && pv > 0) ests.push(pv);
    });
    if (ests.length) {
      ests.sort((x, y) => x - y);
      pvBySymbol[symbol] = ests[Math.floor(ests.length / 2)];
    }
  });
  const riskOf = (t) => {
    const pv = pvBySymbol[t.symbol];
    if (t.sl == null || t.openPrice == null || !t.volume || !pv) return null;
    const risk = Math.abs(t.openPrice - t.sl) * t.volume * pv;
    return Number.isFinite(risk) && risk > 0 ? risk : null;
  };
  const tradesList = pos
    .map((t) => {
      const risk = riskOf(t);
      return {
        ticket: t.ticket,
        openTime: t.openTime.toISOString(),
        symbol: t.symbol,
        type: t.type,
        durationMin: round1(t.durationMin),
        profit: round2(t.profit),
        r: risk ? round2(t.profit / risk) : null,
        note: t.note || "",
      };
    })
    .sort((a, b) => new Date(b.openTime) - new Date(a.openTime));
  const rTrades = tradesList.filter((t) => t.r != null);
  const avgR = rTrades.length ? round2(rTrades.reduce((s, t) => s + t.r, 0) / rTrades.length) : null;

  // Monthly summaries — roll dailyStats up by YYYY-MM.
  const monthMap = new Map();
  dailyStats.forEach((d) => {
    const ym = d.date.slice(0, 7);
    if (!monthMap.has(ym)) monthMap.set(ym, { trades: 0, profit: 0, wins: 0, days: 0 });
    const m = monthMap.get(ym);
    m.trades += d.trades;
    m.profit += d.profit;
    m.wins += Math.round((d.winRate / 100) * d.trades);
    m.days += 1;
  });
  const monthlyStats = Array.from(monthMap.entries())
    .map(([ym, m]) => ({
      ym,
      label: new Date(ym + "-01T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" }),
      trades: m.trades,
      profit: round2(m.profit),
      winRate: m.trades ? round1((m.wins / m.trades) * 100) : 0,
      days: m.days,
    }))
    .sort((a, b) => b.ym.localeCompare(a.ym));

  // Time-of-day × weekday grid — net P/L and counts per (weekday, hour).
  // Uses the same local wall-clock the rest of the app buckets by.
  const todGrid = {}; // key `${dow}-${hour}` -> { pl, n, wins }
  pos.forEach((p) => {
    const dow = p.openTime.getDay();
    const hr = p.openTime.getHours();
    const key = `${dow}-${hr}`;
    if (!todGrid[key]) todGrid[key] = { pl: 0, n: 0, wins: 0 };
    const cell = todGrid[key];
    cell.pl += p.profit;
    cell.n += 1;
    if (p.profit > 0) cell.wins += 1;
  });

  return {
    totalTrades: pos.length,
    winRate: round1((wins.length / pos.length) * 100),
    netProfit: round2(netProfit),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    profitFactor: grossLoss !== 0 && Number.isFinite(grossProfit / grossLoss) ? round2(Math.abs(grossProfit / grossLoss)) : null,
    largestWin: pos.length ? round2(Math.max(...pos.map((p) => p.profit))) : 0,
    largestLoss: pos.length ? round2(Math.min(...pos.map((p) => p.profit))) : 0,
    currentBalance: currentBalance != null ? round2(currentBalance) : null,
    maxDrawdownPct: round1(maxDrawdownPct),
    maxDrawdownAmt: round2(maxDrawdownAmt),
    roiPct: roiPct != null ? round1(roiPct) : null,
    depositsTotal: round2(depositsTotal),
    daysTracked: dailyStats.length,
    dailyStats,
    durationBuckets,
    shortNet: round2(shortTrades.reduce((s, t) => s + t.profit, 0)),
    longNet: round2(longTrades.reduce((s, t) => s + t.profit, 0)),
    shortCount: shortTrades.length,
    longCount: longTrades.length,
    dowStats,
    sessionStats,
    symbolStats,
    tiltClusters: tiltClusters.sort((a, b) => new Date(b.start) - new Date(a.start)),
    revengeCount,
    revengePl: round2(revengePl),
    tradesList,
    avgR,
    rCount: rTrades.length,
    balanceOps: balanceOpsList,
    depositsSum,
    withdrawalsSum,
    transferOutSum,
    transferInSum,
    netCapital: round2(depositsSum + withdrawalsSum),
    longestWinStreak,
    longestLossStreak,
    currentStreak,
    expectancy: round2(expectancy),
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    monthlyStats,
    todGrid,
  };
}

export function summarizePrior(priorPositions, priorBalanceOps) {
  if (!priorPositions.length && !priorBalanceOps.length) return null;
  const net = priorPositions.reduce((s, p) => s + p.profit, 0);
  const wins = priorPositions.filter((p) => p.profit > 0).length;
  let deposits = 0;
  let withdrawals = 0;
  priorBalanceOps.forEach((b) => {
    const c = (b.comment || "").toLowerCase();
    if (c.includes("transfer to") || c.includes("transfer from")) return;
    if (b.profit >= 0) deposits += b.profit;
    else withdrawals += b.profit;
  });
  const times = priorPositions.map((p) => new Date(p.openTime).getTime());
  return {
    trades: priorPositions.length,
    net: round2(net),
    winRate: priorPositions.length ? round1((wins / priorPositions.length) * 100) : null,
    deposits: round2(deposits),
    withdrawals: round2(withdrawals),
    ops: priorBalanceOps.length,
    firstDate: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastDate: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

function StatCard({ icon: Icon, label, value, sub, tone }) {
  const toneColor = tone === "good" ? C.emerald : tone === "bad" ? C.rose : C.text;
  return (
    <div
      className="rounded-xl p-3"
      style={{ background: C.panel, border: `0.5px solid ${C.border}` }}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={13} style={{ color: C.textFaint }} />
        <span className="text-xs" style={{ color: C.textMuted }}>{label}</span>
      </div>
      <div
        className="text-xl"
        style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500, color: toneColor }}
      >
        {value}
      </div>
      {sub && <div className="text-xs mt-0.5" style={{ color: C.textFaint }}>{sub}</div>}
    </div>
  );
}

function BalanceTotal({ label, value, tone }) {
  const color =
    tone === "good" ? C.emerald : tone === "bad" ? C.rose : tone === "amber" ? C.amber : C.text;
  return (
    <div className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
      <div className="text-xs mb-1" style={{ color: C.textMuted }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 500, color }}>
        {fmtMoney(value)}
      </div>
    </div>
  );
}

function ChartCard({ title, height = 240, children }) {
  return (
    <div className="rounded-xl p-4" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
      <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>{title}</div>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

const tooltipStyle = {
  contentStyle: { background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 },
  labelStyle: { color: C.textMuted, marginBottom: 4 },
  itemStyle: { color: C.text },
};
const axisProps = {
  tick: { fill: C.textFaint, fontSize: 11 },
  axisLine: { stroke: C.border },
  tickLine: { stroke: C.border },
};

function CalendarHeatmap({ days }) {
  if (!days.length) return null;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.profit)));
  const cellColor = (d) => {
    if (!d || d.trades === 0) return C.panelAlt;
    const intensity = 0.2 + 0.8 * Math.min(1, Math.abs(d.profit) / maxAbs);
    const rgb = d.profit >= 0 ? "57,194,154" : "229,105,122";
    return `rgba(${rgb},${intensity})`;
  };
  const months = [];
  const start = new Date(days[0].date + "T00:00:00");
  start.setDate(1);
  const end = new Date(days[days.length - 1].date + "T00:00:00");
  end.setDate(1);
  for (let c = new Date(start); c <= end; c.setMonth(c.getMonth() + 1)) months.push(new Date(c));
  const dowLabels = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div className="flex flex-wrap" style={{ gap: 20 }}>
      {months.map((m, mi) => {
        const y = m.getFullYear();
        const mo = m.getMonth();
        const firstDow = new Date(y, mo, 1).getDay();
        const daysInMonth = new Date(y, mo + 1, 0).getDate();
        const cells = [];
        for (let i = 0; i < firstDow; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) {
          const key = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          cells.push({ d, key, data: byDate.get(key) });
        }
        return (
          <div key={mi}>
            <div className="text-xs mb-1.5" style={{ color: C.textMuted }}>
              {m.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(7, 22px)", gap: 3 }}>
              {dowLabels.map((x, i) => (
                <div key={"h" + i} className="text-center" style={{ fontSize: 9, color: C.textFaint }}>{x}</div>
              ))}
              {cells.map((c, ci) =>
                c == null ? (
                  <div key={ci} />
                ) : (
                  <div
                    key={ci}
                    title={c.data ? `${c.key}: ${fmtMoney(c.data.profit)} · ${c.data.trades} trades` : c.key}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 4,
                      background: cellColor(c.data),
                      border: c.data && c.data.hasTiltCluster ? `1px solid ${C.amber}` : `0.5px solid ${C.border}`,
                      fontSize: 9,
                      color: c.data && c.data.trades ? "rgba(230,237,245,0.7)" : C.textFaint,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {c.d}
                  </div>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Hour × weekday grid shaded by net P/L — surfaces which time windows pay off.
// Hours are bucketed into 3-hour bands to keep the grid scannable.
function TimeOfDayHeatmap({ grid }) {
  const dowNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const dowOrder = [1, 2, 3, 4, 5, 6, 0];
  const bands = [
    { label: "00–03", lo: 0, hi: 3 }, { label: "03–06", lo: 3, hi: 6 },
    { label: "06–09", lo: 6, hi: 9 }, { label: "09–12", lo: 9, hi: 12 },
    { label: "12–15", lo: 12, hi: 15 }, { label: "15–18", lo: 15, hi: 18 },
    { label: "18–21", lo: 18, hi: 21 }, { label: "21–24", lo: 21, hi: 24 },
  ];
  // Aggregate the per-hour grid into (dow, band) cells.
  const cell = (dow, band) => {
    let pl = 0, n = 0, wins = 0;
    for (let h = band.lo; h < band.hi; h++) {
      const c = grid[`${dow}-${h}`];
      if (c) { pl += c.pl; n += c.n; wins += c.wins; }
    }
    return { pl, n, wins };
  };
  let maxAbs = 1;
  dowOrder.forEach((dow) => bands.forEach((b) => { const c = cell(dow, b); if (Math.abs(c.pl) > maxAbs) maxAbs = Math.abs(c.pl); }));
  const bg = (c) => {
    if (!c.n) return C.panelAlt;
    const intensity = 0.2 + 0.8 * Math.min(1, Math.abs(c.pl) / maxAbs);
    return `rgba(${c.pl >= 0 ? "57,194,154" : "229,105,122"},${intensity})`;
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "inline-grid", gridTemplateColumns: `48px repeat(${bands.length}, 44px)`, gap: 3 }}>
        <div />
        {bands.map((b) => (
          <div key={b.label} className="text-center" style={{ fontSize: 9, color: C.textFaint }}>{b.label}</div>
        ))}
        {dowOrder.map((dow, i) => (
          <React.Fragment key={dow}>
            <div className="flex items-center" style={{ fontSize: 10, color: C.textMuted }}>{dowNames[i]}</div>
            {bands.map((b) => {
              const c = cell(dow, b);
              return (
                <div
                  key={b.label}
                  title={c.n ? `${dowNames[i]} ${b.label}: ${fmtMoney(c.pl)} · ${c.n} trades · ${Math.round((c.wins / c.n) * 100)}% win` : `${dowNames[i]} ${b.label}: no trades`}
                  style={{ height: 30, borderRadius: 4, background: bg(c), border: `0.5px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: c.n ? "rgba(230,237,245,0.85)" : C.textFaint, fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {c.n || ""}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function NoteInput({ value, onSave }) {
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value || "")) onSave(v); }}
      placeholder="Add note…"
      style={{
        width: "100%",
        background: "transparent",
        border: `0.5px solid ${C.borderSoft}`,
        borderRadius: 6,
        color: C.text,
        fontSize: 12,
        padding: "3px 6px",
      }}
    />
  );
}

function SettingsModal({ settings, onSave, onClose, onExport, onImportClick }) {
  const [draft, setDraft] = useState(settings);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const fieldStyle = {
    background: C.panelAlt,
    border: `0.5px solid ${C.border}`,
    color: C.text,
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 14,
    width: "100%",
    fontFamily: "'JetBrains Mono', monospace",
  };
  const btn = (bg, color, border) => ({
    background: bg,
    color,
    border: border || "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  });
  const numRow = (k, label, hint) => (
    <div className="mb-4">
      <div className="text-sm mb-1" style={{ color: C.text }}>{label}</div>
      {hint && <div className="text-xs mb-1.5" style={{ color: C.textFaint }}>{hint}</div>}
      <input
        type="number"
        value={draft[k] ?? ""}
        onChange={(e) => set(k, e.target.value === "" ? "" : Number(e.target.value))}
        style={fieldStyle}
      />
    </div>
  );
  const save = () => {
    const num = (v, d) => (v === "" || v == null || Number.isNaN(Number(v)) ? d : Number(v));
    onSave({
      seriousStart: draft.seriousStart || DEFAULT_SETTINGS.seriousStart,
      overtradeThreshold: num(draft.overtradeThreshold, DEFAULT_SETTINGS.overtradeThreshold),
      tiltStreakMin: num(draft.tiltStreakMin, DEFAULT_SETTINGS.tiltStreakMin),
      revengeWindowMin: num(draft.revengeWindowMin, DEFAULT_SETTINGS.revengeWindowMin),
      brokerGmtOffsetHours:
        draft.brokerGmtOffsetHours === "" || draft.brokerGmtOffsetHours == null
          ? null
          : Number(draft.brokerGmtOffsetHours),
      swingLookback: num(draft.swingLookback, DEFAULT_SETTINGS.swingLookback),
    });
  };
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,4,8,0.7)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl"
        style={{ background: C.panel, border: `0.5px solid ${C.border}`, width: "100%", maxWidth: 460, marginTop: 32, marginBottom: 32, padding: 20 }}
      >
        <div className="flex items-center justify-between mb-4">
          <span style={{ color: C.text, fontWeight: 600, fontSize: 17, fontFamily: "'Space Grotesk', sans-serif" }}>Settings</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.textMuted, cursor: "pointer" }} title="Close"><X size={18} /></button>
        </div>

        <div className="mb-4">
          <div className="text-sm mb-1" style={{ color: C.text }}>Serious-trading start date</div>
          <div className="text-xs mb-1.5" style={{ color: C.textFaint }}>Trades before this are archived as your beginner era and excluded from the stats.</div>
          <input type="date" value={draft.seriousStart || ""} onChange={(e) => set("seriousStart", e.target.value)} style={fieldStyle} />
        </div>

        {numRow("overtradeThreshold", "Overtrade threshold", 'Trades in a day at or above this flag the day as "Busy".')}
        {numRow("tiltStreakMin", "Tilt streak", "Consecutive losing trades that count as a tilt cluster.")}
        {numRow("revengeWindowMin", "Revenge window (minutes)", "A same-symbol re-entry within this many minutes of a loss is flagged as revenge.")}
        {numRow("brokerGmtOffsetHours", "Broker GMT offset (hours)", "Your MT5 server's offset from GMT. Used for session bucketing (Asian/London/NY); leave blank if unsure.")}

        <div className="mt-2 pt-4 mb-4" style={{ borderTop: `0.5px solid ${C.border}` }}>
          <div className="text-sm mb-2" style={{ color: C.text, fontWeight: 500 }}>Strategy overlay</div>
        </div>
        {numRow("swingLookback", "Swing lookback (bars)", "Fractal pivot lookback for SMC swing detection. Default 5 — higher values detect larger swings, lower values are more sensitive.")}

        <div className="mt-2 pt-4" style={{ borderTop: `0.5px solid ${C.border}` }}>
          <div className="text-sm mb-1" style={{ color: C.text }}>Backup</div>
          <div className="text-xs mb-2" style={{ color: C.textFaint }}>Your data lives only in this browser. Export a JSON backup, or import one to restore it after a cache clear or on another device.</div>
          <div className="flex gap-2">
            <button onClick={onExport} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}><Download size={14} /> Export JSON</button>
            <button onClick={onImportClick} style={btn(C.panelAlt, C.text, `0.5px solid ${C.border}`)}><Upload size={14} /> Import JSON</button>
          </div>
          {(() => {
            const mb = estimateUsageBytes() / (1024 * 1024);
            // Browsers cap localStorage near 5 MB; warn as the journal + candles approach it.
            const tone = mb >= 4.5 ? C.rose : mb >= 3.5 ? C.amber : C.textFaint;
            return (
              <div className="text-xs mt-2" style={{ color: tone }}>
                Storage in use: ~{mb.toFixed(2)} MB of ~5 MB.
                {mb >= 3.5 && " Approaching the browser limit — export a backup and consider resetting candle data."}
              </div>
            );
          })()}
        </div>

        <div className="flex items-center justify-between mt-5">
          <button onClick={() => setDraft({ ...DEFAULT_SETTINGS })} style={{ background: "transparent", border: "none", color: C.textFaint, fontSize: 13, cursor: "pointer" }}>Reset to defaults</button>
          <div className="flex gap-2">
            <button onClick={onClose} style={btn("transparent", C.textMuted, `0.5px solid ${C.border}`)}>Cancel</button>
            <button onClick={save} style={btn(C.amber, "#2A1A02")}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Confluence score: how many setup strategies "fired" supportively at entry.
// S6 (session) is context, not a setup signal, so it's excluded — max score 5.
// The "supportive" verdict per strategy is a judgment call, surfaced in UI copy.
const CONFLUENCE_RULES = [
  { key: "s1", id: "S1", ok: (s) => s.verdict === "aligned" },
  { key: "s2", id: "S2", ok: (s) => s.verdict === "at-ob" },
  { key: "s3", id: "S3", ok: (s) => s.verdict === "at-fvg" },
  { key: "s4", id: "S4", ok: (s) => s.verdict === "swept" },
  { key: "s5", id: "S5", ok: (s) => s.verdict === "at-poc" || s.verdict === "in-va" },
];
const CONFLUENCE_MAX = CONFLUENCE_RULES.length;

// Extract #hashtags from a free-text note. Reuses the existing note field, so
// tags need no new storage or migration — type "#fomo revenge entry" and it's tagged.
export function parseTags(note) {
  const m = (note || "").match(/#[\w-]+/g);
  if (!m) return [];
  return [...new Set(m.map((t) => t.toLowerCase()))];
}

export function confluenceOf(verdict) {
  const hits = [];
  let scored = 0; // how many strategies had a usable (non-null) verdict
  for (const r of CONFLUENCE_RULES) {
    const s = verdict[r.key];
    if (!s || s.verdict === "insufficient" || s.verdict == null) continue;
    scored++;
    if (r.ok(s)) hits.push(r.id);
  }
  return { score: hits.length, hits, scored };
}

export default function TradingJournal() {
  const [positions, setPositions] = useState([]);
  const [balanceOps, setBalanceOps] = useState([]);
  const [accountMeta, setAccountMeta] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadNotice, setUploadNotice] = useState(null); // informational (e.g. "N rows skipped")
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [candleIndex, setCandleIndex] = useState({}); // { "GOLD_M5": { symbol, timeframe, count } }
  const [expandedTrade, setExpandedTrade] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [chartRange, setChartRange] = useState({ from: "", to: "" }); // date range filter for charts
  const [tradeSort, setTradeSort] = useState({ col: "openTime", dir: "desc" });
  const [tradeFilter, setTradeFilter] = useState({ symbol: "", side: "", structure: "", minConfluence: "", tag: "", strategyVerdict: "" });
  const [dailySort, setDailySort] = useState({ col: "date", dir: "desc" });
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);
  const candleInputRef = useRef(null);

  useEffect(() => {
    if (document.getElementById("tj-fonts")) return;
    const link = document.createElement("link");
    link.id = "tj-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=JetBrains+Mono:wght@400;500;600&display=swap";
    document.head.appendChild(link);
  }, []);

  function loadStateFromStorage() {
    setPositions(storage.get("tj_positions") || []);
    setBalanceOps(storage.get("tj_balance_ops") || []);
    setAccountMeta(storage.get("tj_account_meta") || null);
    setLastUpdated(storage.get("tj_last_updated") || null);
    setSettings({ ...DEFAULT_SETTINGS, ...(storage.get("tj_settings") || {}) });
    setCandleIndex(storage.get("tj_candle_index") || {});
  }

  useEffect(() => {
    loadStateFromStorage();
    setInitializing(false);
  }, []);

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.xlsx$/i.test(f.name));
    if (!files.length) {
      setUploadError("Please upload .xlsx files exported from MT5 (Toolbox > History > right-click > Report > Open XML).");
      return;
    }
    setProcessing(true);
    setUploadError(null);
    setUploadNotice(null);
    const posMap = new Map(positions.map((p) => [p.ticket, p]));
    const balMap = new Map(balanceOps.map((b) => [b.dealId, b]));
    let newMeta = accountMeta;
    const failed = [];
    let totalSkipped = 0;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        const parsed = parseWorkbookRows(rows);
        if (!parsed.positions.length) throw new Error("no positions found");
        parsed.positions.forEach((p) => posMap.set(p.ticket, p));
        parsed.balanceOps.forEach((b) => balMap.set(b.dealId, b));
        if (parsed.meta && parsed.meta.account) newMeta = parsed.meta;
        totalSkipped += parsed.skipped || 0;
      } catch (err) {
        failed.push(file.name);
      }
    }
    const mergedPositions = Array.from(posMap.values());
    const mergedBalanceOps = Array.from(balMap.values());
    const now = new Date().toISOString();
    setPositions(mergedPositions);
    setBalanceOps(mergedBalanceOps);
    setAccountMeta(newMeta);
    setLastUpdated(now);
    // storage.set returns false on failure (e.g. quota exceeded) — collect the result
    // so a full disk surfaces to the user instead of silently dropping their data.
    const writeOk =
      storage.set("tj_positions", mergedPositions) &&
      storage.set("tj_balance_ops", mergedBalanceOps) &&
      (!newMeta || storage.set("tj_account_meta", newMeta)) &&
      storage.set("tj_last_updated", now);
    if (failed.length) {
      setUploadError(`Could not read: ${failed.join(", ")}. Make sure these are MT5 Trade History Report exports.`);
    } else if (!writeOk) {
      setUploadError("Storage is full — your latest upload may not be saved permanently. Export a JSON backup from Settings, then clear old candle data to free space.");
    } else if (totalSkipped > 0) {
      setUploadNotice(`Loaded ${mergedPositions.length} trades · ${totalSkipped} row${totalSkipped === 1 ? "" : "s"} skipped (unreadable date/format).`);
    }
    setProcessing(false);
  }

  async function handleCandleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.csv$/i.test(f.name));
    if (!files.length) {
      setUploadError("Please upload .csv files exported from MT5 (chart → right-click → Save As CSV, or View → Symbols → Bars).");
      return;
    }
    setProcessing(true);
    setUploadError(null);
    setUploadNotice(null);
    const failed = [];
    const newIndex = { ...candleIndex };
    let totalSkipped = 0;
    let quotaHit = false;

    for (const file of files) {
      try {
        const text = await file.text();
        const { candles, skipped } = parseCandleCSV(text);
        if (!candles.length) throw new Error("no candles parsed");
        totalSkipped += skipped || 0;

        let { symbol, timeframe } = inferSymbolTimeframe(file.name);
        if (!symbol) symbol = window.prompt(`Symbol for "${file.name}"? (e.g. GOLD, BTCUSD)`);
        if (!timeframe) timeframe = window.prompt(`Timeframe for "${file.name}"? (e.g. M5, M15, H1)`);
        if (!symbol || !timeframe) {
          failed.push(`${file.name} (couldn't determine symbol/timeframe)`);
          continue;
        }
        symbol = symbol.toUpperCase();
        timeframe = timeframe.toUpperCase();

        const key = candleStorageKey(symbol, timeframe);
        const existing = storage.get(key) || [];
        const merged = mergeCandles(existing, candles);
        // Candle datasets are the largest writes — a failure here is the most
        // likely place to blow the localStorage quota, so check it explicitly.
        if (!storage.set(key, merged)) {
          quotaHit = true;
          failed.push(`${file.name} (storage full)`);
          continue;
        }

        const indexKey = `${symbol}_${timeframe}`;
        newIndex[indexKey] = { symbol, timeframe, count: merged.length };
      } catch (err) {
        failed.push(file.name);
      }
    }

    setCandleIndex(newIndex);
    storage.set("tj_candle_index", newIndex);

    if (quotaHit) {
      setUploadError("Storage is full — candle data couldn't be saved. Export a JSON backup from Settings, then reset or remove some candle data to free space. (localStorage caps around 5 MB.)");
    } else if (failed.length) {
      setUploadError(`Could not read candles: ${failed.join(", ")}. Make sure these are MT5 CSV candle exports.`);
    } else if (totalSkipped > 0) {
      setUploadNotice(`Candles loaded · ${totalSkipped} malformed line${totalSkipped === 1 ? "" : "s"} skipped.`);
    }
    setProcessing(false);
  }

  function handleReset() {
    setPositions([]); setBalanceOps([]); setAccountMeta(null); setLastUpdated(null);
    setConfirmingReset(false);
    try {
      storage.remove("tj_positions");
      storage.remove("tj_balance_ops");
      storage.remove("tj_account_meta");
      storage.remove("tj_last_updated");
      Object.keys(candleIndex).forEach((k) => {
        const ci = candleIndex[k];
        storage.remove(candleStorageKey(ci.symbol, ci.timeframe));
      });
      storage.remove("tj_candle_index");
      setCandleIndex({});
    } catch (e) {}
  }

  function saveNote(ticket, note) {
    setPositions((prev) => {
      const next = prev.map((p) => (p.ticket === ticket ? { ...p, note } : p));
      try { storage.set("tj_positions", next); } catch (e) {}
      return next;
    });
  }

  function saveSettings(next) {
    setSettings(next);
    try { storage.set("tj_settings", next); } catch (e) {}
    setShowSettings(false);
  }

  function exportData() {
    const keys = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("tj_")) keys[k] = localStorage.getItem(k);
    }
    const payload = { app: "trading-journal", exportedAt: new Date().toISOString(), keys };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = `trading-journal-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(el);
    el.click();
    document.body.removeChild(el);
    URL.revokeObjectURL(url);
  }

  async function importData(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const keys = parsed && parsed.keys && typeof parsed.keys === "object" ? parsed.keys : parsed;
      let wrote = 0;
      Object.entries(keys || {}).forEach(([k, v]) => {
        if (!k.startsWith("tj_")) return;
        localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
        wrote++;
      });
      if (!wrote) throw new Error("no tj_ keys");
      loadStateFromStorage();
      setShowSettings(false);
      setUploadError(null);
    } catch (e) {
      setUploadError("Could not import that file — make sure it's a JSON backup exported from this app.");
    }
  }

  const { analytics, prior } = useMemo(() => {
    const cutoff = new Date(settings.seriousStart + "T00:00:00").getTime();
    const mainPos = positions.filter((p) => new Date(p.openTime).getTime() >= cutoff);
    const priorPos = positions.filter((p) => new Date(p.openTime).getTime() < cutoff);
    const mainBal = balanceOps.filter((b) => new Date(b.time).getTime() >= cutoff);
    const priorBal = balanceOps.filter((b) => new Date(b.time).getTime() < cutoff);
    return {
      analytics: computeAnalytics(mainPos, mainBal, settings),
      prior: summarizePrior(priorPos, priorBal),
    };
  }, [positions, balanceOps, settings]);

  // Compute SMC verdicts for each trade when candle data is available.
  // Loads candle data lazily per symbol from localStorage.
  const tradeVerdicts = useMemo(() => {
    if (!analytics || !analytics.tradesList.length) return {};
    const candleCache = {};
    const loadCandles = (symbol) => {
      if (candleCache[symbol] !== undefined) return candleCache[symbol];
      // Try common timeframes in order of preference
      for (const tf of ["M5", "M1", "M15", "M30", "H1"]) {
        const key = `${symbol}_${tf}`;
        if (candleIndex[key]) {
          const data = storage.get(candleStorageKey(symbol, tf));
          if (data && data.length) {
            candleCache[symbol] = data;
            return data;
          }
        }
      }
      candleCache[symbol] = null;
      return null;
    };

    // Precompute SMC state (swings, structure, OBs) once per symbol
    const smcCache = {};
    const getSmcState = (symbol) => {
      if (smcCache[symbol] !== undefined) return smcCache[symbol];
      const candles = loadCandles(symbol);
      smcCache[symbol] = candles ? precomputeSmcState(candles, settings.swingLookback || 5) : null;
      return smcCache[symbol];
    };

    const verdicts = {};
    for (const t of analytics.tradesList) {
      const candles = loadCandles(t.symbol);
      const smc = getSmcState(t.symbol);
      const v = computeTradeVerdicts(candles, t, {
        swingLookback: settings.swingLookback || 5,
        brokerGmtOffsetHours: settings.brokerGmtOffsetHours,
      }, smc);
      v.confluence = confluenceOf(v);
      verdicts[t.ticket] = v;
    }
    return verdicts;
  }, [analytics, candleIndex, settings.swingLookback, settings.brokerGmtOffsetHours]);

  const hasCandleData = Object.keys(candleIndex).length > 0;

  // Filtered daily stats for charts (date range filter)
  const filteredDaily = useMemo(() => {
    if (!analytics) return [];
    let days = analytics.dailyStats;
    if (chartRange.from) days = days.filter((d) => d.date >= chartRange.from);
    if (chartRange.to) days = days.filter((d) => d.date <= chartRange.to);
    // Recompute cumulative on the filtered slice
    let cum = 0, cumDisc = 0;
    return days.map((d) => {
      cum += d.profit;
      cumDisc += d.disciplinedProfit;
      return { ...d, cumProfit: round2(cum), cumDisciplined: round2(cumDisc) };
    });
  }, [analytics, chartRange]);

  // Sorted + filtered trades list
  const sortedTrades = useMemo(() => {
    if (!analytics) return [];
    let list = [...analytics.tradesList];
    // Filter
    if (tradeFilter.symbol) list = list.filter((t) => t.symbol === tradeFilter.symbol);
    if (tradeFilter.side) list = list.filter((t) => t.type === tradeFilter.side);
    if (tradeFilter.structure && hasCandleData) {
      list = list.filter((t) => {
        const v = tradeVerdicts[t.ticket];
        const verdict = v && v.s1 && v.s1.verdict;
        if (tradeFilter.structure === "aligned") return verdict === "aligned";
        if (tradeFilter.structure === "counter") return verdict === "counter";
        if (tradeFilter.structure === "none") return !verdict || verdict === "no-structure" || verdict === "insufficient";
        return true;
      });
    }
    if (tradeFilter.minConfluence && hasCandleData) {
      const min = Number(tradeFilter.minConfluence);
      list = list.filter((t) => {
        const v = tradeVerdicts[t.ticket];
        return v && v.confluence && v.confluence.score >= min;
      });
    }
    if (tradeFilter.tag) {
      list = list.filter((t) => parseTags(t.note).includes(tradeFilter.tag));
    }
    if (tradeFilter.strategyVerdict && hasCandleData) {
      const [key, verdict] = tradeFilter.strategyVerdict.split(":");
      list = list.filter((t) => {
        const v = tradeVerdicts[t.ticket];
        return v && v[key] && v[key].verdict === verdict;
      });
    }
    // Sort
    const dir = tradeSort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let va, vb;
      switch (tradeSort.col) {
        case "openTime": va = a.openTime; vb = b.openTime; break;
        case "symbol": va = a.symbol; vb = b.symbol; break;
        case "type": va = a.type; vb = b.type; break;
        case "durationMin": va = a.durationMin; vb = b.durationMin; break;
        case "profit": va = a.profit; vb = b.profit; break;
        case "r": va = a.r ?? -999; vb = b.r ?? -999; break;
        case "structure": {
          const sv = (t) => { const v = tradeVerdicts[t.ticket]; return v && v.s1 ? v.s1.verdict : ""; };
          va = sv(a); vb = sv(b); break;
        }
        case "confluence": {
          const cv = (t) => { const v = tradeVerdicts[t.ticket]; return v && v.confluence ? v.confluence.score : -1; };
          va = cv(a); vb = cv(b); break;
        }
        default: va = a.openTime; vb = b.openTime;
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return list;
  }, [analytics, tradeSort, tradeFilter, tradeVerdicts, hasCandleData]);

  // All #tags present across trade notes, for the tag filter dropdown.
  const allTags = useMemo(() => {
    if (!analytics) return [];
    const set = new Set();
    analytics.tradesList.forEach((t) => parseTags(t.note).forEach((tag) => set.add(tag)));
    return [...set].sort();
  }, [analytics]);

  // Strategy impact stats
  const strategyImpact = useMemo(() => {
    if (!analytics || !analytics.tradesList.length) return null;
    const s1 = { aligned: [], counter: [], noStructure: [], insufficient: [], noCandles: [] };
    const s2 = { atOB: [], nearOB: [], noOB: [], noData: [] };
    const s3 = { atFVG: [], nearFVG: [], noFVG: [], noData: [] };
    const s4 = { swept: [], noSweep: [], noData: [] };
    const s5 = { atPoc: [], inVa: [], outsideVa: [], noData: [] };
    const s6 = {};
    const confByScore = {}; // confluence score (0–5) -> trades[]
    const confHigh = [];    // score >= 3
    const confLow = [];     // score <= 1
    for (const t of analytics.tradesList) {
      const v = tradeVerdicts[t.ticket];
      // S1
      if (!v || !v.s1) { s1.noCandles.push(t); }
      else if (v.s1.verdict === "aligned") s1.aligned.push(t);
      else if (v.s1.verdict === "counter") s1.counter.push(t);
      else if (v.s1.verdict === "no-structure") s1.noStructure.push(t);
      else s1.insufficient.push(t);
      // S2
      if (!v || !v.s2) { s2.noData.push(t); }
      else if (v.s2.verdict === "at-ob") s2.atOB.push(t);
      else if (v.s2.verdict === "near-ob") s2.nearOB.push(t);
      else if (v.s2.verdict === "no-ob") s2.noOB.push(t);
      else s2.noData.push(t);
      // S3
      if (!v || !v.s3) { s3.noData.push(t); }
      else if (v.s3.verdict === "at-fvg") s3.atFVG.push(t);
      else if (v.s3.verdict === "near-fvg") s3.nearFVG.push(t);
      else if (v.s3.verdict === "no-fvg") s3.noFVG.push(t);
      else s3.noData.push(t);
      // S4
      if (!v || !v.s4) { s4.noData.push(t); }
      else if (v.s4.verdict === "swept") s4.swept.push(t);
      else if (v.s4.verdict === "no-sweep") s4.noSweep.push(t);
      else s4.noData.push(t);
      // S5
      if (!v || !v.s5) { s5.noData.push(t); }
      else if (v.s5.verdict === "at-poc") s5.atPoc.push(t);
      else if (v.s5.verdict === "in-va") s5.inVa.push(t);
      else if (v.s5.verdict === "outside-va") s5.outsideVa.push(t);
      else s5.noData.push(t);
      // S6
      if (v && v.s6 && v.s6.session) {
        if (!s6[v.s6.session]) s6[v.s6.session] = [];
        s6[v.s6.session].push(t);
      }
      // Confluence — only trades that had usable candle data (scored > 0)
      if (v && v.confluence && v.confluence.scored > 0) {
        const sc = v.confluence.score;
        (confByScore[sc] = confByScore[sc] || []).push(t);
        if (sc >= 3) confHigh.push(t);
        else if (sc <= 1) confLow.push(t);
      }
    }
    const stats = (arr) => {
      const w = arr.filter((t) => t.profit > 0).length;
      return { n: arr.length, pl: round2(arr.reduce((s, t) => s + t.profit, 0)), winRate: arr.length ? round1((w / arr.length) * 100) : 0 };
    };
    const byScore = {};
    for (let sc = 0; sc <= CONFLUENCE_MAX; sc++) byScore[sc] = stats(confByScore[sc] || []);
    return {
      s1: { aligned: stats(s1.aligned), counter: stats(s1.counter), noStructure: stats(s1.noStructure), insufficient: stats(s1.insufficient), noCandles: stats(s1.noCandles) },
      s2: { atOB: stats(s2.atOB), nearOB: stats(s2.nearOB), noOB: stats(s2.noOB), noData: stats(s2.noData) },
      s3: { atFVG: stats(s3.atFVG), nearFVG: stats(s3.nearFVG), noFVG: stats(s3.noFVG), noData: stats(s3.noData) },
      s4: { swept: stats(s4.swept), noSweep: stats(s4.noSweep), noData: stats(s4.noData) },
      s5: { atPoc: stats(s5.atPoc), inVa: stats(s5.inVa), outsideVa: stats(s5.outsideVa), noData: stats(s5.noData) },
      s6: Object.fromEntries(Object.entries(s6).map(([k, v]) => [k, stats(v)])),
      confluence: { byScore, high: stats(confHigh), low: stats(confLow) },
    };
  }, [analytics, tradeVerdicts]);

  // Setup scan (P4) — run the SMC rules over ALL candles to find every setup,
  // then match each against executed trades to split "taken" vs "skipped".
  const setupScan = useMemo(() => {
    if (!analytics || !hasCandleData) return null;
    const lookback = settings.swingLookback || 5;
    const matchMs = 15 * 60 * 1000; // a trade counts as "taking" a setup if it opened within 15 min, same side
    const tradesBySymbol = {};
    analytics.tradesList.forEach((t) => { (tradesBySymbol[t.symbol] = tradesBySymbol[t.symbol] || []).push(t); });

    const all = [];
    Object.values(candleIndex).forEach((ci) => {
      const candles = storage.get(candleStorageKey(ci.symbol, ci.timeframe));
      if (!candles || !candles.length) return;
      const smc = precomputeSmcState(candles, lookback);
      if (!smc) return;
      const setups = scanSetups(candles, smc, { swingLookback: lookback, minScore: 3 });
      const symTrades = tradesBySymbol[ci.symbol] || [];
      setups.forEach((s) => {
        const st = new Date(s.time).getTime();
        const taken = symTrades.find((t) => t.type === s.side && Math.abs(new Date(t.openTime).getTime() - st) <= matchMs);
        all.push({ ...s, symbol: ci.symbol, timeframe: ci.timeframe, taken: !!taken, takenTrade: taken || null });
      });
    });
    all.sort((a, b) => new Date(b.time) - new Date(a.time));

    const taken = all.filter((s) => s.taken);
    const skipped = all.filter((s) => !s.taken);
    const avg = (arr, key) => {
      const vals = arr.map((s) => s[key]).filter((v) => v != null);
      return vals.length ? round2(vals.reduce((x, y) => x + y, 0) / vals.length) : null;
    };
    return {
      all, taken, skipped,
      total: all.length,
      takenCount: taken.length,
      skippedCount: skipped.length,
      takenPct: all.length ? round1((taken.length / all.length) * 100) : 0,
      takenAvgMfeR: avg(taken, "mfeR"),
      skippedAvgMfeR: avg(skipped, "mfeR"),
      skippedAvgMaeR: avg(skipped, "maeR"),
    };
  }, [analytics, candleIndex, hasCandleData, settings.swingLookback]);

  const toggleSort = (col) => setTradeSort((prev) => prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  const toggleDailySort = (col) => setDailySort((prev) => prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  const sortedDaily = useMemo(() => {
    if (!analytics) return [];
    const list = [...analytics.dailyStats];
    const dir = dailySort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let va, vb;
      switch (dailySort.col) {
        case "date": va = a.date; vb = b.date; break;
        case "trades": va = a.trades; vb = b.trades; break;
        case "winRate": va = a.winRate; vb = b.winRate; break;
        case "profit": va = a.profit; vb = b.profit; break;
        case "status": va = a.hasTiltCluster ? 2 : a.overtrading ? 1 : 0; vb = b.hasTiltCluster ? 2 : b.overtrading ? 1 : 0; break;
        default: va = a.date; vb = b.date;
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return list;
  }, [analytics, dailySort]);
  const setRange = (days) => {
    if (!analytics || !analytics.dailyStats.length) return;
    if (days === 0) { setChartRange({ from: "", to: "" }); return; }
    const last = analytics.dailyStats[analytics.dailyStats.length - 1].date;
    const d = new Date(last + "T00:00:00");
    d.setDate(d.getDate() - days + 1);
    setChartRange({ from: d.toISOString().slice(0, 10), to: "" });
  };

  const seriousLabel = new Date(settings.seriousStart + "T00:00:00").toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const settingsModal = showSettings && (
    <SettingsModal
      settings={settings}
      onSave={saveSettings}
      onClose={() => setShowSettings(false)}
      onExport={exportData}
      onImportClick={() => importInputRef.current?.click()}
    />
  );

  const headerNode = (
    <div className="flex items-start justify-between flex-wrap gap-3 mb-6">
      <div>
        <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 22, color: C.text }}>
          Trading journal
        </h1>
        <div className="text-sm mt-1" style={{ color: C.textMuted }}>
          {accountMeta
            ? `${accountMeta.account || ""} · ${accountMeta.company || ""}`
            : "Upload your MT5 history report to begin"}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {lastUpdated && (
          <span className="text-xs mr-1" style={{ color: C.textFaint }}>
            updated {new Date(lastUpdated).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg"
          style={{ background: C.amber, color: "#2A1A02", fontWeight: 500, border: "none" }}
        >
          <UploadCloud size={14} /> Upload report{positions.length ? "s" : ""}
        </button>
        <button
          onClick={() => candleInputRef.current?.click()}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg"
          style={{ background: "transparent", color: C.amber, border: `0.5px solid ${C.amberDim}`, fontWeight: 500 }}
          title="Upload MT5 candle CSV for strategy analysis"
        >
          <BarChart3 size={14} /> Candles
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg"
          style={{ background: "transparent", color: C.textMuted, border: `0.5px solid ${C.border}` }}
          title="Settings & backup"
        >
          <Settings size={14} /> Settings
        </button>
        {positions.length > 0 && !confirmingReset && (
          <button
            onClick={() => setConfirmingReset(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg"
            style={{ background: "transparent", color: C.textMuted, border: `0.5px solid ${C.border}` }}
          >
            <RotateCcw size={14} /> Reset
          </button>
        )}
        {confirmingReset && (
          <div className="flex items-center gap-2 text-sm">
            <span style={{ color: C.textMuted }}>Clear all data?</span>
            <button onClick={handleReset} className="px-2 py-1 rounded-lg" style={{ background: C.rose, color: "#2A0A0E" }}>Yes</button>
            <button onClick={() => setConfirmingReset(false)} className="px-2 py-1 rounded-lg" style={{ background: "transparent", color: C.textMuted, border: `0.5px solid ${C.border}` }}>Cancel</button>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept=".xlsx" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
        <input ref={candleInputRef} type="file" accept=".csv" multiple className="hidden" onChange={(e) => { handleCandleFiles(e.target.files); e.target.value = ""; }} />
        <input ref={importInputRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { importData(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    </div>
  );

  const dropzone = (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
      onClick={() => fileInputRef.current?.click()}
      className="rounded-xl flex flex-col items-center justify-center text-center cursor-pointer"
      style={{
        background: C.panel,
        border: `1.5px dashed ${dragOver ? C.amber : C.border}`,
        minHeight: 280,
        padding: 32,
      }}
    >
      <UploadCloud size={28} style={{ color: dragOver ? C.amber : C.textFaint, marginBottom: 12 }} />
      <div style={{ color: C.text, fontWeight: 500, marginBottom: 4 }}>Drop your MT5 Trade History Report here</div>
      <div className="text-sm max-w-md" style={{ color: C.textMuted }}>
        In MT5: Toolbox → History tab → right-click → Report → Open XML (.xlsx). You can drop multiple reports at once —
        overlapping trades are deduped automatically by ticket ID, so daily exports merge cleanly.
      </div>
      {processing && <div className="text-sm mt-3" style={{ color: C.amber }}>Processing…</div>}
    </div>
  );

  const priorSection = prior && (
    <div className="rounded-xl p-4 mb-6" style={{ background: C.panelAlt, border: `1px dashed ${C.border}` }}>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Before {seriousLabel} — beginner era</span>
        <span className="text-xs" style={{ color: C.textFaint }}>(excluded from the analysis above)</span>
      </div>
      <div className="text-xs mb-3" style={{ color: C.textFaint }}>
        Your early learning period — this account was funded and blown while starting out. Kept for the record, not counted in the stats above.
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg p-3" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
          <div className="text-xs mb-1" style={{ color: C.textFaint }}>Trades</div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 500, color: C.textMuted }}>
            {prior.trades}{prior.winRate != null ? ` · ${prior.winRate}% win` : ""}
          </div>
        </div>
        <div className="rounded-lg p-3" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
          <div className="text-xs mb-1" style={{ color: C.textFaint }}>Net P/L</div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 500, color: prior.net >= 0 ? C.emerald : C.rose }}>
            {fmtMoney(prior.net)}
          </div>
        </div>
        <div className="rounded-lg p-3" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
          <div className="text-xs mb-1" style={{ color: C.textFaint }}>Deposited then</div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 500, color: C.textMuted }}>
            {fmtMoney(prior.deposits)}
          </div>
        </div>
        <div className="rounded-lg p-3" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
          <div className="text-xs mb-1" style={{ color: C.textFaint }}>Period</div>
          <div style={{ fontSize: 13, fontWeight: 500, color: C.textMuted, paddingTop: 2 }}>
            {prior.firstDate
              ? `${new Date(prior.firstDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(prior.lastDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
              : "—"}
          </div>
        </div>
      </div>
    </div>
  );

  if (initializing) {
    return <div style={{ background: C.bg, minHeight: 400 }} className="p-8" />;
  }

  if (!analytics) {
    return (
      <div style={{ background: C.bg, color: C.text, minHeight: 480 }} className="rounded-2xl p-6 md:p-8">
        {headerNode}
        {prior && (
          <div className="text-sm mb-4 px-3 py-2 rounded-lg" style={{ color: C.amber, background: C.panelAlt }}>
            No trades on or after {seriousLabel} in your uploaded data yet — upload reports from {seriousLabel} onward to populate the dashboard. Your earlier history is shown below.
          </div>
        )}
        {prior ? priorSection : dropzone}
        {uploadError && <div className="text-sm mt-3" style={{ color: C.rose }}>{uploadError}</div>}
        {uploadNotice && <div className="text-sm mt-3" style={{ color: C.textMuted }}>{uploadNotice}</div>}
        {settingsModal}
      </div>
    );
  }

  const a = analytics;

  const TABS = [
    { id: "dashboard", label: "Dashboard" },
    { id: "trades", label: "Trades" },
    { id: "strategy", label: "Strategy" },
  ];

  const tabBar = (
    <div className="flex gap-1 mb-6 rounded-lg p-1" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className="flex-1 text-sm py-2 rounded-md"
          style={{
            background: activeTab === tab.id ? C.panelAlt : "transparent",
            color: activeTab === tab.id ? C.text : C.textMuted,
            border: activeTab === tab.id ? `0.5px solid ${C.border}` : "0.5px solid transparent",
            fontWeight: activeTab === tab.id ? 600 : 400,
            fontFamily: "'Space Grotesk', sans-serif",
            cursor: "pointer",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: 480 }} className="rounded-2xl p-6 md:p-8">
      {headerNode}

      <div className="text-xs mb-4" style={{ color: C.textFaint }}>
        Showing {a.totalTrades} trades since {seriousLabel}.{prior ? " Your earlier beginner-era history is archived in the Dashboard tab." : ""}
      </div>

      {uploadError && (
        <div className="text-sm mb-4 px-3 py-2 rounded-lg" style={{ color: C.rose, background: C.roseDim }}>{uploadError}</div>
      )}
      {uploadNotice && (
        <div className="text-sm mb-4 px-3 py-2 rounded-lg" style={{ color: C.textMuted, background: C.panelAlt }}>{uploadNotice}</div>
      )}
      {processing && (
        <div className="text-sm mb-4" style={{ color: C.amber }}>Processing new upload…</div>
      )}

      {tabBar}

      {/* ── Dashboard tab ──────────────────────────────────────────── */}
      {activeTab === "dashboard" && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <StatCard icon={TrendingUp} label="Net trading P/L" value={fmtMoney(a.netProfit)} tone={a.netProfit >= 0 ? "good" : "bad"} sub={`${a.totalTrades} trades`} />
            <StatCard icon={Target} label="Win rate" value={fmtPct(a.winRate)} sub={`PF ${a.profitFactor ?? "—"}`} />
            <StatCard icon={Wallet} label="Current balance" value={fmtMoney(a.currentBalance)} sub={`ROI ${fmtPct(a.roiPct)}`} />
            <StatCard icon={AlertTriangle} label="Max drawdown" value={fmtPct(a.maxDrawdownPct)} tone={a.maxDrawdownPct > 50 ? "bad" : undefined} sub={a.maxDrawdownAmt > 0 ? `${fmtMoney(-a.maxDrawdownAmt)} peak-to-trough` : `${a.daysTracked} active days`} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <StatCard icon={Calendar} label="Gross profit" value={fmtMoney(a.grossProfit)} tone="good" />
            <StatCard icon={Calendar} label="Gross loss" value={fmtMoney(a.grossLoss)} tone="bad" />
            <StatCard icon={Percent} label="Largest win" value={fmtMoney(a.largestWin)} tone="good" />
            <StatCard icon={Percent} label="Largest loss" value={fmtMoney(a.largestLoss)} tone="bad" />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <StatCard icon={Target} label="Expectancy / trade" value={fmtMoney(a.expectancy)} tone={a.expectancy >= 0 ? "good" : "bad"} sub={`avg win ${fmtMoney(a.avgWin)} · avg loss ${fmtMoney(a.avgLoss)}`} />
            <StatCard icon={TrendingUp} label="Longest win streak" value={`${a.longestWinStreak}`} tone="good" sub="consecutive wins" />
            <StatCard icon={TrendingDown} label="Longest loss streak" value={`${a.longestLossStreak}`} tone="bad" sub="consecutive losses" />
            <StatCard icon={Flame} label="Current streak" value={a.currentStreak.len ? `${a.currentStreak.len} ${a.currentStreak.dir}${a.currentStreak.len > 1 ? "s" : ""}` : "—"} tone={a.currentStreak.dir === "win" ? "good" : a.currentStreak.dir === "loss" ? "bad" : undefined} sub="most recent run" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            <div className="rounded-xl p-4" style={{ background: C.panel, border: `0.5px solid ${C.emeraldDim}` }}>
              <div className="text-xs mb-1" style={{ color: C.textMuted }}>Trades held 3+ minutes</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 500, color: C.emerald }}>{fmtMoney(a.longNet)}</div>
              <div className="text-xs mt-1" style={{ color: C.textFaint }}>{a.longCount} trades — patient, setup-based entries</div>
            </div>
            <div className="rounded-xl p-4" style={{ background: C.panel, border: `0.5px solid ${C.roseDim}` }}>
              <div className="text-xs mb-1" style={{ color: C.textMuted }}>Trades held under 3 minutes</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 500, color: C.rose }}>{fmtMoney(a.shortNet)}</div>
              <div className="text-xs mt-1" style={{ color: C.textFaint }}>{a.shortCount} trades — impulsive, quick in-and-out</div>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-4 flex-wrap rounded-lg p-2" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
            <span className="text-xs" style={{ color: C.textMuted }}>Range:</span>
            {[{ label: "7d", d: 7 }, { label: "14d", d: 14 }, { label: "30d", d: 30 }, { label: "All", d: 0 }].map((r) => (
              <button
                key={r.label}
                onClick={() => setRange(r.d)}
                className="text-xs px-2 py-1 rounded"
                style={{
                  background: (r.d === 0 && !chartRange.from) ? C.panelAlt : "transparent",
                  color: (r.d === 0 && !chartRange.from) ? C.text : C.textMuted,
                  border: `0.5px solid ${C.border}`, cursor: "pointer",
                }}
              >{r.label}</button>
            ))}
            <input
              type="date" value={chartRange.from} onChange={(e) => setChartRange((p) => ({ ...p, from: e.target.value }))}
              className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}`, fontFamily: "'JetBrains Mono', monospace" }}
            />
            <span className="text-xs" style={{ color: C.textFaint }}>to</span>
            <input
              type="date" value={chartRange.to} onChange={(e) => setChartRange((p) => ({ ...p, to: e.target.value }))}
              className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}`, fontFamily: "'JetBrains Mono', monospace" }}
            />
            {(chartRange.from || chartRange.to) && (
              <button onClick={() => setChartRange({ from: "", to: "" })} className="text-xs px-2 py-1 rounded" style={{ color: C.textFaint, background: "transparent", border: "none", cursor: "pointer" }}>Clear</button>
            )}
            {chartRange.from && <span className="text-xs" style={{ color: C.textFaint }}>Showing {filteredDaily.length} of {a.dailyStats.length} days</span>}
          </div>

          <div className="mb-4">
            <ChartCard title={`Daily P/L and cumulative trading profit${chartRange.from ? " (filtered)" : ""}`} height={260}>
              <ComposedChart data={filteredDaily} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.borderSoft} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" {...axisProps} />
                <YAxis yAxisId="left" {...axisProps} tickFormatter={(v) => (v < 0 ? "-$" : "$") + Math.abs(v)} width={50} />
                <YAxis yAxisId="right" orientation="right" {...axisProps} tickFormatter={(v) => (v < 0 ? "-$" : "$") + Math.abs(v)} width={50} />
                <Tooltip {...tooltipStyle} formatter={(v, name) => [fmtMoney(v), name]} labelFormatter={(l, payload) => { const d = payload?.[0]?.payload; return d ? `${l} · ${d.trades} trades · ${d.winRate}% win` : l; }} />
                <Bar yAxisId="left" dataKey="profit" name="Daily P/L" radius={[3, 3, 0, 0]}>
                  {filteredDaily.map((d, i) => (
                    <Cell
                      key={i}
                      fill={d.profit >= 0 ? C.emerald : C.rose}
                      stroke={d.hasTiltCluster ? C.amber : "transparent"}
                      strokeWidth={d.hasTiltCluster ? 2 : 0}
                    />
                  ))}
                </Bar>
                <Line yAxisId="right" type="monotone" dataKey="cumProfit" name="Cumulative" stroke={C.amber} strokeWidth={2} dot={{ r: 2, fill: C.amber }} />
                <Line yAxisId="right" type="monotone" dataKey="cumDisciplined" name="If 3min+ only" stroke={C.emerald} strokeWidth={2} strokeDasharray="4 3" dot={false} />
              </ComposedChart>
            </ChartCard>
            <div className="text-xs mt-2" style={{ color: C.textFaint }}>
              Amber line = actual cumulative P/L. <span style={{ color: C.emerald }}>Dashed green</span> = cumulative P/L if every under-3-minute trade were removed — the gap between them is the "patience tax." Amber bar outline = a same-day tilt cluster ({settings.tiltStreakMin}+ losses in a row).
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <ChartCard title="Outcome by how long you held the trade" height={220}>
              <BarChart data={a.durationBuckets} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.borderSoft} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={(v) => (v < 0 ? "-$" : "$") + Math.abs(v)} width={46} />
                <Tooltip {...tooltipStyle} formatter={(v, name, p) => [name === "netPl" ? fmtMoney(v) : v, name === "netPl" ? "Net P/L" : name]} labelFormatter={(l, p) => `${l} hold · ${p?.[0]?.payload?.n ?? ""} trades · ${p?.[0]?.payload?.winRate ?? ""}% win`} />
                <Bar dataKey="netPl" radius={[3, 3, 0, 0]}>
                  {a.durationBuckets.map((d, i) => (
                    <Cell key={i} fill={d.netPl >= 0 ? C.emerald : C.rose} />
                  ))}
                </Bar>
              </BarChart>
            </ChartCard>
            <ChartCard title="Net P/L by day of week" height={220}>
              <BarChart data={a.dowStats} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.borderSoft} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={(v) => (v < 0 ? "-$" : "$") + Math.abs(v)} width={46} />
                <Tooltip {...tooltipStyle} formatter={(v) => fmtMoney(v)} labelFormatter={(l, p) => `${l} · ${p?.[0]?.payload?.trades ?? 0} trades`} />
                <Bar dataKey="profit" radius={[3, 3, 0, 0]}>
                  {a.dowStats.map((d, i) => (
                    <Cell key={i} fill={d.profit >= 0 ? C.emerald : C.rose} />
                  ))}
                </Bar>
              </BarChart>
            </ChartCard>
          </div>

          {a.sessionStats ? (
            <div className="mb-6">
              <ChartCard title="Net P/L by trading session (GMT)" height={220}>
                <BarChart data={a.sessionStats} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={C.borderSoft} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="session" {...axisProps} />
                  <YAxis {...axisProps} tickFormatter={(v) => (v < 0 ? "-$" : "$") + Math.abs(v)} width={46} />
                  <Tooltip {...tooltipStyle} formatter={(v) => fmtMoney(v)} labelFormatter={(l, p) => `${l} · ${p?.[0]?.payload?.trades ?? 0} trades · ${p?.[0]?.payload?.winRate ?? 0}% win`} />
                  <Bar dataKey="profit" radius={[3, 3, 0, 0]}>
                    {a.sessionStats.map((d, i) => (
                      <Cell key={i} fill={d.profit >= 0 ? C.emerald : C.rose} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartCard>
            </div>
          ) : (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <span className="text-sm" style={{ color: C.text, fontWeight: 500 }}>Session view (Asian / London / New York)</span>
              <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                Set your broker's GMT offset in <span style={{ color: C.amber }}>Settings</span> to split your P/L by trading session — MT5 server time isn't GMT, so the offset is needed to label sessions correctly.
              </div>
            </div>
          )}

          {a.monthlyStats.length > 0 && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>Monthly summary</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {a.monthlyStats.map((m) => (
                  <div key={m.ym} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}`, borderLeft: `3px solid ${m.profit >= 0 ? C.emerald : C.rose}` }}>
                    <div className="text-sm" style={{ color: C.text, fontWeight: 500 }}>{m.label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: m.profit >= 0 ? C.emerald : C.rose, marginTop: 2 }}>{fmtMoney(m.profit)}</div>
                    <div className="text-xs mt-1" style={{ color: C.textFaint }}>{m.trades} trades · {m.winRate}% win · {m.days} days</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
            <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>When you trade — net P/L by weekday &amp; time</div>
            <TimeOfDayHeatmap grid={a.todGrid} />
            <div className="text-xs mt-3" style={{ color: C.textFaint }}>
              Each cell is a 3-hour window on a weekday, shaded by net P/L (green profit, red loss); the number is trade count. Hover for win rate. Uses your MT5 server wall-clock — set the broker GMT offset in Settings if you want it aligned to real sessions.
            </div>
          </div>

          <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
            <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>Calendar</div>
            <div style={{ overflowX: "auto" }}>
              <CalendarHeatmap days={a.dailyStats} />
            </div>
            <div className="text-xs mt-3" style={{ color: C.textFaint }}>
              Each cell is a trading day, shaded green (profit) or red (loss) by size. Amber border = a tilt-cluster day.
            </div>
          </div>

          {a.balanceOps.length > 0 && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <Wallet size={15} style={{ color: C.amber }} />
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Deposits, withdrawals &amp; transfers</span>
                <span className="text-xs" style={{ color: C.textFaint }}>({a.balanceOps.length} balance operations)</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <BalanceTotal label="Deposited" value={a.depositsSum} tone="good" />
                <BalanceTotal label="Withdrawn" value={a.withdrawalsSum} tone="bad" />
                <BalanceTotal label="Transferred out (skim)" value={a.transferOutSum} tone="amber" />
                <BalanceTotal label="Transferred in" value={a.transferInSum} tone="good" />
              </div>

              <div style={{ maxHeight: 260, overflowY: "auto" }}>
                <table className="w-full text-sm">
                  <thead style={{ position: "sticky", top: 0, background: C.panel }}>
                    <tr style={{ color: C.textFaint }}>
                      <th className="text-left pb-2 text-xs">Date</th>
                      <th className="text-left pb-2 text-xs">Type</th>
                      <th className="text-right pb-2 text-xs">Amount</th>
                      <th className="text-right pb-2 text-xs">Balance after</th>
                      <th className="text-left pb-2 text-xs pl-3">Comment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.balanceOps.map((op) => {
                      const meta = OP_KIND[op.kind];
                      return (
                        <tr key={op.dealId} style={{ borderTop: `0.5px solid ${C.borderSoft}` }}>
                          <td className="py-1.5" style={{ color: C.textMuted, whiteSpace: "nowrap" }}>{fmtDateTimeShort(op.time)}</td>
                          <td className="py-1.5">
                            <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: meta.color, background: meta.bg, whiteSpace: "nowrap" }}>{meta.label}</span>
                          </td>
                          <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: op.profit >= 0 ? C.emerald : C.rose }}>{fmtMoney(op.profit)}</td>
                          <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: C.textMuted }}>{op.balance != null ? fmtMoney(op.balance) : "—"}</td>
                          <td className="py-1.5 pl-3 text-xs" style={{ color: C.textFaint, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={op.comment}>{op.comment || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="text-xs mt-3" style={{ color: C.textFaint }}>
                Net external capital (deposits − withdrawals): {" "}
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: a.netCapital >= 0 ? C.emerald : C.rose }}>{fmtMoney(a.netCapital)}</span>.
                {" "}Transfers move money between your own accounts, so they net out of ROI; "transfer out" is profit you skimmed off to preserve it.
              </div>
            </div>
          )}

          {priorSection}
        </>
      )}

      {/* ── Trades tab ─────────────────────────────────────────────── */}
      {activeTab === "trades" && (
        <>
          <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
            <div className="flex items-center gap-2 mb-3">
              <Flame size={15} style={{ color: C.amber }} />
              <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Tilt clusters detected</span>
              <span className="text-xs" style={{ color: C.textFaint }}>({settings.tiltStreakMin}+ same-day losses in a row, plus quick same-symbol re-entries)</span>
            </div>
            {a.revengeCount > 0 && (
              <div className="text-xs mb-3" style={{ color: C.textFaint }}>
                Also: {a.revengeCount} re-entries within {settings.revengeWindowMin} min of a loss on the same symbol, net {fmtMoney(a.revengePl)}.
              </div>
            )}
            {a.tiltClusters.length === 0 ? (
              <div className="flex items-center gap-2 text-sm" style={{ color: C.emerald }}>
                <CircleCheck size={15} /> No tilt clusters in the uploaded data — disciplined across every day so far.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {a.tiltClusters.map((c, i) => (
                  <div key={i} className="rounded-lg p-3" style={{ background: C.panelAlt, borderLeft: `3px solid ${C.rose}` }}>
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm" style={{ color: C.text, fontWeight: 500 }}>{fmtDateFull(c.date)}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: C.rose, fontWeight: 500 }}>{fmtMoney(c.pl)}</span>
                    </div>
                    <div className="text-xs mt-1" style={{ color: C.textMuted }}>
                      {fmtTime(c.start)}–{fmtTime(c.end)} · {c.count} losses in a row · {c.symbols.join(", ")}
                      {c.lotEscalation && <span style={{ color: C.amber }}> · lot size increased mid-streak</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <div className="rounded-xl p-4 lg:col-span-1" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>By symbol</div>
              <div style={{ overflow: "auto", maxHeight: 320 }}>
                <table className="text-sm" style={{ minWidth: 280, width: "100%" }}>
                  <thead style={{ position: "sticky", top: 0, background: C.panel, zIndex: 1 }}>
                    <tr style={{ color: C.textFaint }}>
                      <th className="text-left pb-2 text-xs" style={{ resize: "horizontal", overflow: "hidden" }}>Symbol</th>
                      <th className="text-right pb-2 text-xs" style={{ resize: "horizontal", overflow: "hidden" }}>N</th>
                      <th className="text-right pb-2 text-xs" style={{ resize: "horizontal", overflow: "hidden" }}>Win%</th>
                      <th className="text-right pb-2 text-xs" style={{ resize: "horizontal", overflow: "hidden" }}>P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.symbolStats.map((s) => (
                      <tr key={s.symbol} style={{ borderTop: `0.5px solid ${C.borderSoft}` }}>
                        <td className="py-1.5" style={{ color: C.text }}>{s.symbol}</td>
                        <td className="py-1.5 text-right" style={{ color: C.textMuted }}>{s.n}</td>
                        <td className="py-1.5 text-right" style={{ color: C.textMuted }}>{s.winRate}%</td>
                        <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: s.netPl >= 0 ? C.emerald : C.rose }}>{fmtMoney(s.netPl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl p-4 lg:col-span-2" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>Daily breakdown</div>
              <div style={{ maxHeight: 320, overflow: "auto" }}>
                <table className="text-sm" style={{ minWidth: 480, width: "100%" }}>
                  <thead style={{ position: "sticky", top: 0, background: C.panel, zIndex: 1 }}>
                    <tr style={{ color: C.textFaint }}>
                      {[
                        { col: "date", label: "Date", align: "text-left" },
                        { col: "trades", label: "Trades", align: "text-right" },
                        { col: "winRate", label: "Win%", align: "text-right" },
                        { col: "profit", label: "P/L", align: "text-right" },
                        { col: "status", label: "Status", align: "text-right" },
                      ].map((h) => (
                        <th
                          key={h.col}
                          className={`${h.align} pb-2 text-xs`}
                          style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", resize: "horizontal", overflow: "hidden" }}
                          onClick={() => toggleDailySort(h.col)}
                        >
                          {h.label} {dailySort.col === h.col ? (dailySort.dir === "asc" ? "↑" : "↓") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDaily.map((d) => {
                      const stripe = d.hasTiltCluster ? C.rose : d.overtrading ? C.amber : C.emerald;
                      const statusText = d.hasTiltCluster ? "Tilt" : d.overtrading ? "Busy" : "Calm";
                      const statusColor = d.hasTiltCluster ? C.rose : d.overtrading ? C.amber : C.emerald;
                      return (
                        <tr key={d.date} style={{ borderTop: `0.5px solid ${C.borderSoft}` }}>
                          <td className="py-1.5" style={{ color: C.text, borderLeft: `3px solid ${stripe}`, paddingLeft: 8, whiteSpace: "nowrap" }}>{fmtDateLabel(d.date)}</td>
                          <td className="py-1.5 text-right" style={{ color: C.textMuted }}>{d.trades}</td>
                          <td className="py-1.5 text-right" style={{ color: C.textMuted }}>{d.winRate}%</td>
                          <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: d.profit >= 0 ? C.emerald : C.rose }}>{fmtMoney(d.profit)}</td>
                          <td className="py-1.5 text-right text-xs" style={{ color: statusColor }}>{statusText}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Trades</span>
              <span className="text-xs" style={{ color: C.textFaint }}>
                ({sortedTrades.length}{sortedTrades.length !== a.tradesList.length ? ` of ${a.tradesList.length}` : ""})
                {a.avgR != null && (
                  <> · avg <span style={{ color: a.avgR >= 0 ? C.emerald : C.rose, fontFamily: "'JetBrains Mono', monospace" }}>{a.avgR >= 0 ? "+" : ""}{a.avgR}R</span> over {a.rCount} with a stop</>
                )}
              </span>
              {hasCandleData && (
                <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: C.amber, background: C.amberDim }}>S1 active</span>
              )}
            </div>
            {/* Filter bar */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <Filter size={12} style={{ color: C.textFaint }} />
              <select value={tradeFilter.symbol} onChange={(e) => setTradeFilter((p) => ({ ...p, symbol: e.target.value }))} className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}` }}>
                <option value="">All symbols</option>
                {a.symbolStats.map((s) => <option key={s.symbol} value={s.symbol}>{s.symbol}</option>)}
              </select>
              <select value={tradeFilter.side} onChange={(e) => setTradeFilter((p) => ({ ...p, side: e.target.value }))} className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}` }}>
                <option value="">All sides</option>
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
              {hasCandleData && (
                <select value={tradeFilter.structure} onChange={(e) => setTradeFilter((p) => ({ ...p, structure: e.target.value }))} className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}` }}>
                  <option value="">All structure</option>
                  <option value="aligned">With structure</option>
                  <option value="counter">Against structure</option>
                  <option value="none">No verdict</option>
                </select>
              )}
              {hasCandleData && (
                <select value={tradeFilter.minConfluence} onChange={(e) => setTradeFilter((p) => ({ ...p, minConfluence: e.target.value }))} className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}` }}>
                  <option value="">Any confluence</option>
                  <option value="1">≥ 1 confluence</option>
                  <option value="2">≥ 2 confluences</option>
                  <option value="3">≥ 3 confluences</option>
                  <option value="4">≥ 4 confluences</option>
                  <option value="5">5 confluences</option>
                </select>
              )}
              {hasCandleData && (
                <select value={tradeFilter.strategyVerdict} onChange={(e) => setTradeFilter((p) => ({ ...p, strategyVerdict: e.target.value }))} className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}` }} title="Filter by a single strategy's verdict">
                  <option value="">Any strategy verdict</option>
                  <optgroup label="S2 — Order Block">
                    <option value="s2:at-ob">At OB zone</option>
                    <option value="s2:near-ob">Near OB</option>
                    <option value="s2:no-ob">No active OB</option>
                  </optgroup>
                  <optgroup label="S3 — Fair Value Gap">
                    <option value="s3:at-fvg">At FVG zone</option>
                    <option value="s3:near-fvg">Near FVG</option>
                    <option value="s3:no-fvg">No active FVG</option>
                  </optgroup>
                  <optgroup label="S4 — Liquidity Sweep">
                    <option value="s4:swept">Sweep before entry</option>
                    <option value="s4:no-sweep">No sweep</option>
                  </optgroup>
                  <optgroup label="S5 — Volume Profile">
                    <option value="s5:at-poc">At POC</option>
                    <option value="s5:in-va">In Value Area</option>
                    <option value="s5:outside-va">Outside Value Area</option>
                  </optgroup>
                </select>
              )}
              {allTags.length > 0 && (
                <select value={tradeFilter.tag} onChange={(e) => setTradeFilter((p) => ({ ...p, tag: e.target.value }))} className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}` }}>
                  <option value="">All tags</option>
                  {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                </select>
              )}
              {(tradeFilter.symbol || tradeFilter.side || tradeFilter.structure || tradeFilter.minConfluence || tradeFilter.tag || tradeFilter.strategyVerdict) && (
                <button onClick={() => setTradeFilter({ symbol: "", side: "", structure: "", minConfluence: "", tag: "", strategyVerdict: "" })} className="text-xs" style={{ color: C.textFaint, background: "transparent", border: "none", cursor: "pointer" }}>Clear</button>
              )}
            </div>
            <div style={{ maxHeight: 460, overflow: "auto" }}>
              <table className="text-sm" style={{ minWidth: hasCandleData ? 980 : 750, width: "100%" }}>
                <thead style={{ position: "sticky", top: 0, background: C.panel, zIndex: 1 }}>
                  <tr style={{ color: C.textFaint }}>
                    {hasCandleData && <th className="text-left pb-2 text-xs" style={{ width: 20 }}></th>}
                    {[
                      { col: "openTime", label: "When", align: "text-left" },
                      { col: "symbol", label: "Symbol", align: "text-left" },
                      { col: "type", label: "Side", align: "text-left" },
                      { col: "durationMin", label: "Hold", align: "text-right" },
                      { col: "profit", label: "P/L", align: "text-right" },
                      { col: "r", label: "R", align: "text-right" },
                    ].map((h) => (
                      <th key={h.col} className={`${h.align} pb-2 text-xs`} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", resize: "horizontal", overflow: "hidden" }} onClick={() => toggleSort(h.col)}>
                        {h.label} {tradeSort.col === h.col ? (tradeSort.dir === "asc" ? "↑" : "↓") : ""}
                      </th>
                    ))}
                    {hasCandleData && (
                      <th className="text-center pb-2 text-xs" style={{ cursor: "pointer", userSelect: "none", resize: "horizontal", overflow: "hidden" }} onClick={() => toggleSort("structure")}>
                        Structure {tradeSort.col === "structure" ? (tradeSort.dir === "asc" ? "↑" : "↓") : ""}
                      </th>
                    )}
                    {hasCandleData && (
                      <th className="text-center pb-2 text-xs" style={{ cursor: "pointer", userSelect: "none", resize: "horizontal", overflow: "hidden" }} onClick={() => toggleSort("confluence")} title="How many setup strategies (S1–S5) aligned at entry">
                        Conv. {tradeSort.col === "confluence" ? (tradeSort.dir === "asc" ? "↑" : "↓") : ""}
                      </th>
                    )}
                    <th className="text-left pb-2 text-xs pl-3" style={{ minWidth: 140, resize: "horizontal", overflow: "hidden" }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTrades.map((t) => {
                    const v = tradeVerdicts[t.ticket];
                    const s1 = v && v.s1;
                    const s6 = v && v.s6;
                    const isExpanded = expandedTrade === t.ticket;
                    const s1Color = !s1 ? C.textFaint
                      : s1.verdict === "aligned" ? C.emerald
                      : s1.verdict === "counter" ? C.rose
                      : s1.verdict === "no-structure" ? C.amber
                      : C.textFaint;
                    const s1Label = !s1 ? "No data"
                      : s1.verdict === "aligned" ? "With"
                      : s1.verdict === "counter" ? "Against"
                      : s1.verdict === "no-structure" ? "No bias"
                      : s1.verdict === "insufficient" ? "Few bars"
                      : "—";
                    const s1Bg = !s1 ? "transparent"
                      : s1.verdict === "aligned" ? C.emeraldDim
                      : s1.verdict === "counter" ? C.roseDim
                      : s1.verdict === "no-structure" ? C.amberDim
                      : "transparent";
                    return (
                      <React.Fragment key={t.ticket}>
                        <tr
                          style={{ borderTop: `0.5px solid ${C.borderSoft}`, cursor: hasCandleData ? "pointer" : undefined }}
                          onClick={() => hasCandleData && setExpandedTrade(isExpanded ? null : t.ticket)}
                        >
                          {hasCandleData && (
                            <td className="py-1.5" style={{ color: C.textFaint, width: 20 }}>
                              {(s1 || s6) ? (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
                            </td>
                          )}
                          <td className="py-1.5" style={{ color: C.textMuted, whiteSpace: "nowrap" }}>{fmtDateTimeShort(t.openTime)}</td>
                          <td className="py-1.5" style={{ color: C.text }}>{t.symbol}</td>
                          <td className="py-1.5" style={{ color: t.type === "buy" ? C.emerald : C.rose }}>{t.type}</td>
                          <td className="py-1.5 text-right" style={{ color: C.textMuted, whiteSpace: "nowrap" }}>{t.durationMin < 1 ? "<1m" : `${Math.round(t.durationMin)}m`}</td>
                          <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: t.profit >= 0 ? C.emerald : C.rose }}>{fmtMoney(t.profit)}</td>
                          <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: t.r == null ? C.textFaint : t.r >= 0 ? C.emerald : C.rose }}>{t.r == null ? "—" : `${t.r >= 0 ? "+" : ""}${t.r}R`}</td>
                          {hasCandleData && (
                            <td className="py-1.5 text-center">
                              <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: s1Color, background: s1Bg }}>{s1Label}</span>
                            </td>
                          )}
                          {hasCandleData && (() => {
                            const conf = v && v.confluence;
                            const score = conf ? conf.score : 0;
                            const cColor = score >= 3 ? C.emerald : score >= 1 ? C.amber : C.textFaint;
                            const cBg = score >= 3 ? C.emeraldDim : score >= 1 ? C.amberDim : "transparent";
                            return (
                              <td className="py-1.5 text-center">
                                <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: cColor, background: cBg, fontFamily: "'JetBrains Mono', monospace" }} title={conf && conf.hits.length ? conf.hits.join(", ") : "no strategies aligned"}>
                                  {score}/{CONFLUENCE_MAX}
                                </span>
                              </td>
                            );
                          })()}
                          <td className="py-1.5 pl-3" onClick={(e) => e.stopPropagation()}>
                            <NoteInput value={t.note} onSave={(note) => saveNote(t.ticket, note)} />
                            {(() => {
                              const tags = parseTags(t.note);
                              if (!tags.length) return null;
                              return (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {tags.map((tag) => (
                                    <button
                                      key={tag}
                                      onClick={() => setTradeFilter((p) => ({ ...p, tag }))}
                                      className="text-xs px-1.5 rounded"
                                      style={{ color: C.amber, background: C.amberDim, border: "none", cursor: "pointer" }}
                                      title={`Filter by ${tag}`}
                                    >
                                      {tag}
                                    </button>
                                  ))}
                                </div>
                              );
                            })()}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={hasCandleData ? 10 : 7} style={{ padding: 0 }}>
                              <div className="px-4 py-3" style={{ background: C.panelAlt, borderLeft: `3px solid ${s1Color}` }}>
                                {v && v.confluence && (
                                  <div className="text-xs mb-2 pb-2" style={{ color: C.text, borderBottom: `0.5px solid ${C.border}` }}>
                                    <span style={{ fontWeight: 500 }}>Confluence: </span>
                                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: v.confluence.score >= 3 ? C.emerald : v.confluence.score >= 1 ? C.amber : C.textFaint }}>
                                      {v.confluence.score}/{CONFLUENCE_MAX}
                                    </span>
                                    {v.confluence.hits.length > 0 && <span style={{ color: C.textFaint }}> · {v.confluence.hits.join(", ")}</span>}
                                  </div>
                                )}
                                {s1 ? (
                                  <>
                                    <div className="text-xs mb-1" style={{ color: C.textMuted, fontWeight: 500 }}>S1 — Market Structure</div>
                                    <div className="text-xs" style={{ color: C.text }}>{s1.detail}</div>
                                    {s1.bias && (
                                      <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                                        Active bias at entry: <span style={{ color: s1.bias === "bullish" ? C.emerald : C.rose }}>{s1.bias}</span>
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <div className="text-xs" style={{ color: C.textFaint }}>No candle data available for {t.symbol} — upload candles via the Candles button to get a structure verdict.</div>
                                )}
                                {v && v.s2 && (
                                  <div className="mt-2">
                                    <div className="text-xs mb-1" style={{ color: C.textMuted, fontWeight: 500 }}>S2 — Order Block</div>
                                    <div className="text-xs" style={{ color: v.s2.atOB ? C.emerald : C.text }}>{v.s2.detail}</div>
                                    {v.s2.obZone && (
                                      <div className="text-xs mt-0.5" style={{ color: C.textFaint }}>
                                        OB zone: <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{v.s2.obZone.low.toFixed(2)} – {v.s2.obZone.high.toFixed(2)}</span>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {v && v.s3 && (
                                  <div className="mt-2">
                                    <div className="text-xs mb-1" style={{ color: C.textMuted, fontWeight: 500 }}>S3 — Fair Value Gap</div>
                                    <div className="text-xs" style={{ color: v.s3.atFVG ? C.emerald : C.text }}>{v.s3.detail}</div>
                                    {v.s3.fvgZone && (
                                      <div className="text-xs mt-0.5" style={{ color: C.textFaint }}>
                                        FVG zone: <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{v.s3.fvgZone.low.toFixed(2)} – {v.s3.fvgZone.high.toFixed(2)}</span>
                                        {v.s3.strength && <> · <span style={{ color: v.s3.strength === "strong" ? C.emerald : v.s3.strength === "weak" ? C.rose : C.amber }}>{v.s3.strength}</span></>}
                                      </div>
                                    )}
                                  </div>
                                )}
                                {v && v.s4 && (
                                  <div className="mt-2">
                                    <div className="text-xs mb-1" style={{ color: C.textMuted, fontWeight: 500 }}>S4 — Liquidity Sweep</div>
                                    <div className="text-xs" style={{ color: v.s4.swept ? C.emerald : C.text }}>{v.s4.detail}</div>
                                  </div>
                                )}
                                {v && v.s5 && v.s5.verdict !== "insufficient" && (
                                  <div className="mt-2">
                                    <div className="text-xs mb-1" style={{ color: C.textMuted, fontWeight: 500 }}>S5 — Volume Profile</div>
                                    <div className="text-xs" style={{ color: v.s5.zone === "poc" ? C.emerald : v.s5.zone === "value-area" ? C.amber : C.text }}>{v.s5.detail}</div>
                                  </div>
                                )}
                                {s6 && s6.session && (
                                  <div className="text-xs mt-2" style={{ color: C.textFaint }}>
                                    S6 — Session: <span style={{ color: C.amber }}>{s6.session}</span>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-xs mt-3" style={{ color: C.textFaint }}>
              Click column headers to sort. R = profit ÷ risk. Structure: <span style={{ color: C.emerald }}>With</span> = aligned with BOS/CHoCH, <span style={{ color: C.rose }}>Against</span> = counter-trend, <span style={{ color: C.amber }}>No bias</span> = no confirmed structure yet, <span style={{ color: C.textFaint }}>Few bars</span> = insufficient candle history.
              {" "}Type <span style={{ color: C.amber }}>#tags</span> in any note (e.g. "#fomo #scalp") to tag a trade — tags become clickable filters.
            </div>
          </div>

          <div className="rounded-xl p-4 mb-2" style={{ border: `0.5px solid ${C.border}` }}>
            <div className="text-xs leading-relaxed" style={{ color: C.textFaint }}>
              Calm = under {settings.overtradeThreshold} trades that day. Busy = {settings.overtradeThreshold}+ trades. Tilt = at least {settings.tiltStreakMin} losses
              in a row on the same day.
            </div>
          </div>
        </>
      )}

      {/* ── Strategy tab ───────────────────────────────────────────── */}
      {activeTab === "strategy" && (
        <>
          <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${hasCandleData ? C.amberDim : C.border}` }}>
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 size={15} style={{ color: C.amber }} />
              <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Strategy overlay — candle data</span>
            </div>
            {hasCandleData ? (
              <>
                <div className="flex flex-wrap gap-2 mb-2">
                  {Object.entries(candleIndex).map(([key, ci]) => (
                    <span key={key} className="text-xs px-2 py-1 rounded" style={{ background: C.panelAlt, color: C.text, border: `0.5px solid ${C.border}` }}>
                      {ci.symbol} {ci.timeframe} — {ci.count.toLocaleString()} bars
                    </span>
                  ))}
                </div>
                <div className="text-xs" style={{ color: C.textFaint }}>
                  S1 (market structure) verdicts are active in the Trades tab. Click any row to expand the verdict. Strategies are computed as a causal forward pass — each bar only sees prior data, no repainting.
                </div>
              </>
            ) : (
              <div className="text-xs" style={{ color: C.textFaint }}>
                Upload candle CSVs (MT5 chart export) via the <span style={{ color: C.amber }}>Candles</span> button to enable strategy verdicts. In MT5: open the chart → right-click → Save As CSV, or use View → Symbols → Bars/History. Start with your primary symbol (GOLD) on M5.
              </div>
            )}
          </div>

          {/* Confluence breakdown — the headline payoff of all 6 strategies */}
          {strategyImpact && hasCandleData && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.amberDim}` }}>
              <div className="flex items-center gap-2 mb-3">
                <Target size={15} style={{ color: C.amber }} />
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Confluence — does stacking setups pay off?</span>
              </div>
              {(() => {
                const hi = strategyImpact.confluence.high;
                const lo = strategyImpact.confluence.low;
                if (hi.n === 0 && lo.n === 0) return null;
                return (
                  <div className="text-sm mb-3 px-3 py-2 rounded-lg" style={{ background: C.panelAlt, color: C.text }}>
                    Trades with <span style={{ color: C.emerald, fontWeight: 500 }}>≥3 confluences</span>: {hi.winRate}% win · <span style={{ fontFamily: "'JetBrains Mono', monospace", color: hi.pl >= 0 ? C.emerald : C.rose }}>{fmtMoney(hi.pl)}</span> over {hi.n} trades
                    {"  vs  "}
                    <span style={{ color: C.rose, fontWeight: 500 }}>≤1</span>: {lo.winRate}% win · <span style={{ fontFamily: "'JetBrains Mono', monospace", color: lo.pl >= 0 ? C.emerald : C.rose }}>{fmtMoney(lo.pl)}</span> over {lo.n} trades.
                  </div>
                );
              })()}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {Array.from({ length: CONFLUENCE_MAX + 1 }, (_, sc) => {
                  const d = strategyImpact.confluence.byScore[sc] || { n: 0, pl: 0, winRate: 0 };
                  const color = sc >= 3 ? C.emerald : sc >= 1 ? C.amber : C.textFaint;
                  return (
                    <div key={sc} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}`, opacity: d.n > 0 ? 1 : 0.45 }}>
                      <div className="text-xs mb-1" style={{ color }}>{sc}/{CONFLUENCE_MAX} confl.</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 500, color: d.pl >= 0 ? C.emerald : C.rose }}>
                        {d.n > 0 ? fmtMoney(d.pl) : "—"}
                      </div>
                      <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                        {d.n} trades{d.n > 0 ? ` · ${d.winRate}%` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-xs mt-3" style={{ color: C.textFaint }}>
                Confluence = how many of the 5 setup strategies fired supportively at entry: S1 aligned, S2 at an order block, S3 at an FVG, S4 a liquidity sweep, S5 at POC/in value area. (S6 session is context, not counted.) Only trades with candle data are included. If higher confluence shows a higher win rate, stacking setups is adding edge.
              </div>
            </div>
          )}

          {/* Setup scan — setups you took vs skipped */}
          {setupScan && setupScan.total > 0 && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.amberDim}` }}>
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 size={15} style={{ color: C.amber }} />
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Setup scan — did you take the setups your rules found?</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                <div className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                  <div className="text-xs mb-1" style={{ color: C.textMuted }}>Setups found</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: C.text }}>{setupScan.total}</div>
                  <div className="text-xs mt-1" style={{ color: C.textFaint }}>≥3-confluence, across all candles</div>
                </div>
                <div className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                  <div className="text-xs mb-1" style={{ color: C.emerald }}>Taken</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: C.emerald }}>{setupScan.takenCount}</div>
                  <div className="text-xs mt-1" style={{ color: C.textFaint }}>{setupScan.takenPct}% of setups · {setupScan.takenAvgMfeR != null ? `${setupScan.takenAvgMfeR}R avg reach` : "—"}</div>
                </div>
                <div className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                  <div className="text-xs mb-1" style={{ color: C.rose }}>Skipped</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: C.rose }}>{setupScan.skippedCount}</div>
                  <div className="text-xs mt-1" style={{ color: C.textFaint }}>setups you didn't trade</div>
                </div>
                <div className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                  <div className="text-xs mb-1" style={{ color: C.amber }}>Skipped — hypothetical reach</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: C.amber }}>{setupScan.skippedAvgMfeR != null ? `${setupScan.skippedAvgMfeR}R` : "—"}</div>
                  <div className="text-xs mt-1" style={{ color: C.textFaint }}>avg max favourable move {setupScan.skippedAvgMaeR != null ? `· ${setupScan.skippedAvgMaeR}R adverse` : ""}</div>
                </div>
              </div>

              {setupScan.skipped.length > 0 && (
                <div style={{ maxHeight: 300, overflow: "auto" }}>
                  <table className="text-sm" style={{ minWidth: 560, width: "100%" }}>
                    <thead style={{ position: "sticky", top: 0, background: C.panel, zIndex: 1 }}>
                      <tr style={{ color: C.textFaint }}>
                        <th className="text-left pb-2 text-xs">When (skipped)</th>
                        <th className="text-left pb-2 text-xs">Symbol</th>
                        <th className="text-left pb-2 text-xs">Side</th>
                        <th className="text-left pb-2 text-xs">Confluence</th>
                        <th className="text-right pb-2 text-xs">Hyp. reach</th>
                        <th className="text-right pb-2 text-xs">Hyp. adverse</th>
                      </tr>
                    </thead>
                    <tbody>
                      {setupScan.skipped.slice(0, 100).map((s, i) => (
                        <tr key={i} style={{ borderTop: `0.5px solid ${C.borderSoft}` }}>
                          <td className="py-1.5" style={{ color: C.textMuted, whiteSpace: "nowrap" }}>{fmtDateTimeShort(s.time)}</td>
                          <td className="py-1.5" style={{ color: C.text }}>{s.symbol}</td>
                          <td className="py-1.5" style={{ color: s.side === "buy" ? C.emerald : C.rose }}>{s.side}</td>
                          <td className="py-1.5 text-xs" style={{ color: C.textMuted }}>{s.score}/4 · {s.hits.join(", ")}</td>
                          <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: C.amber }}>{s.mfeR != null ? `${s.mfeR.toFixed(2)}R` : "—"}</td>
                          <td className="py-1.5 text-right" style={{ fontFamily: "'JetBrains Mono', monospace", color: C.textFaint }}>{s.maeR != null ? `${s.maeR.toFixed(2)}R` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="text-xs mt-3" style={{ color: C.textFaint }}>
                A "setup" = the rules found ≥3 confluences (structure + an OB/FVG zone, often a sweep) in the prevailing direction. "Taken" = you opened a same-side trade within 15 min of it. <span style={{ color: C.amber }}>Hypothetical reach</span> is the max favourable move over the next 24 bars vs a recent-swing stop — <strong>not</strong> a backtest of real entries/exits, just how far price travelled after each setup. Treat it as a discipline mirror (did I act on my own setups?), not a P/L claim.
              </div>
            </div>
          )}

          {/* S1 Impact breakdown */}
          {strategyImpact && hasCandleData && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-mono" style={{ color: C.emerald }}>S1</span>
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Market Structure — Impact</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
                {[
                  { label: "With structure", data: strategyImpact.s1.aligned, color: C.emerald, bg: C.emeraldDim },
                  { label: "Against structure", data: strategyImpact.s1.counter, color: C.rose, bg: C.roseDim },
                  { label: "No bias established", data: strategyImpact.s1.noStructure, color: C.amber, bg: C.amberDim },
                  { label: "Insufficient bars", data: strategyImpact.s1.insufficient, color: C.textFaint, bg: "transparent" },
                  { label: "No candle data", data: strategyImpact.s1.noCandles, color: C.textFaint, bg: "transparent" },
                ].map((g) => (
                  <div key={g.label} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                    <div className="text-xs mb-1" style={{ color: g.color }}>{g.label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: g.data.pl >= 0 ? C.emerald : C.rose }}>
                      {fmtMoney(g.data.pl)}
                    </div>
                    <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                      {g.data.n} trades · {g.data.winRate}% win
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs" style={{ color: C.textFaint }}>
                "With structure" trades are entries that aligned with the active BOS/CHoCH direction — compare their P/L and win rate against "Against structure" to see whether following market structure paid off. "No bias" means structure hadn't established a direction yet. "Insufficient bars" means fewer than {(settings.swingLookback || 5) * 2 + 1} candles existed before the trade. "No candle data" means no CSV was uploaded for that symbol.
              </div>
            </div>
          )}

          {/* S2 Impact breakdown */}
          {strategyImpact && hasCandleData && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-mono" style={{ color: C.emerald }}>S2</span>
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Order Block — Impact</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { label: "At OB zone", data: strategyImpact.s2.atOB, color: C.emerald },
                  { label: "Near OB (not at)", data: strategyImpact.s2.nearOB, color: C.amber },
                  { label: "No active OB", data: strategyImpact.s2.noOB, color: C.rose },
                  { label: "No data", data: strategyImpact.s2.noData, color: C.textFaint },
                ].map((g) => (
                  <div key={g.label} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                    <div className="text-xs mb-1" style={{ color: g.color }}>{g.label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: g.data.pl >= 0 ? C.emerald : C.rose }}>
                      {fmtMoney(g.data.pl)}
                    </div>
                    <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                      {g.data.n} trades · {g.data.winRate}% win
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs" style={{ color: C.textFaint }}>
                "At OB zone" = entry price was inside an active order block. "Near OB" = OBs existed in the trade direction but entry wasn't inside one. "No active OB" = no unmitigated OB existed in that direction at entry time. Compare to see if entering at OBs produces better results.
              </div>
            </div>
          )}

          {/* S3 Impact breakdown */}
          {strategyImpact && hasCandleData && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-mono" style={{ color: C.emerald }}>S3</span>
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Fair Value Gap — Impact</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { label: "At FVG zone", data: strategyImpact.s3.atFVG, color: C.emerald },
                  { label: "Near FVG (not at)", data: strategyImpact.s3.nearFVG, color: C.amber },
                  { label: "No active FVG", data: strategyImpact.s3.noFVG, color: C.rose },
                  { label: "No data", data: strategyImpact.s3.noData, color: C.textFaint },
                ].map((g) => (
                  <div key={g.label} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                    <div className="text-xs mb-1" style={{ color: g.color }}>{g.label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: g.data.pl >= 0 ? C.emerald : C.rose }}>
                      {fmtMoney(g.data.pl)}
                    </div>
                    <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                      {g.data.n} trades · {g.data.winRate}% win
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs" style={{ color: C.textFaint }}>
                "At FVG zone" = entry price was inside a 3-candle imbalance gap. FVGs are classified as strong ({">"}1.5x ATR), regular, or weak ({"<"}0.3x ATR). Entries at FVG zones target the imbalance fill — compare to see if this confluence adds edge.
              </div>
            </div>
          )}

          {/* S4 Impact breakdown */}
          {strategyImpact && hasCandleData && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-mono" style={{ color: C.emerald }}>S4</span>
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Liquidity Sweep — Impact</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
                {[
                  { label: "Sweep before entry", data: strategyImpact.s4.swept, color: C.emerald },
                  { label: "No sweep", data: strategyImpact.s4.noSweep, color: C.rose },
                  { label: "No data", data: strategyImpact.s4.noData, color: C.textFaint },
                ].map((g) => (
                  <div key={g.label} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                    <div className="text-xs mb-1" style={{ color: g.color }}>{g.label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: g.data.pl >= 0 ? C.emerald : C.rose }}>
                      {fmtMoney(g.data.pl)}
                    </div>
                    <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                      {g.data.n} trades · {g.data.winRate}% win
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs" style={{ color: C.textFaint }}>
                "Sweep before entry" = a wick pierced a prior swing point and closed back inside it within 10 bars before your entry — the classic stop-hunt setup. Compare P/L to see if entries preceded by a sweep outperform.
              </div>
            </div>
          )}

          {/* S5 Impact breakdown */}
          {strategyImpact && hasCandleData && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-mono" style={{ color: C.amber }}>S5</span>
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Volume Profile — Impact</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { label: "At POC", data: strategyImpact.s5.atPoc, color: C.emerald },
                  { label: "In Value Area", data: strategyImpact.s5.inVa, color: C.amber },
                  { label: "Outside Value Area", data: strategyImpact.s5.outsideVa, color: C.rose },
                  { label: "No data", data: strategyImpact.s5.noData, color: C.textFaint },
                ].map((g) => (
                  <div key={g.label} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}` }}>
                    <div className="text-xs mb-1" style={{ color: g.color }}>{g.label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: g.data.pl >= 0 ? C.emerald : C.rose }}>
                      {fmtMoney(g.data.pl)}
                    </div>
                    <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                      {g.data.n} trades · {g.data.winRate}% win
                    </div>
                  </div>
                ))}
              </div>
              <div className="text-xs" style={{ color: C.textFaint }}>
                POC = Point of Control (highest-volume price in the last 200 bars). Value Area = 70% of volume concentrated between VAL and VAH. Entries at POC trade at the fairest price; entries outside the VA are in low-volume territory where price moves faster. Note: uses tick volume as a proxy — an approximation, not real exchange volume.
              </div>
            </div>
          )}

          {/* S6 Impact breakdown */}
          {strategyImpact && Object.keys(strategyImpact.s6).length > 0 && (
            <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-mono" style={{ color: C.amber }}>S6</span>
                <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Session Context — Impact</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {["Asian", "London", "New York", "Off-hours"].map((session) => {
                  const d = strategyImpact.s6[session] || { n: 0, pl: 0, winRate: 0 };
                  return (
                    <div key={session} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}`, opacity: d.n > 0 ? 1 : 0.4 }}>
                      <div className="text-xs mb-1" style={{ color: C.amber }}>{session}</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 500, color: d.pl >= 0 ? C.emerald : C.rose }}>
                        {d.n > 0 ? fmtMoney(d.pl) : "—"}
                      </div>
                      <div className="text-xs mt-1" style={{ color: C.textFaint }}>
                        {d.n} trades{d.n > 0 ? ` · ${d.winRate}% win` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-xs" style={{ color: C.textFaint }}>
                P/L breakdown by trading session. Compare sessions to find which time windows are most profitable for you.
              </div>
            </div>
          )}

          {/* Strategy roadmap */}
          <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
            <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>Strategy roadmap</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[
                { id: "S1", name: "Market Structure", desc: "BOS/CHoCH bias alignment", active: hasCandleData, color: C.emerald },
                { id: "S2", name: "Order Blocks", desc: "Entry at opposing-candle zones", active: hasCandleData, color: C.emerald },
                { id: "S3", name: "Fair Value Gaps", desc: "3-candle imbalance zones", active: hasCandleData, color: C.emerald },
                { id: "S4", name: "Liquidity Sweeps", desc: "Wick-through-swing reversals", active: hasCandleData, color: C.emerald },
                { id: "S5", name: "Volume Profile", desc: "POC / VAH / VAL levels", active: hasCandleData, color: C.amber },
                { id: "S6", name: "Session Context", desc: "Asian / London / New York", active: settings.brokerGmtOffsetHours != null, color: C.amber },
              ].map((s) => (
                <div key={s.id} className="rounded-lg p-3" style={{ background: C.panelAlt, border: `0.5px solid ${C.border}`, opacity: s.active ? 1 : 0.5 }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono" style={{ color: s.active ? s.color : C.textFaint }}>{s.id}</span>
                    <span className="text-sm" style={{ color: s.active ? C.text : C.textMuted }}>{s.name}</span>
                  </div>
                  <div className="text-xs" style={{ color: C.textFaint }}>{s.desc}</div>
                  <div className="text-xs mt-1" style={{ color: s.active ? s.color : C.textFaint }}>
                    {s.active ? "Active" : "Coming soon"}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl p-4 mb-6" style={{ border: `0.5px solid ${C.border}` }}>
            <div className="text-xs leading-relaxed" style={{ color: C.textFaint }}>
              All strategies use a causal forward pass — bar <em>i</em> only sees bars ≤ <em>i</em>, no repainting. Verdicts are a consistent rules-based approximation, not full discretionary chart-reading judgment.
              Files are parsed entirely in your browser; nothing leaves your machine.
            </div>
          </div>
        </>
      )}

      {settingsModal}
    </div>
  );
}
