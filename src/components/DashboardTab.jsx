import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell,
} from "recharts";
import {
  TrendingUp, TrendingDown, AlertTriangle, Flame, Wallet, Target, Percent, Calendar,
} from "lucide-react";
import { fmtMoney, fmtPct, fmtDateTimeShort } from "../lib/format";
import { C, OP_KIND, tooltipStyle, axisProps } from "../theme";
import { StatCard } from "./StatCard";
import { BalanceTotal } from "./BalanceTotal";
import { ChartCard } from "./ChartCard";
import { CalendarHeatmap } from "./CalendarHeatmap";
import { TimeOfDayHeatmap } from "./TimeOfDayHeatmap";

export function DashboardTab({ a, settings, filteredDaily, chartRange, setChartRange, setRange, priorSection }) {
  return (
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
  );
}
