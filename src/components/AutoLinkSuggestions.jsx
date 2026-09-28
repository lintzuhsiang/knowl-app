export default function AutoLinkSuggestions({ suggestions, nodes, accent, onAccept, onDismiss }) {
  return (
    <div style={{ position: "absolute", bottom: 80, right: 16, zIndex: 5000, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 14, padding: "12px 14px", maxWidth: 340, boxShadow: "0 4px 24px rgba(0,0,0,0.12)", fontFamily: "'Inter',system-ui,sans-serif", animation: "slideUp 0.2s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: accent }}>Suggested Links</div>
        <button onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "var(--color-text-tertiary)", padding: 0, lineHeight: 1 }}>x</button>
      </div>
      {suggestions.map((s, i) => {
        const fromN = nodes[s.from];
        const toN = nodes[s.to];
        return (
          <div key={i} style={{ padding: "8px 10px", borderRadius: 9, marginBottom: 6, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>{fromN?.title || s.from}</span>
              <span style={{ fontSize: 10, color: accent }}>{"\u2192"}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>{toN?.title || s.to}</span>
            </div>
            <div style={{ fontSize: 10, color: accent, fontWeight: 600, marginBottom: 2 }}>{s.label}</div>
            {s.reason && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.5, marginBottom: 6 }}>{s.reason}</div>}
            <button onClick={() => onAccept(s)}
              style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 600, padding: "3px 10px", borderRadius: 6, border: "none", background: accent + "18", color: accent, cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = accent + "30"}
              onMouseLeave={e => e.currentTarget.style.background = accent + "18"}>
              Accept
            </button>
          </div>
        );
      })}
    </div>
  );
}
