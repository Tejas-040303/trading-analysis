import { useState, useEffect } from "react";
import { C } from "../theme";

export function NoteInput({ value, onSave }) {
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value || "")) onSave(v); }}
      placeholder="Add note…"
      style={{
        width: "100%",
        background: "transparent",
        border: `0.5px solid ${C.borderSoft}`,
        borderRadius: 6,
        color: C.text,
        fontSize: 12,
        padding: "3px 6px",
      }}
    />
  );
}

