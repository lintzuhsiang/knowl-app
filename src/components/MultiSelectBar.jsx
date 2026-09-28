import { memo } from "react";

/**
 * Floating action bar shown at the bottom of the canvas when 2+ nodes are selected.
 *
 * Wrapped in React.memo — only visible when selNodes.length >= 2,
 * and only re-renders when the selection actually changes.
 */
export default memo(function MultiSelectBar({ selNodes, accent, onMerge, onMakeChild, onDelete, onClear }) {
  return (
    <div style={{ position: "absolute", bottom: 60, left: "50%", transform: "translateX(-50%)", zIndex: 200, display: "flex", gap: 4, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: 10, padding: "4px 6px", boxShadow: "0 4px 20px rgba(0,0,0,0.14)", fontFamily: "'Inter',system-ui,sans-serif", animation: "fadeIn 0.15s ease" }}>
      <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "4px 6px", alignSelf: "center" }}>{selNodes.length} selected</span>
      <div style={{ width: 1, background: "var(--color-border-tertiary)", margin: "4px 0" }} />
      {selNodes.length === 2 && (
        <button onClick={onMerge} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 7, border: "none", background: accent + "18", color: accent, cursor: "pointer" }}>Merge →1</button>
      )}
      {selNodes.length === 2 && (
        <button onClick={onMakeChild} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 7, border: "none", background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", cursor: "pointer" }}>Make child ↓</button>
      )}
      <button onClick={onDelete} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 7, border: "none", background: "#ef444418", color: "#ef4444", cursor: "pointer" }}>Delete</button>
      <button onClick={onClear} style={{ fontFamily: "inherit", fontSize: 11, padding: "4px 8px", borderRadius: 7, border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer" }}>✕</button>
    </div>
  );
});
