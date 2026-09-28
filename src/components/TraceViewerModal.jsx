import { useState, useEffect, useCallback } from "react";

const TOOL_ICONS = {
  search_nodes: "🔍", read_node: "📖", list_nodes: "📋", traverse: "→",
  list_topics: "🗂", get_user_focus: "📍", get_memory_stats: "⏱", find_orphans: "○",
  find_dormant_threads: "💤", find_unexplored_neighbors: "🧭",
  suggest_bridges: "🌉", expand_concept: "🌱", infer_implicit_concepts: "💡",
  find_conceptual_gaps: "▫", infer_node_overlap: "≈",
  propose_create_node: "✚", propose_update_node: "✎", propose_delete_node: "✕",
  propose_link_nodes: "⤳", propose_unlink: "⊘", propose_merge_nodes: "⊕",
  confirm_with_user: "❓", hand_off_to_mode: "↪",
};

const STATUS_COLOR = {
  completed: "#3fb950",
  cancelled: "#8b949e",
  error: "#f85149",
  budget_exhausted: "#f59e0b",
  interrupted: "#f59e0b",
  running: "#58a6ff",
};

/**
 * TraceViewerModal — surface for inspecting past agent runs on this canvas.
 *
 * The `agent_traces` table has been filling up since Phase 4 but had no UI.
 * This is the debug-and-cost-monitoring window: each trace expands to show
 * the full tool_calls timeline with input/result JSON and durations.
 *
 * Props:
 *   canvasKey    pass through so we hit GET /agent/traces/<canvasKey>
 *   accent       theme color from App
 *   onClose()    dismiss
 */
export default function TraceViewerModal({ canvasKey, accent, onClose }) {
  const [traces, setTraces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);     // trace id currently expanded
  const [detail, setDetail]     = useState({});       // { [traceId]: fullTrace }

  const token = localStorage.getItem("knowl_auth_token") || "";
  const workspaceId = localStorage.getItem("knowl_workspace_id") || "";
  const headers = useCallback(() => ({
    "x-auth-token": token,
    ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
  }), [token, workspaceId]);

  // Load the list of recent traces for this canvas
  useEffect(() => {
    if (!canvasKey) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/ai/agent/traces/${encodeURIComponent(canvasKey)}`, { headers: headers() })
      .then(async r => {
        if (cancelled) return;
        if (!r.ok) {
          setError(`Failed to load traces: HTTP ${r.status}`);
          setTraces([]);
          return;
        }
        const data = await r.json();
        setTraces(Array.isArray(data) ? data : []);
      })
      .catch(e => { if (!cancelled) setError(String(e.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [canvasKey, headers]);

  // Lazy-load each trace's full body (tool_calls) only when expanded
  const expand = (traceId) => {
    if (expanded === traceId) { setExpanded(null); return; }
    setExpanded(traceId);
    if (detail[traceId]) return; // already loaded
    fetch(`/api/ai/agent/traces/${encodeURIComponent(canvasKey)}/${traceId}`, { headers: headers() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setDetail(prev => ({ ...prev, [traceId]: d })); })
      .catch(() => { /* silent — list view still works */ });
  };

  const fmtDuration = (ms) => {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  const fmtTokens = (n) => n?.toLocaleString() || "0";
  const fmtTime = (ts) => {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9998, fontFamily: "'Inter', system-ui, sans-serif",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--color-background-secondary, #161b22)",
        borderRadius: 14, width: 720, maxWidth: "92vw",
        maxHeight: "85vh", display: "flex", flexDirection: "column",
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "16px 22px", borderBottom: "0.5px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text-primary, #e6edf3)" }}>
              Agent traces
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary, #6e7681)", marginTop: 2 }}>
              {canvasKey}
            </div>
          </div>
          <button onClick={onClose} style={{
            border: "none", background: "transparent",
            color: "var(--color-text-tertiary, #6e7681)",
            cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 22px 22px" }}>
          {loading && (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--color-text-tertiary, #6e7681)", fontSize: 12, animation: "pulse 1.5s infinite" }}>
              Loading…
            </div>
          )}
          {error && (
            <div style={{ color: "#f85149", fontSize: 12, padding: "12px 0" }}>{error}</div>
          )}
          {!loading && !error && traces.length === 0 && (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--color-text-tertiary, #6e7681)", fontSize: 12 }}>
              No agent runs on this canvas yet. Free chat sends route through the agent —
              ask it something to generate a trace.
            </div>
          )}

          {traces.map(t => {
            const isOpen = expanded === t.id;
            const statusColor = STATUS_COLOR[t.status] || "#8b949e";
            const dur = t.ended_at && t.started_at ? t.ended_at - t.started_at : null;
            return (
              <div key={t.id} style={{
                marginBottom: 8, borderRadius: 8,
                background: "rgba(255,255,255,0.02)",
                border: "0.5px solid rgba(255,255,255,0.06)",
                overflow: "hidden",
              }}>
                {/* Row header — click to expand */}
                <div onClick={() => expand(t.id)} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 14px", cursor: "pointer",
                }}>
                  <div style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: statusColor, flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, color: "var(--color-text-primary, #e6edf3)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {t.user_message || <em style={{ opacity: 0.4 }}>(no user message)</em>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary, #6e7681)", marginTop: 2, display: "flex", gap: 12 }}>
                      <span>{fmtTime(t.started_at)}</span>
                      <span>{t.iterations || 0} iter</span>
                      <span>{fmtTokens(t.total_tokens)} tok</span>
                      <span style={{ color: statusColor, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{t.status}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary, #6e7681)" }}>
                    {fmtDuration(dur)}
                  </div>
                  <div style={{ fontSize: 9, color: "var(--color-text-tertiary, #6e7681)" }}>
                    {isOpen ? "▾" : "▸"}
                  </div>
                </div>

                {/* Expanded — tool calls timeline */}
                {isOpen && (
                  <div style={{
                    borderTop: "0.5px solid rgba(255,255,255,0.06)",
                    padding: "10px 14px",
                    background: "rgba(0,0,0,0.15)",
                  }}>
                    {!detail[t.id] && (
                      <div style={{ fontSize: 11, color: "var(--color-text-tertiary, #6e7681)", animation: "pulse 1.5s infinite" }}>
                        Loading tool calls…
                      </div>
                    )}
                    {detail[t.id] && (
                      <ToolCallTimeline calls={detail[t.id].tool_calls || []} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ToolCallTimeline({ calls }) {
  const [open, setOpen] = useState({}); // call.id → bool

  if (!calls.length) {
    return (
      <div style={{ fontSize: 11, color: "var(--color-text-tertiary, #6e7681)", fontStyle: "italic" }}>
        No tool calls — agent answered without invoking any tool.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {calls.map(c => {
        const icon = TOOL_ICONS[c.name] || "🔧";
        const isErr = !!c.error;
        const isOpen = !!open[c.id];
        return (
          <div key={c.id} style={{
            borderRadius: 6,
            background: isErr ? "rgba(248,81,73,0.06)" : "rgba(255,255,255,0.03)",
            border: "0.5px solid " + (isErr ? "rgba(248,81,73,0.22)" : "rgba(255,255,255,0.06)"),
            overflow: "hidden",
          }}>
            <div onClick={() => setOpen(o => ({ ...o, [c.id]: !o[c.id] }))}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "5px 9px", cursor: "pointer", fontSize: 11,
              }}>
              <span>{icon}</span>
              <span style={{ fontFamily: "'Fira Code', monospace", fontWeight: 600, color: isErr ? "#f85149" : "var(--color-text-primary, #e6edf3)" }}>
                {c.name}
              </span>
              <span style={{ flex: 1, color: "var(--color-text-tertiary, #6e7681)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {isErr ? c.error : describeResult(c.result)}
              </span>
              <span style={{ fontSize: 9, color: "var(--color-text-tertiary, #6e7681)", fontFamily: "'Fira Code', monospace" }}>
                {c.duration_ms != null ? `${c.duration_ms}ms` : ''}
              </span>
              <span style={{ fontSize: 9, color: "var(--color-text-tertiary, #6e7681)" }}>{isOpen ? "▾" : "▸"}</span>
            </div>
            {isOpen && (
              <div style={{
                padding: "6px 10px",
                borderTop: "0.5px solid rgba(255,255,255,0.05)",
                background: "rgba(0,0,0,0.18)",
                fontFamily: "'Fira Code', monospace",
                fontSize: 10, lineHeight: 1.55,
              }}>
                {c.input && Object.keys(c.input).length > 0 && (
                  <>
                    <div style={{ color: "var(--color-text-tertiary, #6e7681)", marginBottom: 2 }}>input:</div>
                    <pre style={{ margin: 0, marginBottom: 6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--color-text-primary, #e6edf3)" }}>
                      {JSON.stringify(c.input, null, 2)}
                    </pre>
                  </>
                )}
                <div style={{ color: "var(--color-text-tertiary, #6e7681)", marginBottom: 2 }}>
                  {isErr ? "error:" : "result:"}
                </div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: isErr ? "#f85149" : "var(--color-text-primary, #e6edf3)" }}>
                  {isErr ? c.error : JSON.stringify(c.result, null, 2)}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function describeResult(result) {
  if (!result) return 'ok';
  if (Array.isArray(result.matches))   return `${result.matches.length} matches`;
  if (Array.isArray(result.nodes))     return `${result.nodes.length} nodes`;
  if (Array.isArray(result.orphans))   return `${result.orphans.length} orphans`;
  if (Array.isArray(result.dormant))   return `${result.dormant.length} dormant`;
  if (Array.isArray(result.unexplored)) return `${result.unexplored.length} unexplored`;
  if (Array.isArray(result.topics))    return `${result.topics.length} topics`;
  if (Array.isArray(result.bridges))   return `${result.bridges.length} bridges`;
  if (Array.isArray(result.concepts))  return `${result.concepts.length} concepts`;
  if (Array.isArray(result.implicit))  return `${result.implicit.length} implicit`;
  if (Array.isArray(result.gaps))      return `${result.gaps.length} gaps`;
  if (result.overlap_pct !== undefined) return `${result.overlap_pct}% overlap`;
  if (result.suggestion)               return 'proposal queued';
  if (result.choice !== undefined)     return `user picked: ${result.choice ?? '(skipped)'}`;
  if (result.hand_off)                 return `→ /${result.mode}`;
  if (result.body)                     return `"${(result.title || '').slice(0, 30)}"`;
  return 'ok';
}
