import React from "react";
import { C } from "../theme";
import { fmtMoney } from "../lib/format";

export function TimeOfDayHeatmap({ grid }) {
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

