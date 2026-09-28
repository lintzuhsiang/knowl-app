import { IS_TOUCH } from "../lib/constants";

export default function TouchFAB({ accent, onCreateNode, onUndo, undoCount, onSearch }) {
  if (!IS_TOUCH) return null;
  const btn = (onClick, size, bg, color, child, extra) => (
    <button onClick={onClick}
      style={{
        width: size, height: size, borderRadius: "50%", border: "none",
        background: bg, color, fontSize: size * 0.45, fontWeight: 700,
        cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        display: "flex", alignItems: "center", justifyContent: "center",
        WebkitTapHighlightColor: "transparent", ...extra,
      }}>
      {child}
    </button>
  );

  return (
    <div style={{
      position: "absolute", bottom: 90, left: 16, zIndex: 45,
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      {btn(onCreateNode, 52, accent, "#fff", "+")}
      {undoCount > 0 && btn(onUndo, 44,
        "var(--color-background-primary)", "var(--color-text-secondary)",
        "\u21a9", { border: "0.5px solid var(--color-border-secondary)" })}
      {btn(onSearch, 44,
        "var(--color-background-primary)", "var(--color-text-secondary)",
        "/", { border: "0.5px solid var(--color-border-secondary)" })}
    </div>
  );
}
