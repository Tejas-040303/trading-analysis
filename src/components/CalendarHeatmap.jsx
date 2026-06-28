import { C } from "../theme";
import { fmtMoney } from "../lib/format";

export function CalendarHeatmap({ days }) {
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
