import { useState } from "react";
import { api, getText, parseJ } from "../lib/api";
import { NC, CC } from "../lib/constants";
import { nodeW, nodeH } from "../lib/utils";

/**
 * NodeChatPanel — floats near a node when the user right-clicks it.
 * The user types a natural-language command; AI proposes items + edges
 * in the same format as InputBar (handleInput-compatible). The panel
 * shows a preview and the user clicks Apply.
 */
export default function NodeChatPanel({ node, allNodes, edges, accent, onResult, onClose, zoom }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState("idle"); // "idle" | "thinking" | "preview"
  const [preview, setPreview] = useState(null);

  // Position in canvas-space coordinates (parent div is the transform div)
  const panelW = 300;
  const left = node.x + nodeW(node) + 14;
  const top = node.y;
  // Keep panel at constant screen size regardless of zoom
  const invScale = 1 / (zoom || 1);

  const submit = async () => {
    if (!text.trim()) return;
    setPhase("thinking");
    try {
      // Build context: the focused node + its direct neighbours
      const neighbourIds = new Set();
      edges.forEach(e => {
        if (e.from === node.id) neighbourIds.add(e.to);
        if (e.to === node.id) neighbourIds.add(e.from);
      });
      const nodeCtx = "id:\"" + node.id + "\" title:\"" + node.title + "\"\n" + node.body.replace(/^#+ /gm, "").slice(0, 400);
      const neighbourCtx = [...neighbourIds]
        .map(id => allNodes[id])
        .filter(Boolean)
        .map(n => "  id:\"" + n.id + "\" title:\"" + n.title + "\" — " + n.body.replace(/^#+ /gm, "").slice(0, 150))
        .join("\n") || "  (none)";
      const allCtx = Object.values(allNodes)
        .filter(n => n.id !== node.id && !neighbourIds.has(n.id))
        .map(n => "id:\"" + n.id + "\" title:\"" + n.title + "\"")
        .join("\n") || "(none)";

      const prompt =
        "You are modifying a node in a knowledge graph.\n\n" +
        "Focused node:\n" + nodeCtx + "\n\n" +
        "Direct neighbours:\n" + neighbourCtx + "\n\n" +
        "Other nodes (title only):\n" + allCtx + "\n\n" +
        "User command:\n\"" + text + "\"\n\n" +
        "Based on the command, produce a list of changes. Each change is ONE of:\n" +
        "  - \"new\": create a new node (assign a tempId like n1, n2 …).\n" +
        "  - \"update\": add detail to an existing node (use its real id as targetId).\n" +
        "  - \"conflict\": the command contradicts an existing node.\n\n" +
        "Also propose new edges where relationships are clear.\n\n" +
        "Return ONLY valid JSON, no prose:\n" +
        "{\"items\":[{\"tempId\":\"n1\",\"action\":\"new\"|\"update\"|\"conflict\"," +
        "\"targetId\":\"existing id or null\",\"title\":\"short title (new only)\"," +
        "\"body\":\"1-3 short markdown lines\",\"conflictLabel\":\"short phrase or null\"}]," +
        "\"edges\":[{\"from\":\"tempId or existing id\",\"to\":\"tempId or existing id\",\"label\":\"short relation\"}]," +
        "\"reasoning\":\"one sentence\"}";

      const d = await api([{ role: "user", content: prompt }], null, 4096);
      const p = parseJ(getText(d));
      if (p && Array.isArray(p.items) && p.items.length > 0) {
        setPreview(Object.assign({}, p, { inputText: text }));
        setPhase("preview");
      } else {
        setPhase("idle");
      }
    } catch (e) {
      setPhase("idle");
    }
  };

  const confirm = () => {
    if (!preview) return;
    onResult(preview);
  };

  const aC = { conflict: CC, update: accent, new: NC };
  const aL = { conflict: "Conflict", update: "Update", new: "New" };

  return (
    <div style={{
      position: "absolute", left, top, width: panelW, zIndex: 120,
      transform: "scale(" + invScale + ")", transformOrigin: "top left",
      background: "var(--color-background-primary)",
      border: "0.5px solid " + accent + "55",
      borderRadius: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
      fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden",
    }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: accent, flexShrink: 0 }} />
        <div style={{ flex: 1, fontSize: 11, fontWeight: 700, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.title}</div>
        <button onClick={onClose} style={{ fontFamily: "inherit", fontSize: 12, border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}>✕</button>
      </div>

      {/* Preview section */}
      {phase === "preview" && preview && (
        <div style={{ padding: "8px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", maxHeight: 240, overflowY: "auto" }}>
          {preview.reasoning && (
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.5, marginBottom: 7 }}>{preview.reasoning}</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 6 }}>
            {preview.items.map((it, i) => {
              const color = aC[it.action] || accent;
              const targetTitle = it.targetId && allNodes[it.targetId]?.title;
              return (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 7, padding: "3px 0" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 100, flexShrink: 0, marginTop: 1, background: color + "18", color, border: "0.5px solid " + color + "44" }}>{aL[it.action] || "new"}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-primary)", flex: 1, lineHeight: 1.45 }}>
                    <div style={{ fontWeight: 600 }}>{it.title || targetTitle || "(untitled)"}</div>
                    {it.action !== "new" && targetTitle && <div style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>→ {targetTitle}</div>}
                    {it.body && it.action === "new" && <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", marginTop: 1 }}>{it.body.slice(0, 80)}{it.body.length > 80 ? "…" : ""}</div>}
                  </div>
                </div>
              );
            })}
          </div>
          {Array.isArray(preview.edges) && preview.edges.length > 0 && (
            <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", paddingTop: 4, borderTop: "0.5px dashed var(--color-border-tertiary)" }}>
              {preview.edges.length} edge{preview.edges.length > 1 ? "s" : ""}: {preview.edges.slice(0, 3).map(e => e.label || "—").join(", ")}{preview.edges.length > 3 ? "…" : ""}
            </div>
          )}
        </div>
      )}

      {/* Input area */}
      <div style={{ padding: "8px 10px 10px", display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea
          value={text}
          onChange={e => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === "Escape") onClose(); }}
          placeholder={phase === "preview" ? "Ask follow-up or apply…" : "What should change? (Enter to send)"}
          rows={2}
          autoFocus
          style={{ flex: 1, fontFamily: "inherit", fontSize: 12, lineHeight: 1.5, padding: "6px 10px", borderRadius: 8, border: "0.5px solid " + accent + "55", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", resize: "none", outline: "none", minHeight: 48, maxHeight: 120 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {phase === "preview" && (
            <button onClick={confirm} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 7, border: "none", background: accent, color: "#fff", cursor: "pointer", whiteSpace: "nowrap" }}>
              Apply
            </button>
          )}
          <button onClick={submit} disabled={phase === "thinking" || !text.trim()}
            style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 7, border: "none", background: phase === "preview" ? "var(--color-background-secondary)" : accent, color: phase === "preview" ? "var(--color-text-secondary)" : "#fff", cursor: phase === "thinking" || !text.trim() ? "default" : "pointer", opacity: phase === "thinking" || !text.trim() ? 0.4 : 1, whiteSpace: "nowrap" }}>
            {phase === "thinking" ? "…" : phase === "preview" ? "re-ask" : "go"}
          </button>
        </div>
      </div>
    </div>
  );
}
