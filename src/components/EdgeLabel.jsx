import { useState } from "react";
import { edgeMidpoint } from "../lib/utils";

export default function EdgeLabel({ e, nodes, accent, sel, hov, onSave, onDelete, onConfirm }) {
  const [ed, setEd] = useState(false);
  const [v, setV] = useState(e.label || "");
  const nf = nodes[e.from], nt = nodes[e.to];
  if (!nf || !nt) return null;

  const isPending = !!e.pending;
  // Pending edges always show their confirm UI; regular edges only when selected/hovered
  if (!isPending && !(sel.includes(e.from) || sel.includes(e.to) || hov === e.from || hov === e.to)) return null;

  const { x: mx, y: my } = edgeMidpoint(nf, nt);
  const save = () => { setEd(false); onSave(e.id, v); };

  if (isPending) {
    return (
      <div style={{ position: "absolute", left: mx - 60, top: my - 13, zIndex: 60 }}
        onMouseDown={ev => ev.stopPropagation()} onClick={ev => ev.stopPropagation()}>
        {ed
          ? <input autoFocus value={v} onChange={ev => setV(ev.target.value)}
              onBlur={save} onKeyDown={ev => { if (ev.key === "Enter" || ev.key === "Escape") save(); }}
              style={{ width: 80, fontFamily: "'Inter',system-ui", fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 100, border: "1px solid #888", background: "var(--color-background-primary)", color: "#888", outline: "none", textAlign: "center" }} />
          : <div style={{ display: "flex", alignItems: "center", gap: 3, background: "var(--color-background-primary)", border: "0.5px solid #88888844", borderRadius: 100, padding: "2px 6px", boxShadow: "0 2px 8px rgba(0,0,0,0.14)", whiteSpace: "nowrap" }}>
              <span style={{ fontSize: 9, color: "#888", maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label || "suggested"}</span>
              <button onClick={() => onConfirm && onConfirm(e.id)} style={{ fontFamily: "inherit", fontSize: 10, border: "none", background: "transparent", color: "#4caf50", cursor: "pointer", padding: "0 2px", fontWeight: 700, lineHeight: 1 }}>✓</button>
              <button onClick={() => { setEd(true); setV(e.label || ""); }} style={{ fontFamily: "inherit", fontSize: 9, border: "none", background: "transparent", color: "#999", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}>edit</button>
              <button onClick={() => onDelete(e.id)} style={{ fontFamily: "inherit", fontSize: 10, border: "none", background: "transparent", color: "#f44336", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}>✕</button>
            </div>}
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", left: mx - 32, top: my - 11, zIndex: 50 }}>
      {ed
        ? <input autoFocus value={v} onChange={ev => setV(ev.target.value)}
            onBlur={save} onKeyDown={ev => { if (ev.key === "Enter" || ev.key === "Escape") save(); }}
            style={{ width: 80, fontFamily: "'Inter',system-ui", fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 100, border: "1px solid " + accent, background: "var(--color-background-primary)", color: accent, outline: "none", textAlign: "center" }} />
        : <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <div onClick={() => { setEd(true); setV(e.label || ""); }}
              style={{ fontSize: 9, fontWeight: 600, padding: "2px 8px", borderRadius: 100, background: "var(--color-background-primary)", border: "0.5px solid " + accent + "55", color: accent, cursor: "pointer", whiteSpace: "nowrap", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              {e.label || "label"}
            </div>
            <div onClick={() => onDelete(e.id)} style={{ fontSize: 11, color: "var(--color-text-tertiary)", cursor: "pointer", padding: "0 2px" }}>x</div>
          </div>}
    </div>
  );
}
