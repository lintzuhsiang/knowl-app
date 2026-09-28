import { useState, useEffect } from "react";

export default function Toast({ message, onUndo, onDismiss }) {
  const [v, setV] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => { setV(false); setTimeout(onDismiss, 300); }, 6000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ position: "absolute", bottom: 90, left: "50%", transform: "translateX(-50%) translateY(" + (v ? 0 : 12) + "px)", opacity: v ? 1 : 0, transition: "opacity 0.25s,transform 0.25s", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", zIndex: 4000, fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
      <span>{message}</span>
      <button onClick={onUndo} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "3px 12px", borderRadius: 7, border: "none", background: "var(--color-text-primary)", color: "var(--color-background-primary)", cursor: "pointer" }}>Undo</button>
      <button onClick={() => { setV(false); setTimeout(onDismiss, 300); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "var(--color-text-tertiary)", lineHeight: 1, padding: "0 2px" }}>x</button>
    </div>
  );
}
