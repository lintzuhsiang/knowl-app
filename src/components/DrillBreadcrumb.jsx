import { memo } from "react";

/**
 * Breadcrumb navigation bar shown when drilled into a sub-canvas.
 *
 * Wrapped in React.memo — only re-renders when drillPath or topic changes,
 * not on every node drag or pan/zoom.
 */
export default memo(function DrillBreadcrumb({ drillPath, topicLabel, accent, onDrillBack }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "5px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", flexShrink: 0, overflow: "hidden", fontFamily: "'Inter',system-ui,sans-serif" }}>
      <button onClick={() => onDrillBack(0)}
        style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 5, border: "none", background: "transparent", color: accent, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, transition: "background 0.12s" }}
        onMouseEnter={e => e.currentTarget.style.background = accent + "18"}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
        {topicLabel}
      </button>
      {drillPath.map((entry, i) => (
        <span key={entry.id} style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0 }}>
          <span style={{ color: "var(--color-text-tertiary)", fontSize: 11, flexShrink: 0 }}>›</span>
          {i < drillPath.length - 1 ? (
            <button onClick={() => onDrillBack(i + 1)}
              style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 5, border: "none", background: "transparent", color: accent, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140, transition: "background 0.12s" }}
              onMouseEnter={e => e.currentTarget.style.background = accent + "18"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              {entry.title}
            </button>
          ) : (
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)", padding: "2px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
              {entry.title}
            </span>
          )}
        </span>
      ))}
      <div style={{ flex: 1 }} />
      <button onClick={() => onDrillBack(drillPath.length - 1)}
        title="Go up one level"
        style={{ fontFamily: "inherit", fontSize: 11, padding: "2px 8px", borderRadius: 5, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: drillPath.length > 1 ? "pointer" : "default", opacity: drillPath.length > 1 ? 1 : 0, whiteSpace: "nowrap", flexShrink: 0 }}>
        ← up
      </button>
    </div>
  );
});
