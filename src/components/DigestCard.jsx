import { useState, useEffect } from "react";
import { CC, NC } from "../lib/constants";

export default function DigestCard({ data, onDismiss }) {
  const [v, setV] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => { setV(false); setTimeout(onDismiss, 300); }, 8000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%) translateY(" + (v ? 0 : -8) + "px)", opacity: v ? 1 : 0, transition: "opacity 0.3s,transform 0.3s", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 12, padding: "12px 16px", zIndex: 200, minWidth: 280, boxShadow: "0 4px 24px rgba(0,0,0,0.1)", fontFamily: "'Inter',system-ui,sans-serif", pointerEvents: "all" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-primary)" }}>Welcome back</div>
        <button onClick={() => { setV(false); setTimeout(onDismiss, 300); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "var(--color-text-tertiary)", padding: 0 }}>x</button>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: data.topSuggestion ? 8 : 0 }}>
        {data.gaps > 0      && <div style={{ fontSize: 11, fontWeight: 500, color: CC }}>Gaps: {data.gaps}</div>}
        {data.conflicts > 0 && <div style={{ fontSize: 11, fontWeight: 500, color: CC }}>Conflicts: {data.conflicts}</div>}
        {data.fuzzyCount > 0 && <div style={{ fontSize: 11, fontWeight: 500, color: "#f59e0b" }}>Fuzzy: {data.fuzzyCount}</div>}
        {data.gaps === 0 && data.conflicts === 0 && <div style={{ fontSize: 11, color: NC }}>Map looks complete</div>}
      </div>
      {data.topSuggestion && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.55, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8 }}>Suggestion: {data.topSuggestion}</div>}
    </div>
  );
}
