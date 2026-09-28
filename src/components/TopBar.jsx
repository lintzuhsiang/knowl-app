import { memo } from "react";
import { TOPIC_COLORS, CC, IS_TOUCH, uid } from "../lib/constants";

/**
 * Application top toolbar — topic tabs, action buttons, view bookmarks, sync indicator.
 *
 * Wrapped in React.memo because the toolbar rarely needs to re-render during
 * high-frequency operations like node drag or lasso (those only change pan/zoom/nodeMap,
 * none of which are TopBar props). Without memo, every mousemove during drag would
 * re-render 30+ toolbar buttons for nothing.
 */
export default memo(function TopBar({
  // Data
  topicKeys, topic, graph, accent, zoom,
  newTopicInput, chatOpen, chatConcepts,
  historyCount, merging, fusePhase,
  focusNodeId, rightPanel, gapCount, gapScanState,
  conflictCount, tensionOpen, syncStatus,
  viewMenuOpen, savedViews, sel,
  // Callbacks
  onTopicChange, onNewTopicInput, onCreateTopic,
  onImport, onMigrate, onSearch,
  onChatToggle, onUndo,
  onAutoLink, onAutoArrange, onToggleFocus,
  onOpenPanel, onTensionToggle,
  onResetView, onViewMenuToggle, onSaveView, onRestoreView, onDeleteView,
  onOpenAccount,
}) {
  const tbPad = IS_TOUCH ? "8px 14px" : "3px 10px";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", flexShrink: 0, position: "relative", zIndex: 100, flexWrap: "wrap" }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.04em" }}>Knowl</span>
      <div style={{ width: 1, height: 14, background: "var(--color-border-tertiary)" }} />

      {/* ── Topic tabs ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 2, alignItems: "center", background: "var(--color-background-secondary)", borderRadius: 7, padding: 3 }}>
        {topicKeys.map((id, idx) => (
          <button key={id} onClick={() => onTopicChange(id)}
            style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 500, padding: "3px 11px", borderRadius: 5, border: "none", cursor: "pointer", background: topic === id ? "var(--color-background-primary)" : "transparent", color: topic === id ? TOPIC_COLORS[idx % TOPIC_COLORS.length] : "var(--color-text-tertiary)", transition: "all 0.15s" }}>
            {graph[id].label}
          </button>
        ))}
        {newTopicInput !== null
          ? <div style={{ display: "flex", gap: 4, paddingLeft: 4 }}>
            <input autoFocus value={newTopicInput} onChange={e => onNewTopicInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && newTopicInput.trim()) {
                  const key = newTopicInput.trim().toLowerCase().replace(/\s+/g, "-") + "-" + uid();
                  onCreateTopic(key, newTopicInput.trim());
                }
                if (e.key === "Escape") onNewTopicInput(null);
              }}
              placeholder="Topic name..." style={{ fontFamily: "inherit", fontSize: 12, padding: "2px 8px", borderRadius: 5, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", outline: "none", width: 100 }} />
            <button onClick={() => onNewTopicInput(null)} style={{ fontFamily: "inherit", fontSize: 11, padding: "2px 6px", borderRadius: 5, border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer" }}>x</button>
          </div>
          : <button onClick={() => onNewTopicInput("")} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "3px 9px", borderRadius: 5, border: "none", cursor: "pointer", background: "transparent", color: "var(--color-text-tertiary)", transition: "all 0.15s" }} title="New topic">+</button>
        }
      </div>

      {/* ── Left action buttons ────────────────────────────────────── */}
      <button onClick={onImport} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", whiteSpace: "nowrap" }}>Import</button>
      <button onClick={onMigrate} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: tbPad, borderRadius: 6, border: "0.5px solid " + accent + "55", background: accent + "0a", color: accent, cursor: "pointer", whiteSpace: "nowrap" }}>Migrate</button>
      <button onClick={onSearch} title="Cmd+K" style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", whiteSpace: "nowrap" }}>Search</button>
      <div style={{ flex: 1 }} />

      {/* ── Right action buttons ───────────────────────────────────── */}
      <button
        onClick={onChatToggle}
        title="Open conversational chat"
        style={{
          fontFamily: "inherit", fontSize: 11, fontWeight: 600,
          padding: tbPad, borderRadius: 6, cursor: "pointer",
          border: "0.5px solid " + (chatOpen ? accent + "55" : "var(--color-border-secondary)"),
          background: chatOpen ? accent + "14" : "transparent",
          color: chatOpen ? accent : "var(--color-text-secondary)",
          transition: "all 0.15s", whiteSpace: "nowrap",
          display: "flex", alignItems: "center", gap: 5,
        }}
      >
        Chat
        {chatConcepts.filter(c => !c.committed).length > 0 && (
          <span style={{ fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 100, background: accent, color: "#fff", lineHeight: 1.6 }}>
            {chatConcepts.filter(c => !c.committed).length}
          </span>
        )}
      </button>
      {historyCount > 0 && <button onClick={onUndo} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>Undo ({historyCount})</button>}
      {merging && <div style={{ fontSize: 11, fontWeight: 600, color: "#10b981", animation: "pulse 1s infinite" }}>Merging...</div>}
      {fusePhase === "thinking" && <div style={{ fontSize: 11, fontWeight: 600, color: accent, animation: "pulse 1s infinite" }}>Mapping...</div>}
      <button onClick={onAutoLink} title="Find missing connections" style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", whiteSpace: "nowrap" }}>Links</button>
      <button onClick={onAutoArrange} title="Auto-arrange nodes with force-directed layout" style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", whiteSpace: "nowrap" }}>Arrange</button>
      <button onClick={() => onToggleFocus(sel[0] || null)} title="Focus mode: dim unconnected nodes" style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: tbPad, borderRadius: 6, border: "0.5px solid " + (focusNodeId ? accent + "55" : "var(--color-border-secondary)"), background: focusNodeId ? accent + "14" : "transparent", color: focusNodeId ? accent : "var(--color-text-tertiary)", cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.15s" }}>Focus</button>
      {["tutor", "warmup", "gaps"].map(t => (
        <button key={t} onClick={() => onOpenPanel(t)} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap", background: rightPanel === t ? accent + "18" : "transparent", color: rightPanel === t ? accent : t === "gaps" && gapCount > 0 ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
          {t === "tutor" ? "Tutor" : t === "warmup" ? "Warm Up" : gapScanState === "scanning" ? "Gaps..." : "Gaps" + (gapCount > 0 ? " " + gapCount : "")}
        </button>
      ))}
      {conflictCount > 0 && <button onClick={onTensionToggle} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: tbPad, borderRadius: 100, background: tensionOpen ? CC + "28" : CC + "18", color: CC, border: "0.5px solid " + CC + "44", cursor: "pointer", whiteSpace: "nowrap" }}>! {conflictCount}</button>}
      {!IS_TOUCH && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", display: "flex", gap: 5 }}><span>scroll=pan</span><span>ctrl+scroll=zoom</span><span>dbl=new</span></div>}

      {/* ── Sync indicator + zoom reset ─────────────────────────────── */}
      <div title={syncStatus === "saved" ? "Saved" : syncStatus === "saving" ? "Saving..." : syncStatus === "offline" ? "Server offline" : ""} style={{ width: 7, height: 7, borderRadius: "50%", background: syncStatus === "saved" ? "#10b981" : syncStatus === "saving" ? "#f59e0b" : syncStatus === "offline" ? "#ef4444" : "var(--color-border-tertiary)", flexShrink: 0, transition: "background 0.4s" }} />
      <button onClick={onResetView} style={{ fontFamily: "inherit", fontSize: 11, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer" }}>{Math.round(zoom * 100)}%</button>

      {/* Account / settings */}
      {onOpenAccount && (
        <button onClick={onOpenAccount} title="Account settings"
          style={{
            fontFamily: "inherit", fontSize: 11, fontWeight: 500,
            padding: tbPad, borderRadius: 6,
            border: "0.5px solid var(--color-border-secondary)",
            background: "transparent",
            color: "var(--color-text-tertiary)",
            cursor: "pointer", whiteSpace: "nowrap",
          }}>⚙</button>
      )}

      {/* ── Saved views dropdown ────────────────────────────────────── */}
      <div style={{ position: "relative" }}>
        <button onClick={onViewMenuToggle} title="Saved views" style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: tbPad, borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: viewMenuOpen ? "var(--color-background-secondary)" : "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", whiteSpace: "nowrap" }}>{"📌"}{savedViews.length > 0 ? " " + savedViews.length : ""}</button>
        {viewMenuOpen && (
          <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 200, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", minWidth: 140, fontFamily: "'Inter',system-ui,sans-serif" }}>
            <div onClick={onSaveView} style={{ fontSize: 11, padding: "6px 8px", borderRadius: 5, cursor: "pointer", color: accent, fontWeight: 600, transition: "background 0.1s" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>+ Save current view</div>
            {savedViews.length > 0 && <div style={{ height: 1, background: "var(--color-border-tertiary)", margin: "4px 0" }} />}
            {savedViews.map((v, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div onClick={() => onRestoreView(v)} style={{ flex: 1, fontSize: 11, padding: "5px 8px", borderRadius: 5, cursor: "pointer", color: "var(--color-text-primary)", transition: "background 0.1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{v.name} <span style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>{Math.round(v.zoom * 100)}%</span></div>
                <div onClick={() => onDeleteView(i)} style={{ fontSize: 9, cursor: "pointer", color: "var(--color-text-tertiary)", padding: "2px 4px" }}>{"✕"}</div>
              </div>
            ))}
            {savedViews.length === 0 && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", padding: "4px 8px", fontStyle: "italic" }}>No saved views</div>}
          </div>
        )}
      </div>
    </div>
  );
});
