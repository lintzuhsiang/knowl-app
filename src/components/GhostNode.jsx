import { NW } from "../lib/constants";

export default function GhostNode({ gn, accent, onConfirm, onDismiss }) {
  return (
    <div style={{ position: "absolute", left: gn.x, top: gn.y, width: NW, border: "2px dashed " + accent, borderRadius: 14, padding: "14px 16px", background: accent + "08", fontFamily: "'Inter',system-ui,sans-serif", zIndex: 15, animation: "fadeIn 0.25s ease", pointerEvents: "all" }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: accent, marginBottom: 6 }}>AI suggests</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: gn.reason ? 6 : 10 }}>{gn.title}</div>
      {gn.reason && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.5, marginBottom: 10 }}>{gn.reason}</div>}
      <div style={{ display: "flex", gap: 6 }}>
        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onConfirm(gn); }} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 7, border: "none", background: accent, color: "#fff", cursor: "pointer" }}>+ Add</button>
        <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onDismiss(gn.id); }} style={{ fontFamily: "inherit", fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer" }}>x</button>
      </div>
    </div>
  );
}
