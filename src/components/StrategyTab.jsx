import { BarChart3, Target } from "lucide-react";
import { fmtMoney, fmtDateTimeShort } from "../lib/format";
import { C } from "../theme";
import { CONFLUENCE_MAX } from "../lib/analytics";

export function StrategyTab({ candleIndex, hasCandleData, strategyImpact, setupScan, settings }) {
  return (
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
  );
}
