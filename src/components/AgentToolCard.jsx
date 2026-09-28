import { memo, useState } from "react";

const TOOL_ICONS = {
  // Tier 1 — read
  search_nodes: "🔍",
  read_node: "📖",
  list_nodes: "📋",
  traverse: "→",
  list_topics: "🗂",
  get_user_focus: "📍",
  get_memory_stats: "⏱",
  find_orphans: "○",
  // Tier 1.5a — algorithmic discovery
  find_dormant_threads: "💤",
  find_unexplored_neighbors: "🧭",
  // Tier 1.5b — LLM-powered discovery
  suggest_bridges: "🌉",
  expand_concept: "🌱",
  infer_implicit_concepts: "💡",
  find_conceptual_gaps: "▫",
  infer_node_overlap: "≈",
  // Tier 2 — propose
  propose_create_node: "✚",
  propose_update_node: "✎",
  propose_delete_node: "✕",
  propose_link_nodes: "⤳",
  propose_unlink: "⊘",
  propose_merge_nodes: "⊕",
  // Tier 3 — control
  confirm_with_user: "❓",
  hand_off_to_mode: "↪",
};

const STATE_COLOR = {
  pending: "#94a3b8",
  success: "#059669",
  error:   "#dc2626",
};

/**
 * Renders one Agent tool invocation: invocation header collapsed by default,
 * click to expand the input + result JSON.
 *
 *   state = 'pending'  call fired, no result yet
 *   state = 'success'  result arrived
 *   state = 'error'    result returned an error
 */
export default memo(function AgentToolCard({ call, result, error, state, durationMs }) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICONS[call?.name] || "🔧";
  const color = state === 'error' ? STATE_COLOR.error
              : state === 'success' ? STATE_COLOR.success
              : STATE_COLOR.pending;

  // Brief inline summary of the result for collapsed state
  const summary = (() => {
    if (state === 'pending') return 'running…';
    if (state === 'error')   return error || 'error';
    if (!result) return 'ok';
    if (Array.isArray(result.matches))         return `${result.matches.length} matches`;
    if (Array.isArray(result.nodes))           return `${result.nodes.length} nodes`;
    if (Array.isArray(result.orphans))         return `${result.orphans.length} orphans`;
    if (Array.isArray(result.dormant))         return `${result.dormant.length} dormant`;
    if (Array.isArray(result.unexplored))      return `${result.unexplored.length} unexplored`;
    if (Array.isArray(result.topics))          return `${result.topics.length} topics`;
    if (Array.isArray(result.bridges))         return `${result.bridges.length} bridges`;
    if (Array.isArray(result.concepts))        return `${result.concepts.length} concepts`;
    if (Array.isArray(result.implicit))        return `${result.implicit.length} implicit`;
    if (Array.isArray(result.gaps))            return `${result.gaps.length} gaps`;
    if (result.overlap_pct !== undefined)      return `${result.overlap_pct}% overlap (${result.relation || ''})`;
    if (result.suggestion)                     return `proposal queued`;
    if (result.choice !== undefined)           return `user picked: ${result.choice || '(skipped)'}`;
    if (result.hand_off)                       return `→ /${result.mode}`;
    if (result.layer1)                         return `${result.layer1.length} 1-hop`;
    if (result.body)                           return `"${(result.title || '').slice(0, 30)}"`;
    if (result.returning_from_gap !== undefined) return result.returning_from_gap ? 'returning' : 'active';
    return 'ok';
  })();

  return (
    <div style={{
      borderRadius: 8,
      border: "0.5px solid " + color + "33",
      background: color + "08",
      overflow: "hidden",
      fontFamily: "'Inter', system-ui, sans-serif",
      maxWidth: "85%",
    }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "6px 10px",
          display: "flex", alignItems: "center", gap: 8,
          cursor: "pointer",
          fontSize: 11,
        }}
      >
        <span style={{ fontSize: 13 }}>{icon}</span>
        <span style={{
          fontFamily: "'Fira Code', monospace",
          fontWeight: 600, color: color,
        }}>{call?.name}</span>
        <span style={{ color: "var(--color-text-tertiary)", flex: 1, fontStyle: state === 'pending' ? 'italic' : 'normal' }}>
          {summary}
        </span>
        {state !== 'pending' && durationMs != null && (
          <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", fontFamily: "'Fira Code', monospace" }}>
            {durationMs}ms
          </span>
        )}
        <span style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>
          {open ? '▾' : '▸'}
        </span>
      </div>
      {open && (
        <div style={{
          borderTop: "0.5px solid " + color + "22",
          padding: "6px 10px",
          background: "rgba(0,0,0,0.02)",
          fontFamily: "'Fira Code', monospace",
          fontSize: 10, lineHeight: 1.5,
          maxHeight: 280, overflow: "auto",
        }}>
          {call?.input && Object.keys(call.input).length > 0 && (
            <>
              <div style={{ color: "var(--color-text-tertiary)", marginBottom: 2 }}>input:</div>
              <pre style={{ margin: 0, marginBottom: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {JSON.stringify(call.input, null, 2)}
              </pre>
            </>
          )}
          {state !== 'pending' && (
            <>
              <div style={{ color: "var(--color-text-tertiary)", marginBottom: 2 }}>
                {error ? 'error:' : 'result:'}
              </div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: error ? STATE_COLOR.error : "inherit" }}>
                {error || JSON.stringify(result, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});
