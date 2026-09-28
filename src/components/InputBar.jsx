import { useState, useEffect } from "react";
import { api, getText, parseJ } from "../lib/api";
import { CC, NC, IS_TOUCH } from "../lib/constants";

export default function InputBar({
  topic, nodes, accent, onResult, selNodes, onMerge, onSplitResult,
  onGroupSummary, onFuse, fusePhase,
}) {
  const [text, setText]       = useState("");
  const [mode, setMode]       = useState("note");
  const [phase, setPhase]     = useState("idle");
  const [preview, setPreview] = useState(null);
  const selNode    = selNodes.length === 1 ? selNodes[0] : null;
  const bothSel    = selNodes.length === 2;
  const nodeMode   = selNodes.length === 1;
  const multiMode  = selNodes.length > 2;

  const submitNote = async () => {
    setPhase("thinking");
    try {
      const ctx = Object.values(nodes).map(n => "id:\"" + n.id + "\" title:\"" + n.title + "\"").join("\n") || "(none)";
      const prompt = "You are turning a user's free-form thought into a small knowledge graph for topic \"" + topic + "\".\n\n"
        + "Existing nodes in this topic:\n" + ctx + "\n\n"
        + "User input:\n\"" + text + "\"\n\n"
        + "Break the input into 1-6 distinct concepts. For EACH concept decide ONE of:\n"
        + "  - \"new\": create a new node (default when the concept doesn't match any existing node).\n"
        + "  - \"update\": the concept elaborates an existing node (use its id).\n"
        + "  - \"conflict\": the concept contradicts an existing node (use its id).\n\n"
        + "Also propose edges connecting NEW concepts to each other OR to existing nodes when a clear relationship exists. Edges reference tempIds for new nodes or existing node ids.\n\n"
        + "If the input is a single simple thought, return exactly ONE item. Do not pad.\n\n"
        + "Return ONLY valid JSON, no prose:\n"
        + "{\"items\":[{\"tempId\":\"n1\",\"action\":\"new\"|\"update\"|\"conflict\",\"targetId\":\"existing id or null\",\"title\":\"short title (new only)\",\"body\":\"1-3 short markdown lines\",\"conflictLabel\":\"short phrase or null\"}],"
        + "\"edges\":[{\"from\":\"tempId or existing id\",\"to\":\"tempId or existing id\",\"label\":\"short relation\"}],"
        + "\"reasoning\":\"one sentence about how you split the input\"}";
      const d = await api([{ role: "user", content: prompt }], null, 4096);
      const p = parseJ(getText(d));
      if (p && Array.isArray(p.items) && p.items.length > 0) {
        setPreview(Object.assign({}, p, { inputText: text }));
        setPhase("preview");
      } else setPhase("idle");
    } catch (e) { setPhase("idle"); }
  };

  const submitAction = async (actionType, extraText) => {
    if (!selNode) return;
    setPhase("thinking");
    try {
      let prompt, maxTok;
      if (actionType === "split") {
        prompt = "Split this knowledge node into 2-4 focused sub-topics. The original node should keep a short summary.\n\nTitle: \"" + selNode.title + "\"\nBody:\n" + selNode.body + "\n\nReturn ONLY this JSON (no fences):\n{\"updatedBody\": \"short 1-2 line summary to keep on original\", \"newNodes\": [{\"title\": \"sub-topic title\", \"body\": \"bullet markdown content\", \"edgeLabel\": \"relation to original\"}]}";
        maxTok = 900;
      } else if (actionType === "rewrite") {
        prompt = "Rewrite this node's body to be clearer, more concise, and better structured as markdown bullets.\n\nTitle: \"" + selNode.title + "\"\nBody:\n" + selNode.body + "\n\nReturn ONLY this JSON (no fences):\n{\"updatedBody\": \"rewritten markdown body\"}";
        maxTok = 700;
      } else { // append
        prompt = "Append the following new information to the existing node body. Integrate naturally, keep bullet format.\n\nTitle: \"" + selNode.title + "\"\nExisting body:\n" + selNode.body + "\n\nNew information to add:\n\"" + extraText + "\"\n\nReturn ONLY this JSON (no fences):\n{\"updatedBody\": \"full updated body including original + new content\"}";
        maxTok = 800;
      }
      const d = await api([{ role: "user", content: prompt }], null, maxTok);
      const raw = getText(d);
      let p = parseJ(raw);
      // Fallback regex extraction
      if (!p) {
        const ub = raw.match(/"updatedBody"\s*:\s*"([\s\S]+?)"\s*[,}]/);
        if (ub) p = { updatedBody: ub[1].replace(/\\n/g, "\n") };
      }
      if (p) onSplitResult(selNode.id, Object.assign({ action: actionType }, p));
      setText(""); setPhase("idle");
    } catch (e) { setPhase("idle"); }
  };

  const submitNodeCmd = async (cmd) => {
    if (!selNode || !cmd.trim()) return;
    // If text starts with "Append: ", extract the append content
    const appendMatch = cmd.match(/^[Aa]ppend:?\s*([\s\S]+)/);
    if (appendMatch) return submitAction("append", appendMatch[1].trim());
    // Otherwise treat as a free-form rewrite instruction
    setPhase("thinking");
    try {
      const prompt = "Apply this instruction to the node. Return ONLY JSON (no fences):\n{\"updatedBody\": \"updated markdown body\", \"newNodes\": [{\"title\": \"...\", \"body\": \"...\", \"edgeLabel\": \"...\"}]}\n\nTitle: \"" + selNode.title + "\"\nBody:\n" + selNode.body + "\n\nInstruction: \"" + cmd + "\"";
      const d = await api([{ role: "user", content: prompt }], null, 800);
      const raw = getText(d);
      let p = parseJ(raw);
      if (!p) { const ub = raw.match(/"updatedBody"\s*:\s*"([\s\S]+?)"\s*[,}]/); if (ub) p = { updatedBody: ub[1].replace(/\\n/g, "\n") }; }
      if (p) onSplitResult(selNode.id, p);
      setText(""); setPhase("idle");
    } catch (e) { setPhase("idle"); }
  };

  const submit = () => {
    if (!text.trim()) return;
    if (nodeMode) return submitNodeCmd(text);
    if (mode === "fuse") { onFuse(text); setText(""); return; }
    submitNote();
  };

  const confirm = () => { onResult(preview); setPreview(null); setText(""); setPhase("idle"); };

  const aC = { conflict: CC, update: accent, new: NC };
  const aL = { conflict: "Conflict", update: "Update", new: "New" };
  const qAs = [
    { label: "split",   title: "Split into sub-topics",       action: "split" },
    { label: "rewrite", title: "Rewrite clearer",             action: "rewrite" },
    { label: "append",  title: "Append — type what to add →", action: "append" },
  ];
  const isLoading = phase === "thinking" || (mode === "fuse" && fusePhase === "thinking");

  // iOS on-screen keyboard: keep InputBar visible by tracking visual viewport
  useEffect(() => {
    if (!IS_TOUCH || !window.visualViewport) return;
    const handler = () => {
      document.documentElement.style.setProperty("--vv-height", window.visualViewport.height + "px");
    };
    window.visualViewport.addEventListener("resize", handler);
    handler();
    return () => window.visualViewport.removeEventListener("resize", handler);
  }, []);

  return (
    <div style={{ background: "var(--color-background-primary)", borderTop: "0.5px solid var(--color-border-tertiary)", padding: IS_TOUCH ? "10px 14px env(safe-area-inset-bottom, 0px)" : "10px 14px", paddingBottom: IS_TOUCH ? "calc(10px + env(safe-area-inset-bottom, 0px))" : 10, flexShrink: 0, fontFamily: "'Inter',system-ui,sans-serif" }}>
      {bothSel && (
        <div style={{ marginBottom: 8, padding: "8px 14px", borderRadius: 10, background: "#10b98110", border: "0.5px solid #10b98144", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#10b981", flex: 1 }}>{selNodes[0].title} + {selNodes[1].title}</div>
          <button onClick={() => onMerge(selNodes[0], selNodes[1])} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "5px 16px", borderRadius: 8, border: "none", background: "#10b981", color: "#fff", cursor: "pointer" }}>AI Merge</button>
        </div>
      )}
      {multiMode && (
        <div style={{ marginBottom: 8, padding: "8px 14px", borderRadius: 10, background: accent + "0e", border: "0.5px solid " + accent + "33", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: accent, flex: 1 }}>{selNodes.length} nodes selected</div>
          <button onClick={() => { if (!text.trim()) return; onGroupSummary(selNodes, text); setText(""); }} disabled={!text.trim()}
            style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "5px 16px", borderRadius: 8, border: "none", background: text.trim() ? accent : "var(--color-background-secondary)", color: text.trim() ? "#fff" : "var(--color-text-tertiary)", cursor: text.trim() ? "pointer" : "default", transition: "all 0.15s", whiteSpace: "nowrap" }}>Group summary</button>
        </div>
      )}
      {nodeMode && (
        <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 100, background: accent + "18", color: accent, border: "0.5px solid " + accent + "44", flexShrink: 0 }}>{selNode.title}</div>
          {qAs.map(qa => (
            <button key={qa.label} title={qa.title}
              onClick={() => { if (qa.action === "append") { setText("Append: "); } else { submitAction(qa.action); } }}
              disabled={phase === "thinking"}
              style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: "3px 9px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: phase === "thinking" ? "var(--color-text-tertiary)" : "var(--color-text-secondary)", cursor: phase === "thinking" ? "default" : "pointer", transition: "all 0.12s", opacity: phase === "thinking" ? 0.5 : 1 }}
              onMouseEnter={e => { if (phase !== "thinking") { e.currentTarget.style.background = "var(--color-background-secondary)"; e.currentTarget.style.color = "var(--color-text-primary)"; } }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-secondary)"; }}>
              {qa.label}
            </button>
          ))}
        </div>
      )}
      {mode === "fuse" && !nodeMode && (
        <div style={{ marginBottom: 6, padding: "7px 10px", borderRadius: 8, background: accent + "08", border: "0.5px solid " + accent + "33", fontSize: 11, color: accent, lineHeight: 1.5 }}>Paste your new notes below — AI maps them to existing knowledge. Cmd+Enter to fuse.</div>
      )}
      {phase === "preview" && preview && (
        <div style={{ marginBottom: 8, padding: "9px 12px", borderRadius: 10, background: accent + "0a", border: "0.5px solid " + accent + "33", maxHeight: 320, overflowY: "auto" }}>
          {preview.reasoning && (
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.5, marginBottom: 8, fontStyle: "italic" }}>{preview.reasoning}</div>
          )}
          {/* Editable items */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
            {preview.items.map((it, i) => {
              const color = aC[it.action] || accent;
              const targetTitle = it.targetId && nodes[it.targetId]?.title;
              const updateItem = (patch) => setPreview(prev => {
                const items = prev.items.map((x, j) => j === i ? Object.assign({}, x, patch) : x);
                return Object.assign({}, prev, { items });
              });
              const removeItem = () => setPreview(prev => Object.assign({}, prev, { items: prev.items.filter((_, j) => j !== i) }));
              return (
                <div key={i} style={{ background: "var(--color-background-primary)", border: "0.5px solid " + color + "33", borderRadius: 8, padding: "7px 9px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 100, flexShrink: 0, background: color + "18", color, border: "0.5px solid " + color + "44" }}>{aL[it.action] || "new"}</div>
                    {it.action !== "new" && targetTitle && <div style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>→ {targetTitle}</div>}
                    <button onClick={removeItem} title="Remove this item" style={{ marginLeft: "auto", fontFamily: "inherit", fontSize: 10, border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", padding: "0 2px", lineHeight: 1 }}>✕</button>
                  </div>
                  {it.action === "new" && (
                    <input
                      value={it.title || ""}
                      onChange={e => updateItem({ title: e.target.value })}
                      placeholder="Node title"
                      style={{ width: "100%", fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "3px 0", border: "none", borderBottom: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", outline: "none", marginBottom: 4, boxSizing: "border-box" }}
                    />
                  )}
                  <textarea
                    value={it.body || ""}
                    onChange={e => { updateItem({ body: e.target.value }); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                    placeholder={it.action === "new" ? "Content (markdown)" : "Text to append"}
                    rows={2}
                    style={{ width: "100%", fontFamily: "inherit", fontSize: 11, lineHeight: 1.5, padding: "3px 0", border: "none", background: "transparent", color: "var(--color-text-secondary)", outline: "none", resize: "none", overflow: "hidden", boxSizing: "border-box" }}
                  />
                </div>
              );
            })}
          </div>
          {/* Editable edges */}
          {Array.isArray(preview.edges) && preview.edges.length > 0 && (
            <div style={{ paddingTop: 6, borderTop: "0.5px dashed var(--color-border-tertiary)", marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Edges</div>
              {preview.edges.map((edge, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                  <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", flexShrink: 0 }}>→</div>
                  <input
                    value={edge.label || ""}
                    onChange={e => setPreview(prev => {
                      const edges = prev.edges.map((x, j) => j === i ? Object.assign({}, x, { label: e.target.value }) : x);
                      return Object.assign({}, prev, { edges });
                    })}
                    placeholder="edge label"
                    style={{ flex: 1, fontFamily: "inherit", fontSize: 10, padding: "2px 6px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", outline: "none" }}
                  />
                  <button onClick={() => setPreview(prev => Object.assign({}, prev, { edges: prev.edges.filter((_, j) => j !== i) }))}
                    style={{ fontFamily: "inherit", fontSize: 10, border: "none", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer", padding: "0 2px" }}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7 }}>
            <button onClick={() => { setPhase("idle"); setPreview(null); }} style={{ fontFamily: "inherit", fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer" }}>✕</button>
            <button onClick={confirm} disabled={!preview.items.length} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 700, padding: "4px 16px", borderRadius: 7, border: "none", background: preview.items.length ? accent : "var(--color-background-secondary)", color: preview.items.length ? "#fff" : "var(--color-text-tertiary)", cursor: preview.items.length ? "pointer" : "default", whiteSpace: "nowrap" }}>
              Apply {preview.items.length} {preview.items.length === 1 ? "item" : "items"}
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        {selNodes.length === 0 && (
          <div style={{ display: "flex", gap: 1, background: "var(--color-background-secondary)", borderRadius: 7, padding: 3, flexShrink: 0 }}>
            {["note", "fuse"].map(m => (
              <button key={m} onClick={() => { setMode(m); setPhase("idle"); setPreview(null); }}
                style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 500, padding: "3px 8px", borderRadius: 5, border: "none", cursor: "pointer", background: mode === m ? "var(--color-background-primary)" : "transparent", color: mode === m ? "var(--color-text-primary)" : "var(--color-text-tertiary)", transition: "all 0.15s" }}>
                {m}
              </button>
            ))}
          </div>
        )}
        <textarea value={text}
          onChange={e => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, mode === "fuse" ? 180 : 110) + "px"; }}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey && mode !== "fuse") { e.preventDefault(); submit(); }
            if (e.key === "Enter" && e.metaKey && mode === "fuse") { e.preventDefault(); submit(); }
          }}
          placeholder={multiMode ? "Describe this group..." : nodeMode ? "Type command..." : mode === "fuse" ? "Paste new notes (Cmd+Enter to fuse)..." : "Drop a thought..."}
          rows={1}
          style={{ flex: 1, fontFamily: "inherit", fontSize: 13, lineHeight: 1.6, padding: "7px 12px", borderRadius: 9, border: "0.5px solid " + (mode === "fuse" || nodeMode || multiMode ? accent + "88" : "var(--color-border-secondary)"), background: "var(--color-background-secondary)", color: "var(--color-text-primary)", resize: "none", outline: "none", minHeight: mode === "fuse" ? 72 : 36, maxHeight: mode === "fuse" ? 180 : 110, overflow: "hidden", transition: "border-color 0.2s,min-height 0.2s" }} />
        <button onClick={submit} disabled={isLoading || !text.trim()}
          style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 16px", borderRadius: 9, border: "none", background: accent, color: "#fff", cursor: "pointer", flexShrink: 0, opacity: isLoading || !text.trim() ? 0.4 : 1, transition: "opacity 0.15s" }}>
          {isLoading ? "..." : mode === "fuse" ? "fuse" : "go"}
        </button>
      </div>
    </div>
  );
}
