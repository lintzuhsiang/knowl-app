import { useState } from "react";
import { CC, NC } from "../../lib/constants";

export default function FusionModal({ mappings, nodes, accent, onConfirm, onDismiss }) {
  const [sel, setSel] = useState(() => mappings.map((_, i) => i));
  const toggle = i => setSel(p => p.includes(i) ? p.filter(x => x !== i) : [...p, i]);
  const tC = { update: accent, conflict: CC, new: NC };
  const tL = { update: "Update", conflict: "Conflict", new: "New node" };

  return (
    <div onClick={e => e.target === e.currentTarget && onDismiss()} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 8000, padding: "1rem" }}>
      <div style={{ background: "var(--color-background-primary)", borderRadius: 18, border: "0.5px solid var(--color-border-tertiary)", width: "100%", maxWidth: 640, maxHeight: "82%", fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "1.25rem 1.5rem", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: accent, marginBottom: 3 }}>Fusion Preview</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)" }}>Review before applying</div>
          </div>
          <button onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "var(--color-text-tertiary)" }}>x</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
          {mappings.map((m, i) => {
            const on = sel.includes(i); const c = tC[m.type] || accent; const tn = m.nodeId ? nodes[m.nodeId] : null;
            return (
              <div key={i} onClick={() => toggle(i)} style={{ padding: "11px 14px", borderRadius: 11, marginBottom: 8, cursor: "pointer", background: on ? c + "0a" : "var(--color-background-secondary)", border: "1px solid " + (on ? c + "55" : "var(--color-border-tertiary)"), transition: "all 0.15s", opacity: on ? 1 : 0.45 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 100, background: c + "18", color: c, border: "0.5px solid " + c + "44" }}>{tL[m.type] || "-"}</div>
                  {tn  && <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)" }}>to {tn.title}</div>}
                  {!tn && m.newTitle && <div style={{ fontSize: 11, fontWeight: 600, color: NC }}>+ {m.newTitle}</div>}
                  <div style={{ marginLeft: "auto", fontSize: 10, color: on ? c : "var(--color-text-tertiary)", fontWeight: 600 }}>{on ? "include" : "skip"}</div>
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.65, color: "var(--color-text-secondary)", fontStyle: "italic" }}>"{m.excerpt}"</div>
              </div>
            );
          })}
        </div>
        <div style={{ padding: "1rem 1.5rem", borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{sel.length} of {mappings.length} selected</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onDismiss} style={{ fontFamily: "inherit", fontSize: 12, padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => onConfirm(mappings.filter((_, i) => sel.includes(i)))} disabled={sel.length === 0} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer", opacity: sel.length === 0 ? 0.4 : 1 }}>Apply {sel.length}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
