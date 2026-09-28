export default function SelectionToolbar({ x, y, text, loading, onAction }) {
  const acts = [
    { id: "extract",   icon: "o",  label: "Extract" },
    { id: "elaborate", icon: ">>", label: "Elaborate" },
    { id: "question",  icon: "?",  label: "Question" },
  ];
  return (
    <div style={{ position: "fixed", left: x + 8, top: y - 4, transform: "translateY(-100%)", zIndex: 5000, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 9, padding: "3px", display: "flex", gap: 1, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", fontFamily: "'Inter',system-ui,sans-serif", animation: "fadeIn 0.15s ease" }}>
      {loading
        ? <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--color-text-tertiary)", animation: "pulse 1s infinite" }}>thinking...</div>
        : acts.map(a => (
          <button key={a.id} onClick={() => onAction(a.id, text)}
            style={{ fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7, border: "none", background: "transparent", cursor: "pointer", fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--color-background-secondary)"; e.currentTarget.style.color = "var(--color-text-primary)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-secondary)"; }}>
            {a.label}
          </button>
        ))}
    </div>
  );
}
