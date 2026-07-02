import { useState, useEffect, useMemo, useRef } from "react";
import { UploadCloud, RotateCcw, Settings, BarChart3 } from "lucide-react";
import * as XLSX from "xlsx";
import { storage } from "./lib/storage";
import { parseCandleCSV, inferSymbolTimeframe, mergeCandles, candleStorageKey } from "./lib/candleParser";
import { computeTradeVerdicts, precomputeSmcState, scanSetups } from "./lib/smc";
import { round2, round1, fmtMoney } from "./lib/format";
import { DEFAULT_SETTINGS, parseWorkbookRows, confluenceOf, parseTags, CONFLUENCE_MAX, computeAnalytics, summarizePrior } from "./lib/analytics";
import { parseSyncPayload, mergeSync } from "./lib/mt5Sync";
import { C } from "./theme";
import { SettingsModal } from "./components/SettingsModal";
import { DashboardTab } from "./components/DashboardTab";
import { TradesTab } from "./components/TradesTab";
import { StrategyTab } from "./components/StrategyTab";

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

  // Merge a raw MT5 sync payload (latest.json text) into storage. Shared by the
  // "Sync from MT5" folder flow and the manual Import (for non-Chromium browsers).
  // Returns the merge stats; throws Error with a user-facing message on failure.
  function handleMt5Sync(jsonText) {
    const payload = parseSyncPayload(jsonText); // throws on a bad/unknown file
    const res = mergeSync(
      { positions, balanceOps, candleIndex, accountMeta, getCandles: (sym, tf) => storage.get(candleStorageKey(sym, tf)) },
      payload
    );
    const now = new Date().toISOString();
    // Persist, quota-checked like handleFiles — candles are the big writes.
    let ok =
      storage.set("tj_positions", res.positions) &&
      storage.set("tj_balance_ops", res.balanceOps) &&
      (!res.accountMeta || storage.set("tj_account_meta", res.accountMeta));
    for (const u of res.candleUpdates) ok = storage.set(u.key, u.candles) && ok;
    ok = storage.set("tj_candle_index", res.candleIndex) && ok;
    storage.set("tj_last_updated", now);
    loadStateFromStorage();
    if (!ok) {
      setUploadError("Storage is full — some synced data wasn't saved. Export a backup and clear old candle data from Settings.");
      throw new Error("Storage is full — some synced data wasn't saved.");
    }
    setUploadError(null);
    setUploadNotice(
      `Synced from MT5 · ${res.stats.positions} trades · ${res.stats.balanceOps} balance ops · ${res.stats.candleGroups} candle set${res.stats.candleGroups === 1 ? "" : "s"}${res.stats.skipped ? ` · ${res.stats.skipped} row${res.stats.skipped === 1 ? "" : "s"} skipped` : ""}.`
    );
    return res.stats;
  }

  async function importData(file) {
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setUploadError("That file isn't valid JSON.");
      return;
    }
    // An MT5 sync export (latest.json) goes through the sync merge, not the backup path.
    if (parsed && parsed.kind === "mt5-sync") {
      try {
        handleMt5Sync(parsed);
        setShowSettings(false);
      } catch (e) {
        setUploadError(e.message || "Could not import that MT5 sync file.");
      }
      return;
    }
    // Otherwise treat it as a tj_ localStorage backup.
    try {
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
      setUploadError("Could not import that file — make sure it's a JSON backup or MT5 sync file from this app.");
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
      onMt5Sync={handleMt5Sync}
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

  // Arrow-key navigation for the tablist (WAI-ARIA tabs pattern): Left/Right
  // cycle, Home/End jump to ends, moving both selection and DOM focus.
  const onTabKeyDown = (e) => {
    const deltas = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
    if (!(e.key in deltas)) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === activeTab);
    const next =
      e.key === "Home" ? 0 :
      e.key === "End" ? TABS.length - 1 :
      (i + deltas[e.key] + TABS.length) % TABS.length;
    setActiveTab(TABS[next].id);
    e.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  };

  const tabBar = (
    <div
      role="tablist"
      aria-label="Journal views"
      onKeyDown={onTabKeyDown}
      className="flex gap-1 mb-6 rounded-lg p-1"
      style={{ background: C.panel, border: `0.5px solid ${C.border}` }}
    >
      {TABS.map((tab) => {
        const selected = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            className="flex-1 text-sm py-2 rounded-md"
            style={{
              background: selected ? C.panelAlt : "transparent",
              color: selected ? C.text : C.textMuted,
              border: selected ? `0.5px solid ${C.border}` : "0.5px solid transparent",
              fontWeight: selected ? 600 : 400,
              fontFamily: "'Space Grotesk', sans-serif",
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        );
      })}
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
        <div role="tabpanel" id="panel-dashboard" aria-labelledby="tab-dashboard">
          <DashboardTab
            a={a}
            settings={settings}
            filteredDaily={filteredDaily}
            chartRange={chartRange}
            setChartRange={setChartRange}
            setRange={setRange}
            priorSection={priorSection}
          />
        </div>
      )}

      {/* ── Trades tab ─────────────────────────────────────────────── */}
      {activeTab === "trades" && (
        <div role="tabpanel" id="panel-trades" aria-labelledby="tab-trades">
          <TradesTab
            a={a}
            settings={settings}
            sortedDaily={sortedDaily}
            dailySort={dailySort}
            toggleDailySort={toggleDailySort}
            sortedTrades={sortedTrades}
            tradeSort={tradeSort}
            toggleSort={toggleSort}
            tradeFilter={tradeFilter}
            setTradeFilter={setTradeFilter}
            allTags={allTags}
            hasCandleData={hasCandleData}
            tradeVerdicts={tradeVerdicts}
            expandedTrade={expandedTrade}
            setExpandedTrade={setExpandedTrade}
            saveNote={saveNote}
          />
        </div>
      )}

      {/* ── Strategy tab ───────────────────────────────────────────── */}
      {activeTab === "strategy" && (
        <div role="tabpanel" id="panel-strategy" aria-labelledby="tab-strategy">
          <StrategyTab
            candleIndex={candleIndex}
            hasCandleData={hasCandleData}
            strategyImpact={strategyImpact}
            setupScan={setupScan}
            settings={settings}
          />
        </div>
      )}

      {settingsModal}
    </div>
  );
}
