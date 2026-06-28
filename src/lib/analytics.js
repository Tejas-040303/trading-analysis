// Pure parsing + settings + confluence/tag logic, extracted from App.jsx so it
// can be unit-tested in isolation (no React/recharts). computeAnalytics and
// summarizePrior still live in App.jsx for now and will move here next, under
// the same test coverage.

// User-editable settings, persisted to tj_settings via the Settings panel.
export const DEFAULT_SETTINGS = {
  overtradeThreshold: 15,     // trades/day at or above which a day is flagged "Busy"
  tiltStreakMin: 3,           // consecutive losses that make a tilt cluster
  revengeWindowMin: 3,        // minutes: a same-symbol re-entry after a loss within this is "revenge"
  brokerGmtOffsetHours: null, // reserved for the upcoming session view (Asian/London/NY)
  seriousStart: "2026-05-28", // YYYY-MM-DD; trades before this are archived as the beginner era
  swingLookback: 5,           // fractal pivot lookback for SMC swing detection
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
