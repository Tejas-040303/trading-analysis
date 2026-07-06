// Pure parsing, settings, analytics, and confluence/tag logic — extracted from
// App.jsx so it can be unit-tested in isolation (no React/recharts). This is the
// numeric core of the app; the Vitest suite in App.test.js is its regression net.
import { round1, round2, fmtDateLabel } from "./format.js";

// User-editable settings, persisted to tj_settings via the Settings panel.
export const DEFAULT_SETTINGS = {
  overtradeThreshold: 15,     // trades/day at or above which a day is flagged "Busy"
  tiltStreakMin: 3,           // consecutive losses that make a tilt cluster
  revengeWindowMin: 3,        // minutes: a same-symbol re-entry after a loss within this is "revenge"
  brokerGmtOffsetHours: null, // reserved for the upcoming session view (Asian/London/NY)
  seriousStart: "2026-05-28", // YYYY-MM-DD; trades before this are archived as the beginner era
  swingLookback: 5,           // fractal pivot lookback for SMC swing detection
  telegramBotToken: "",       // P8.4: BotFather token — signal alerts are skipped while empty
  telegramChatId: "",         // P8.4: your chat id with the bot
};

// Single source of truth for which calendar day a trade belongs to. Uses the
// Date's LOCAL components, which reproduce the original MT5 server wall-clock
// (parseMT5DateTime built the Date from those wall-clock numbers). Never use
// toISOString()/UTC for bucketing — that silently shifts near-midnight trades
// onto the wrong day, and disagreed with the day-of-week chart (which uses
// Date.getDay(), also local). Both now derive from the same local wall-clock.
export function tradeDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseMT5DateTime(value) {
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

export const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
};

export const cleanSymbol = (s) => String(s || "").replace("#", "").replace(".i", "");

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

// Confluence score: how many setup strategies "fired" supportively at entry.
// S6 (session) is context, not a setup signal, so it's excluded — max score 5.
// The "supportive" verdict per strategy is a judgment call, surfaced in UI copy.
export const CONFLUENCE_RULES = [
  { key: "s1", id: "S1", ok: (s) => s.verdict === "aligned" },
  { key: "s2", id: "S2", ok: (s) => s.verdict === "at-ob" },
  { key: "s3", id: "S3", ok: (s) => s.verdict === "at-fvg" },
  { key: "s4", id: "S4", ok: (s) => s.verdict === "swept" },
  { key: "s5", id: "S5", ok: (s) => s.verdict === "at-poc" || s.verdict === "in-va" },
];
export const CONFLUENCE_MAX = CONFLUENCE_RULES.length;

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

// Extract #hashtags from a free-text note. Reuses the existing note field, so
// tags need no new storage or migration — type "#fomo revenge entry" and it's tagged.
export function parseTags(note) {
  const m = (note || "").match(/#[\w-]+/g);
  if (!m) return [];
  return [...new Set(m.map((t) => t.toLowerCase()))];
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
