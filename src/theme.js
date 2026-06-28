// Shared visual tokens — the dark "trading terminal" palette, the balance-op
// kind chips, and the recharts tooltip/axis styling. Imported across components.

export const C = {
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
export const OP_KIND = {
  deposit:      { label: "Deposit",      color: C.emerald, bg: C.emeraldDim },
  withdrawal:   { label: "Withdrawal",   color: C.rose,    bg: C.roseDim },
  transfer_out: { label: "Transfer out", color: C.amber,   bg: C.amberDim },
  transfer_in:  { label: "Transfer in",  color: C.emerald, bg: C.emeraldDim },
};

export const tooltipStyle = {
  contentStyle: { background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 },
  labelStyle: { color: C.textMuted, marginBottom: 4 },
  itemStyle: { color: C.text },
};

export const axisProps = {
  tick: { fill: C.textFaint, fontSize: 11 },
  axisLine: { stroke: C.border },
  tickLine: { stroke: C.border },
};
