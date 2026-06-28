// Number / money / date formatting helpers, shared by the analytics engine
// and the React components. Pure, no dependencies.

export const round2 = (n) => Math.round(n * 100) / 100;
export const round1 = (n) => Math.round(n * 10) / 10;

export const fmtMoney = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const v = round2(n);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
};

export const fmtPct = (n) => (n == null || Number.isNaN(n) ? "—" : `${round1(n)}%`);

export const fmtDateLabel = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export const fmtTime = (d) =>
  new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

export const fmtDateFull = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};

export const fmtDateTimeShort = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
