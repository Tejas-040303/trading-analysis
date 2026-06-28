import React from "react";
import { Flame, CircleCheck, Filter, ChevronDown, ChevronRight } from "lucide-react";
import { fmtMoney, fmtDateFull, fmtTime, fmtDateLabel, fmtDateTimeShort } from "../lib/format";
import { C } from "../theme";
import { NoteInput } from "./NoteInput";
import { parseTags, CONFLUENCE_MAX } from "../lib/analytics";

export function TradesTab({ a, settings, sortedDaily, dailySort, toggleDailySort, sortedTrades, tradeSort, toggleSort, tradeFilter, setTradeFilter, allTags, hasCandleData, tradeVerdicts, expandedTrade, setExpandedTrade, saveNote }) {
  return (
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
  );
}
