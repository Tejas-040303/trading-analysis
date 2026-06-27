import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  UploadCloud, RotateCcw, AlertTriangle, TrendingUp, TrendingDown,
  CircleCheck, Flame, Wallet, Target, Percent, Calendar,
} from "lucide-react";
import * as XLSX from "xlsx";
import { storage } from "./lib/storage";

const OVERTRADE_THRESHOLD = 15;
const REVENGE_WINDOW_MIN = 3;
const TILT_STREAK_MIN = 3;

// Only trades on/after this date count toward the main analysis. Earlier trades
// (TJ's beginner era — the ~$55 January account that was blown while learning)
// are summarized separately, not mixed into the serious-trading stats.
// TODO(Phase 2 Settings): make this an editable "serious start date" setting.
const SERIOUS_START = new Date(2026, 4, 28, 0, 0, 0); // May 28, 2026, local time
const SERIOUS_START_LABEL = "May 28, 2026";

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

function parseWorkbookRows(rows) {
  const idxPositions = rows.findIndex((r) => r[0] === "Positions");
  const idxOrders = rows.findIndex((r) => r[0] === "Orders");
  const idxDeals = rows.findIndex((r) => r[0] === "Deals");

  const positions = [];
  if (idxPositions !== -1) {
    const dataStart = idxPositions + 2;
    const dataEnd = idxOrders !== -1 ? idxOrders : rows.length;
    for (let i = dataStart; i < dataEnd; i++) {
      const r = rows[i];
      if (!r || r[1] == null) continue;
      const openTime = parseMT5DateTime(r[0]);
      const closeTime = parseMT5DateTime(r[8]);
      if (!openTime || !closeTime) continue;
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
  return { positions, balanceOps, meta };
}

function computeAnalytics(rawPositions, rawBalanceOps) {
  if (!rawPositions.length) return null;
  const pos = rawPositions
    .map((p) => {
      const openTime = new Date(p.openTime);
      const closeTime = new Date(p.closeTime);
      return { ...p, openTime, closeTime, durationMin: (closeTime - openTime) / 60000 };
    })
    .sort((a, b) => a.openTime - b.openTime);

  const dateKey = (d) => d.toISOString().slice(0, 10);
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
      if (streak.length >= TILT_STREAK_MIN) {
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
      if (prev.profit < 0 && gap <= REVENGE_WINDOW_MIN && gap >= 0 && p.symbol === prev.symbol) {
        revengeCount++;
        revengePl += p.profit;
      }
    }
    prev = p;
  });

  const dailyStats = Array.from(dailyMap.entries())
    .map(([date, trades]) => {
      const profit = trades.reduce((s, t) => s + t.profit, 0);
      const wins = trades.filter((t) => t.profit > 0).length;
      return {
        date,
        trades: trades.length,
        profit: round2(profit),
        winRate: round1((wins / trades.length) * 100),
        overtrading: trades.length >= OVERTRADE_THRESHOLD,
        hasTiltCluster: tiltDates.has(date),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  let cum = 0;
  dailyStats.forEach((d) => {
    cum += d.profit;
    d.cumProfit = round2(cum);
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
  let currentBalance = bops.length ? bops[bops.length - 1].balance : null;
  // Phase 1 "balance drawdown (approximate)" — walks only balance-type rows, so
  // this is balance-curve drawdown, not intra-trade equity drawdown (spec §6).
  let maxDrawdownPct = 0;
  if (bops.length) {
    let peak = -Infinity;
    bops.forEach((b) => {
      if (b.balance != null) {
        if (b.balance > peak) peak = b.balance;
        if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - b.balance) / peak) * 100);
      }
    });
  }
  const roiPct = depositsTotal > 0 ? (netProfit / depositsTotal) * 100 : null;

  return {
    totalTrades: pos.length,
    winRate: round1((wins.length / pos.length) * 100),
    netProfit: round2(netProfit),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    profitFactor: grossLoss !== 0 ? round2(Math.abs(grossProfit / grossLoss)) : null,
    largestWin: pos.length ? round2(Math.max(...pos.map((p) => p.profit))) : 0,
    largestLoss: pos.length ? round2(Math.min(...pos.map((p) => p.profit))) : 0,
    currentBalance: currentBalance != null ? round2(currentBalance) : null,
    maxDrawdownPct: round1(maxDrawdownPct),
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
    symbolStats,
    tiltClusters: tiltClusters.sort((a, b) => new Date(b.start) - new Date(a.start)),
    revengeCount,
    revengePl: round2(revengePl),
    balanceOps: balanceOpsList,
    depositsSum,
    withdrawalsSum,
    transferOutSum,
    transferInSum,
    netCapital: round2(depositsSum + withdrawalsSum),
  };
}

function summarizePrior(priorPositions, priorBalanceOps) {
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

export default function TradingJournal() {
  const [positions, setPositions] = useState([]);
  const [balanceOps, setBalanceOps] = useState([]);
  const [accountMeta, setAccountMeta] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (document.getElementById("tj-fonts")) return;
    const link = document.createElement("link");
    link.id = "tj-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=JetBrains+Mono:wght@400;500;600&display=swap";
    document.head.appendChild(link);
  }, []);

  useEffect(() => {
    // Load persisted data from localStorage (replaces the prototype's window.storage).
    let pos = [], bal = [], meta = null, lu = null;
    try { const r = storage.get("tj_positions"); if (r) pos = r; } catch (e) {}
    try { const r = storage.get("tj_balance_ops"); if (r) bal = r; } catch (e) {}
    try { const r = storage.get("tj_account_meta"); if (r) meta = r; } catch (e) {}
    try { const r = storage.get("tj_last_updated"); if (r) lu = r; } catch (e) {}
    setPositions(pos); setBalanceOps(bal); setAccountMeta(meta); setLastUpdated(lu);
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
    const posMap = new Map(positions.map((p) => [p.ticket, p]));
    const balMap = new Map(balanceOps.map((b) => [b.dealId, b]));
    let newMeta = accountMeta;
    const failed = [];
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
    try {
      storage.set("tj_positions", mergedPositions);
      storage.set("tj_balance_ops", mergedBalanceOps);
      if (newMeta) storage.set("tj_account_meta", newMeta);
      storage.set("tj_last_updated", now);
    } catch (e) {}
    if (failed.length) {
      setUploadError(`Could not read: ${failed.join(", ")}. Make sure these are MT5 Trade History Report exports.`);
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
    } catch (e) {}
  }

  const { analytics, prior } = useMemo(() => {
    const cutoff = SERIOUS_START.getTime();
    const mainPos = positions.filter((p) => new Date(p.openTime).getTime() >= cutoff);
    const priorPos = positions.filter((p) => new Date(p.openTime).getTime() < cutoff);
    const mainBal = balanceOps.filter((b) => new Date(b.time).getTime() >= cutoff);
    const priorBal = balanceOps.filter((b) => new Date(b.time).getTime() < cutoff);
    return {
      analytics: computeAnalytics(mainPos, mainBal),
      prior: summarizePrior(priorPos, priorBal),
    };
  }, [positions, balanceOps]);

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
        <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Before {SERIOUS_START_LABEL} — beginner era</span>
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
            No trades on or after {SERIOUS_START_LABEL} in your uploaded data yet — upload reports from {SERIOUS_START_LABEL} onward to populate the dashboard. Your earlier history is shown below.
          </div>
        )}
        {prior ? priorSection : dropzone}
        {uploadError && <div className="text-sm mt-3" style={{ color: C.rose }}>{uploadError}</div>}
      </div>
    );
  }

  const a = analytics;

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: 480 }} className="rounded-2xl p-6 md:p-8">
      {headerNode}

      <div className="text-xs mb-4" style={{ color: C.textFaint }}>
        Showing {a.totalTrades} trades since {SERIOUS_START_LABEL}.{prior ? " Your earlier beginner-era history is archived at the bottom." : ""}
      </div>

      {uploadError && (
        <div className="text-sm mb-4 px-3 py-2 rounded-lg" style={{ color: C.rose, background: C.roseDim }}>{uploadError}</div>
      )}
      {processing && (
        <div className="text-sm mb-4" style={{ color: C.amber }}>Processing new upload…</div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard icon={TrendingUp} label="Net trading P/L" value={fmtMoney(a.netProfit)} tone={a.netProfit >= 0 ? "good" : "bad"} sub={`${a.totalTrades} trades`} />
        <StatCard icon={Target} label="Win rate" value={fmtPct(a.winRate)} sub={`PF ${a.profitFactor ?? "—"}`} />
        <StatCard icon={Wallet} label="Current balance" value={fmtMoney(a.currentBalance)} sub={`ROI ${fmtPct(a.roiPct)}`} />
        <StatCard icon={AlertTriangle} label="Balance drawdown" value={fmtPct(a.maxDrawdownPct)} tone={a.maxDrawdownPct > 50 ? "bad" : undefined} sub={`${a.daysTracked} active days`} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Calendar} label="Gross profit" value={fmtMoney(a.grossProfit)} tone="good" />
        <StatCard icon={Calendar} label="Gross loss" value={fmtMoney(a.grossLoss)} tone="bad" />
        <StatCard icon={Percent} label="Largest win" value={fmtMoney(a.largestWin)} tone="good" />
        <StatCard icon={Percent} label="Largest loss" value={fmtMoney(a.largestLoss)} tone="bad" />
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

      <div className="mb-4">
        <ChartCard title="Daily P/L and cumulative trading profit" height={260}>
          <ComposedChart data={a.dailyStats} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.borderSoft} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis yAxisId="left" {...axisProps} tickFormatter={(v) => (v < 0 ? "-$" : "$") + Math.abs(v)} width={50} />
            <YAxis yAxisId="right" orientation="right" {...axisProps} tickFormatter={(v) => (v < 0 ? "-$" : "$") + Math.abs(v)} width={50} />
            <Tooltip {...tooltipStyle} formatter={(v, name) => [fmtMoney(v), name]} />
            <Bar yAxisId="left" dataKey="profit" name="Daily P/L" radius={[3, 3, 0, 0]}>
              {a.dailyStats.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.profit >= 0 ? C.emerald : C.rose}
                  stroke={d.hasTiltCluster ? C.amber : "transparent"}
                  strokeWidth={d.hasTiltCluster ? 2 : 0}
                />
              ))}
            </Bar>
            <Line yAxisId="right" type="monotone" dataKey="cumProfit" name="Cumulative" stroke={C.amber} strokeWidth={2} dot={{ r: 2, fill: C.amber }} />
          </ComposedChart>
        </ChartCard>
        <div className="text-xs mt-2" style={{ color: C.textFaint }}>
          Amber outline = a same-day tilt cluster (3+ losses in a row) happened that day.
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
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMoney(v)} />
            <Bar dataKey="profit" radius={[3, 3, 0, 0]}>
              {a.dowStats.map((d, i) => (
                <Cell key={i} fill={d.profit >= 0 ? C.emerald : C.rose} />
              ))}
            </Bar>
          </BarChart>
        </ChartCard>
      </div>

      <div className="rounded-xl p-4 mb-6" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
        <div className="flex items-center gap-2 mb-3">
          <Flame size={15} style={{ color: C.amber }} />
          <span className="text-sm" style={{ color: C.textMuted, fontWeight: 500 }}>Tilt clusters detected</span>
          <span className="text-xs" style={{ color: C.textFaint }}>(3+ same-day losses in a row, plus quick same-symbol re-entries)</span>
        </div>
        {a.revengeCount > 0 && (
          <div className="text-xs mb-3" style={{ color: C.textFaint }}>
            Also: {a.revengeCount} re-entries within {REVENGE_WINDOW_MIN} min of a loss on the same symbol, net {fmtMoney(a.revengePl)}.
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
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: C.textFaint }}>
                <th className="text-left pb-2 text-xs">Symbol</th>
                <th className="text-right pb-2 text-xs">N</th>
                <th className="text-right pb-2 text-xs">Win%</th>
                <th className="text-right pb-2 text-xs">P/L</th>
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

        <div className="rounded-xl p-4 lg:col-span-2" style={{ background: C.panel, border: `0.5px solid ${C.border}` }}>
          <div className="text-sm mb-3" style={{ color: C.textMuted, fontWeight: 500 }}>Daily breakdown</div>
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            <table className="w-full text-sm">
              <thead style={{ position: "sticky", top: 0, background: C.panel }}>
                <tr style={{ color: C.textFaint }}>
                  <th className="text-left pb-2 text-xs">Date</th>
                  <th className="text-right pb-2 text-xs">Trades</th>
                  <th className="text-right pb-2 text-xs">Win%</th>
                  <th className="text-right pb-2 text-xs">P/L</th>
                  <th className="text-right pb-2 text-xs">Status</th>
                </tr>
              </thead>
              <tbody>
                {a.dailyStats.slice().reverse().map((d) => {
                  const stripe = d.hasTiltCluster ? C.rose : d.overtrading ? C.amber : C.emerald;
                  const statusText = d.hasTiltCluster ? "Tilt" : d.overtrading ? "Busy" : "Calm";
                  const statusColor = d.hasTiltCluster ? C.rose : d.overtrading ? C.amber : C.emerald;
                  return (
                    <tr key={d.date} style={{ borderTop: `0.5px solid ${C.borderSoft}` }}>
                      <td className="py-1.5" style={{ color: C.text, borderLeft: `3px solid ${stripe}`, paddingLeft: 8 }}>{fmtDateLabel(d.date)}</td>
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

      <div className="rounded-xl p-4 mb-2" style={{ border: `0.5px solid ${C.border}` }}>
        <div className="text-xs leading-relaxed" style={{ color: C.textFaint }}>
          Calm = under {OVERTRADE_THRESHOLD} trades that day. Busy = {OVERTRADE_THRESHOLD}+ trades. Tilt = at least {TILT_STREAK_MIN} losses
          in a row on the same day. Files are parsed entirely in your browser; the computed numbers are saved so this dashboard
          remembers your history the next time you open it. Upload new reports anytime — duplicate trades are matched and skipped
          by their MT5 ticket ID, so it's safe to re-upload the full history or just a recent slice.
        </div>
      </div>

      {priorSection}
    </div>
  );
}
