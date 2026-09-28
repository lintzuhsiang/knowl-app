import { CC } from "../../lib/constants";

export default function TensionPanel({ nodes, onNavigate, onClose }) {
  const items = Object.values(nodes).filter(n => n.conflict && n.conflict.status === "unresolved");
  return (
    <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 280, background: "var(--color-background-primary)", borderLeft: "0.5px solid var(--color-border-tertiary)", zIndex: 3500, display: "flex", flexDirection: "column", fontFamily: "'Inter',system-ui,sans-serif", animation: "slideIn 0.2s ease" }}>
      <div style={{ padding: "14px 16px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: CC, marginBottom: 2 }}>Open tensions</div>
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{items.length} unresolved</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--color-text-tertiary)" }}>x</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
        {items.length === 0 && <div style={{ padding: "24px", textAlign: "center", fontSize: 12, color: "var(--color-text-tertiary)" }}>No open tensions</div>}
        {items.map(n => (
          <div key={n.id} onClick={() => onNavigate(n.id)}
            style={{ padding: "12px", borderRadius: 10, marginBottom: 6, cursor: "pointer", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", transition: "border-color 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = CC + "66"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 4 }}>{n.title}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: CC, marginBottom: 4 }}>! {n.conflict.label}</div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>"{n.conflict.inp.slice(0, 80)}{n.conflict.inp.length > 80 ? "..." : ""}"</div>
          </div>
        ))}
      </div>
    </div>
  );
}
