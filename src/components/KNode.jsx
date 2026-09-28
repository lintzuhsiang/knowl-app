import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import MD from "./MD";
import SelectionToolbar from "./SelectionToolbar";
import { CONF_CYCLE, CONF_COLOR, CONF_LABEL, CC, NC, NW, IS_TOUCH } from "../lib/constants";
import { nodeW, nodeH, getAnchors } from "../lib/utils";
import { api, getText } from "../lib/api";

/**
 * Automatically infer a node's display type from its body content.
 * This replaces manual type-cycling — nodes adapt their renderer to their data.
 *   data:audio…  → "audio"
 *   data:image… or http…image-ext  → "image"
 *   https?://…   → "link"
 *   lines with [box]-->…  → "diagram"
 *   lines with |col|col|  → "table"
 *   everything else       → "text"
 */
function detectNodeType(body) {
  if (!body) return "text";
  const lines = body.split("\n");
  const first = lines[0]?.trim() || "";
  if (first.startsWith("data:audio")) return "audio";
  if (first.startsWith("data:image")) return "image";
  if (/^https?:\/\//i.test(first)) {
    if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?.*)?$/i.test(first)) return "image";
    return "link";
  }
  const content = lines.filter(l => l.trim() && !/^#+\s/.test(l.trim()));
  const diagLines = content.filter(l => /\[.+\]/.test(l) && /--|->/.test(l));
  if (diagLines.length >= 1 && content.length > 0 && diagLines.length / content.length >= 0.3) return "diagram";
  const tableLines = content.filter(l => l.trim().startsWith("|"));
  if (tableLines.length >= 2) return "table";
  return "text";
}

export default function KNode({
  node, accent, sel, hov, mergeTarget, compact, highlighted, dimmed, dragging,
  isParent, bookmarked, overridePos, swimlaneOpen, swimlaneChildCount,
  onToggleSwimlane, onDown, onEnter, onLeave, onClick, onDbl, onConflict,
  onAnchorDown, onSelectionAction, onNavigateToRelated,
  onConfidenceChange, onResizeStart, onToggleCollapse,
  onBookmark, onChangeNodeType, onColorChange, onTagChange, editRequested, onNodeContextMenu, onDrillIn,
}) {
  const [editing, setEditing]     = useState(false);
  const [draft, setDraft]         = useState(node.body);
  const [selToolbar, setSelToolbar] = useState(null);
  const [tbLoading, setTbLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [hoverRect, setHoverRect] = useState(null); // for hover preview portals
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState(null);
  const taRef = useRef(null), cRef = useRef(null), colorRef = useRef(null);
  const colorDotRef = useRef(null);
  const recorderRef = useRef(null), chunksRef = useRef([]);
  const draftRef = useRef(draft); draftRef.current = draft;

  useEffect(() => { if (!editing) setDraft(node.body); }, [node.body, editing]);

  // Touch double-tap → enter edit mode
  useEffect(() => { if (editRequested && !editing) setEditing(true); }, [editRequested]);

  // Cleanup MediaRecorder on unmount to avoid orphaned mic streams
  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
    };
  }, []);
  useEffect(() => {
    if (editing && taRef.current) {
      const t = taRef.current; t.focus(); t.style.height = "auto"; t.style.height = t.scrollHeight + "px";
    }
  }, [editing]);
  const commit = () => { setEditing(false); setSelToolbar(null); onDbl(node.id, draft); };

  // Strip leading heading from display if it duplicates the node title
  const displayBody = (() => {
    const text = draft || '';
    const nl = text.indexOf('\n');
    const firstLine = nl === -1 ? text : text.slice(0, nl);
    if (/^#+\s/.test(firstLine)) {
      const headingText = firstLine.replace(/^#+\s*/, '').trim();
      if (headingText.toLowerCase() === (node.title || '').toLowerCase()) {
        return nl === -1 ? '' : text.slice(nl + 1);
      }
    }
    return text;
  })();

  /* ── Image paste handler ─────────────────────────────────────────────── */
  const handlePaste = useCallback((e) => {
    // Allow image paste on any node — body will auto-detect as image type after paste
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => {
          const lines = (draftRef.current || "").split("\n");
          const caption = lines.slice(1).join("\n");
          const newBody = reader.result + (caption ? "\n" + caption : "");
          setDraft(newBody);
          onDbl(node.id, newBody);
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }, [node.nodeType, node.id, onDbl]);

  /* ── Audio record handlers ───────────────────────────────────────────── */
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4" });
      chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const fr = new FileReader();
        fr.onload = () => {
          const lines = (draftRef.current || "").split("\n");
          const caption = lines.slice(1).join("\n");
          const newBody = fr.result + (caption ? "\n" + caption : "");
          setDraft(newBody);
          onDbl(node.id, newBody);
        };
        fr.readAsDataURL(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) { console.error("Mic access denied:", err); }
  }, [node.id, onDbl]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
      setRecording(false);
    }
  }, []);

  /* ── AI audio transcription via Gemini (multimodal) ────────────────── */
  const transcribeAudio = useCallback(async () => {
    const lines = (draft || "").split("\n");
    const src = lines[0]?.trim();
    if (!src || !src.startsWith("data:audio")) return;
    setTranscribing(true);
    try {
      const match = src.match(/^data:(audio\/[^;]+);base64,(.+)$/);
      if (!match) { setTranscribing(false); return; }
      const [, mime, b64] = match;
      const GEMINI_URL = `/api/gemini/v1beta/models/gemini-2.5-pro:generateContent`;
      const resp = await fetch(`${GEMINI_URL}?key=${import.meta.env.VITE_ANTHROPIC_API_KEY || ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: "Transcribe this audio recording verbatim. Return ONLY the transcribed text, nothing else." }
          ]}],
          generationConfig: { maxOutputTokens: 1000 },
          systemInstruction: { parts: [{ text: "You are a transcription assistant. Output only the transcribed text, no commentary." }] },
        }),
      }).then(r => r.json());
      const text = resp.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (text) {
        const newBody = src + "\n" + text.trim();
        setDraft(newBody);
        onDbl(node.id, newBody);
      }
    } catch (err) { console.error("Transcription failed:", err); }
    setTranscribing(false);
  }, [draft, node.id, onDbl]);

  /* ── AI audio summarize: extract key points from transcript ────────────── */
  const summarizeAudio = useCallback(async () => {
    const lines = (draftRef.current || "").split("\n");
    const src = lines[0]?.trim();
    const transcription = lines.slice(1).join("\n").trim();
    if (!transcription || transcription.includes("## Key Points")) return;
    setSummarizing(true);
    try {
      const d = await api([{ role: "user", content: "Extract the key points and insights from this audio transcript. Be concise.\n\nTranscript:\n" + transcription + "\n\nReturn ONLY a markdown bullet list (- point). No preamble, no headings." }], null, 400);
      const bullets = getText(d).trim();
      if (bullets) {
        const newBody = src + "\n## Key Points\n" + bullets + "\n\n**Full transcript:**\n" + transcription;
        setDraft(newBody);
        onDbl(node.id, newBody);
      }
    } catch (err) { console.error("Summarize failed:", err); }
    setSummarizing(false);
  }, [node.id, onDbl]);

  useEffect(() => {
    if (!editing || !taRef.current) return;
    const ta = taRef.current;
    const timers = [];
    const read = () => {
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (s === e) { setSelToolbar(null); return; }
      const t = ta.value.slice(s, e).trim();
      if (!t) { setSelToolbar(null); return; }
      const r = ta.getBoundingClientRect();
      setSelToolbar({ x: r.right, y: r.top + r.height / 2, text: t });
    };
    const mu = () => { timers.push(setTimeout(read, 10)); };
    const ku = () => { timers.push(setTimeout(read, 10)); };
    ta.addEventListener("mouseup", mu); ta.addEventListener("keyup", ku);
    return () => { ta.removeEventListener("mouseup", mu); ta.removeEventListener("keyup", ku); timers.forEach(clearTimeout); };
  }, [editing]);

  useEffect(() => {
    if (!selToolbar) return;
    const fn = e => { if (cRef.current && !cRef.current.contains(e.target)) setSelToolbar(null); };
    setTimeout(() => document.addEventListener("mousedown", fn), 50);
    return () => document.removeEventListener("mousedown", fn);
  }, [selToolbar]);

  const handleTb = async (action, text) => {
    setTbLoading(true);
    await onSelectionAction(action, text, node, draft, (u) => { if (u !== undefined) { setDraft(u); onDbl(node.id, u); } });
    setSelToolbar(null); setTbLoading(false);
  };

  const cycleConf = e => {
    e.stopPropagation();
    const ci = CONF_CYCLE.indexOf(node.confidence || null);
    onConfidenceChange(node.id, CONF_CYCLE[(ci + 1) % CONF_CYCLE.length]);
  };

  // Auto-detect type from body content — drives all rendering below
  const effectiveType = detectNodeType(draft || node.body);

  const hc = node.conflict && node.conflict.status === "unresolved";
  const w = nodeW(node), h = nodeH(node);
  const nodeColor = node.color || null; // custom color tint
  const bc = highlighted ? "#f59e0b" : mergeTarget ? "#10b981" : hc ? CC : nodeColor ? nodeColor : node.tag === "new-domain" ? NC : sel ? accent : hov ? accent + "99" : "var(--color-border-tertiary)";
  const NODE_COLORS = ["#6366f1","#10b981","#f59e0b","#ef4444","#8b5cf6","#0891b2","#e11d48","#64748b","#f97316","#84cc16"];
  // Anchor dot positioning. Use edge-relative CSS (bottom/right: -half, marginTop: -half)
  // so the dots always sit centered on the rendered border. Nodes auto-size vertically
  // based on content, so the stored `h` can diverge from the actual height — px-based
  // top/left values would put the bottom dot inside the card when content overflows.
  const anchorSize = IS_TOUCH ? 28 : 12;
  const halfA = anchorSize / 2;
  const apos = {
    top:    { left: w / 2 - halfA, top: -halfA },
    right:  { right: -halfA, top: "50%", marginTop: -halfA },
    bottom: { left: w / 2 - halfA, bottom: -halfA },
    left:   { left: -halfA, top: "50%", marginTop: -halfA },
  };
  const hlS   = highlighted ? "0 0 0 3px rgba(245,158,11,0.2),0 0 16px rgba(245,158,11,0.1)," : "";
  const baseS = mergeTarget ? "0 0 0 5px #10b98140,0 0 24px #10b98128" : sel ? "0 0 0 3px " + accent + "28" : hov ? "0 4px 20px " + accent + "14" : "0 1px 8px rgba(0,0,0,0.06)";

  const resizeHandles = [
    { dir: "e",  style: { right: -4, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" } },
    { dir: "w",  style: { left: -4,  top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" } },
    { dir: "s",  style: { bottom: -4, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" } },
    { dir: "n",  style: { top: -4,   left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" } },
    { dir: "se", style: { right: -4, bottom: -4, cursor: "nwse-resize" } },
    { dir: "sw", style: { left: -4,  bottom: -4, cursor: "nesw-resize" } },
    { dir: "ne", style: { right: -4, top: -4,    cursor: "nesw-resize" } },
    { dir: "nw", style: { left: -4,  top: -4,    cursor: "nwse-resize" } },
  ];

  const posX = overridePos?.x ?? node.x;
  const posY = overridePos?.y ?? node.y;

  if (compact) return (
    <div onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onDown(e, node.id); }}
      onMouseEnter={onEnter} onMouseLeave={onLeave}
      onClick={e => { e.stopPropagation(); onClick(); }}
      style={{ position: "absolute", left: posX, top: posY, width: w, background: "var(--color-background-primary)", border: "1.5px solid " + bc, borderRadius: 10, padding: "8px 12px", fontFamily: "'Inter',system-ui,sans-serif", cursor: dragging ? "grabbing" : "grab", userSelect: "none", zIndex: sel ? 20 : hov ? 10 : 1, boxShadow: highlighted ? hlS + "0 1px 8px rgba(0,0,0,0.06)" : baseS, display: "flex", alignItems: "center", gap: 8, transition: "border-color 0.15s,box-shadow 0.2s,opacity 0.3s", animation: highlighted ? "highlightPulse 1s ease 3" : "none", opacity: dimmed ? 0.2 : 1, pointerEvents: dimmed ? "none" : "auto" }}>
      {bookmarked && <span style={{ fontSize: 9, color: "#f59e0b", flexShrink: 0 }}>{"\u2605"}</span>}
      {hc && <div style={{ width: 6, height: 6, borderRadius: "50%", background: CC, flexShrink: 0 }} />}
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)", flexShrink: 0, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.title}</div>
      {node.summary
        ? <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.summary}</div>
        : <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", opacity: 0.4, fontStyle: "italic" }}>...</div>}
    </div>
  );

  return (
    <>
      <div ref={cRef}
        data-nodeid={node.id}
        onMouseDown={e => {
          // Always fire onDown (drag is always allowed, even while editing body text).
          // The body textarea calls e.stopPropagation only for its own text events.
          // We don't preventDefault here when editing so the textarea keeps focus.
          if (!editing) e.preventDefault();
          e.stopPropagation();
          onDown(e, node.id);
        }}
        onMouseEnter={e => { onEnter(e); }}
        onMouseLeave={e => { setHoverRect(null); onLeave(e); }}
        onClick={e => { e.stopPropagation(); onClick(); }}
        onDoubleClick={e => { e.stopPropagation(); if (onDrillIn) onDrillIn(node.id, node.title); }}
        onContextMenu={e => { if (onNodeContextMenu) { e.preventDefault(); e.stopPropagation(); onNodeContextMenu(e, node.id); } }}
        onPaste={handlePaste}
        style={{ position: "absolute", left: posX, top: posY, width: w, background: nodeColor ? nodeColor + "08" : "var(--color-background-primary)", border: "1.5px solid " + bc, borderRadius: 14, padding: "14px 16px", fontFamily: "'Inter',system-ui,sans-serif", cursor: editing ? (dragging ? "grabbing" : "grab") : dragging ? "grabbing" : "grab", userSelect: "none", zIndex: sel ? 20 : hov ? 10 : 1, boxShadow: dragging ? "0 8px 30px rgba(0,0,0,0.18)," + baseS : highlighted ? hlS + baseS : baseS, transform: dragging ? "scale(1.03)" : "none", transition: dragging ? "none" : "border-color 0.15s,box-shadow 0.2s,opacity 0.3s,transform 0.15s", animation: highlighted ? "highlightPulse 1s ease 3" : "none", opacity: dimmed ? 0.2 : 1, pointerEvents: dimmed ? "none" : "auto" }}>

        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-tertiary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.title}</div>
          <div style={{ display: "flex", gap: 3, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
            {onBookmark && <div onClick={e => { e.stopPropagation(); onBookmark(node.id); }} title={bookmarked ? "Remove bookmark" : "Bookmark"}
              style={{ fontSize: 10, cursor: "pointer", color: bookmarked ? "#f59e0b" : "var(--color-text-tertiary)", padding: "0 2px", transition: "color 0.15s" }}
              onMouseEnter={e => { if (!bookmarked) e.currentTarget.style.color = "#f59e0b"; }}
              onMouseLeave={e => { if (!bookmarked) e.currentTarget.style.color = "var(--color-text-tertiary)"; }}>{bookmarked ? "\u2605" : "\u2606"}</div>}
            {/* Node type badge — auto-detected from body content, read-only indicator */}
            {effectiveType !== "text" && (() => {
              const tc = { diagram: "#7c3aed", table: "#0891b2", image: "#e11d48", link: "#2563eb", audio: "#059669" }[effectiveType] || "#94a3b8";
              const typeIcon = { diagram: "△", table: "▦", image: "🖼", link: "🔗", audio: "🎤" }[effectiveType];
              return (
                <div title={"Auto-detected type: " + effectiveType}
                  style={{ fontSize: 8, fontWeight: 700, padding: "2px 7px", borderRadius: 100, background: tc + "18", color: tc, border: "0.5px solid " + tc + "44", whiteSpace: "nowrap", userSelect: "none" }}>
                  {typeIcon} {effectiveType}
                </div>
              );
            })()}
            {/* Mic button — visible on hover/select, lets any node become an audio node */}
            {(hov || sel) && !recording && effectiveType !== "audio" && (
              <div onClick={e => { e.stopPropagation(); startRecording(); }}
                title="Record voice memo (node will auto-detect as audio)"
                style={{ fontSize: 9, cursor: "pointer", color: "var(--color-text-tertiary)", padding: "1px 3px", borderRadius: 4, transition: "color 0.12s" }}
                onMouseEnter={e => { e.currentTarget.style.color = "#059669"; }}
                onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-tertiary)"; }}>🎤</div>
            )}
            {recording && (
              <div onClick={e => { e.stopPropagation(); stopRecording(); }}
                title="Stop recording"
                style={{ fontSize: 9, cursor: "pointer", color: "#ef4444", padding: "1px 4px", borderRadius: 4, background: "#ef444418", border: "0.5px solid #ef444444", animation: "pulse 1s infinite" }}>⏹ stop</div>
            )}
            {/* Drill-in hint — double-click the node to enter its sub-canvas */}
            {/* Color dot — always visible, click to open picker */}
            {onColorChange && (
              <div ref={colorDotRef} onClick={e => { e.stopPropagation(); const rect = colorDotRef.current?.getBoundingClientRect(); if (colorPickerOpen) { setColorPickerOpen(false); setPickerPos(null); } else { setPickerPos(rect || null); setColorPickerOpen(true); } }}
                title={nodeColor ? "Color/label (click to change)" : "Set color label (click)"}
                style={{ width: 12, height: 12, borderRadius: "50%", background: nodeColor || "#94a3b8", cursor: "pointer", border: "2px solid " + (nodeColor ? nodeColor + "99" : "#64748b"), transition: "transform 0.1s", flexShrink: 0, boxShadow: nodeColor ? "0 0 0 1px " + nodeColor + "44" : "none" }}
                onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.35)"; }}
                onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }} />
            )}
            {colorPickerOpen && pickerPos && createPortal(
              <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
                style={{ position: "fixed", left: Math.min(pickerPos.left, window.innerWidth - 180), top: pickerPos.bottom + 8, zIndex: 99999, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: 172, fontFamily: "'Inter',system-ui,sans-serif", animation: "fadeIn 0.12s ease" }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: "#64748b", marginBottom: 7, letterSpacing: "0.06em", textTransform: "uppercase" }}>Node color</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 9 }}>
                  {NODE_COLORS.map(c => (
                    <div key={c} onClick={() => { onColorChange(node.id, nodeColor === c ? null : c); setColorPickerOpen(false); setPickerPos(null); }}
                      style={{ width: 22, height: 22, borderRadius: 7, background: c, cursor: "pointer", border: nodeColor === c ? "2.5px solid var(--color-text-primary)" : "2px solid transparent", transition: "transform 0.1s", boxSizing: "border-box" }}
                      onMouseEnter={e => e.currentTarget.style.transform = "scale(1.2)"}
                      onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"} />
                  ))}
                  {nodeColor && <div onClick={() => { onColorChange(node.id, null); setColorPickerOpen(false); setPickerPos(null); }}
                    title="Remove color" style={{ width: 22, height: 22, borderRadius: 7, background: "var(--color-background-secondary)", cursor: "pointer", border: "1.5px dashed var(--color-border-secondary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--color-text-tertiary)" }}>✕</div>}
                </div>
                <input placeholder="Category tag…"
                  value={node.category || ""}
                  onChange={e => onColorChange(node.id, nodeColor, e.target.value)}
                  style={{ width: "100%", fontSize: 10, padding: "4px 7px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#f8fafc", color: "#0f172a", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                <div style={{ fontSize: 9, fontWeight: 600, color: "#64748b", margin: "9px 0 5px", letterSpacing: "0.06em", textTransform: "uppercase" }}>Confidence</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {CONF_CYCLE.filter(Boolean).map(c => (
                    <div key={c} onClick={() => { onConfidenceChange(node.id, node.confidence === c ? null : c); setColorPickerOpen(false); setPickerPos(null); }}
                      style={{ fontSize: 8, fontWeight: 700, padding: "2px 7px", borderRadius: 100, cursor: "pointer", background: CONF_COLOR[c] + (node.confidence === c ? "30" : "14"), color: CONF_COLOR[c], border: "0.5px solid " + CONF_COLOR[c] + (node.confidence === c ? "66" : "33"), whiteSpace: "nowrap", transition: "all 0.12s" }}>
                      {CONF_LABEL[c]}
                    </div>
                  ))}
                </div>
              </div>,
              document.body
            )}
            {/* Confidence badge (when set) – click cycles */}
            {node.confidence && (
              <div onClick={cycleConf} title="Cycle confidence"
                style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, cursor: "pointer", background: CONF_COLOR[node.confidence] + "18", color: CONF_COLOR[node.confidence], border: "0.5px solid " + CONF_COLOR[node.confidence] + "44", whiteSpace: "nowrap", transition: "all 0.15s" }}>
                {CONF_LABEL[node.confidence]}
              </div>
            )}
            {node.relatedTo && (
              <div onClick={e => { e.stopPropagation(); onNavigateToRelated(node.relatedTo); }}
                style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, background: "#6366f118", color: "#6366f1", border: "0.5px solid #6366f144", whiteSpace: "nowrap", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "#6366f130"}
                onMouseLeave={e => e.currentTarget.style.background = "#6366f118"}>related</div>
            )}
            {hc && (
              <div onClick={e => { e.stopPropagation(); onConflict(node); }}
                style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 6px", borderRadius: 100, background: CC + "18", color: CC, border: "0.5px solid " + CC + "44", cursor: "pointer", whiteSpace: "nowrap" }}>conflict</div>
            )}
            {node.tag === "new-domain" && <div onClick={e => { e.stopPropagation(); if (onTagChange) onTagChange(node.id, "reviewed"); }} title="Mark as reviewed" style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, background: NC + "18", color: NC, border: "0.5px solid " + NC + "44", whiteSpace: "nowrap", cursor: onTagChange ? "pointer" : "default" }}>new</div>}
            {node.tag === "reviewed" && <div onClick={e => { e.stopPropagation(); if (onTagChange) onTagChange(node.id, "core"); }} title="Clear tag" style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, background: "#64748b18", color: "#64748b", border: "0.5px solid #64748b44", whiteSpace: "nowrap", cursor: onTagChange ? "pointer" : "default" }}>✓</div>}
            {node.conflict?.status === "merged"    && <div style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, background: "#05996918", color: NC, whiteSpace: "nowrap" }}>merged</div>}
            {node.conflict?.status === "dialectic" && <div style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, background: "#7c3aed18", color: "#7c3aed", whiteSpace: "nowrap" }}>dialectic</div>}
            {node.category && <div style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, background: (nodeColor || accent) + "18", color: nodeColor || accent, border: "0.5px solid " + (nodeColor || accent) + "44", whiteSpace: "nowrap", maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis" }} title={node.category}>{node.category}</div>}
            {node.parentId && <div style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 100, background: accent + "18", color: accent, border: "0.5px solid " + accent + "33", whiteSpace: "nowrap" }}>child</div>}
            {swimlaneChildCount > 0 && onToggleSwimlane && (
              <div onClick={e => { e.stopPropagation(); onToggleSwimlane(node.id); }}
                title={swimlaneOpen ? "Collapse children (hide sub-nodes)" : "Expand children — show " + swimlaneChildCount + " sub-node" + (swimlaneChildCount > 1 ? "s" : "") + " below"}
                style={{ fontSize: 8, fontWeight: 700, padding: "2px 8px", borderRadius: 100, background: swimlaneOpen ? accent + "22" : accent + "10", color: accent, border: "0.5px solid " + accent + (swimlaneOpen ? "66" : "33"), whiteSpace: "nowrap", cursor: "pointer", transition: "all 0.15s", userSelect: "none", display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ fontSize: 9 }}>{swimlaneOpen ? "▾" : "▸"}</span>
                <span>{swimlaneChildCount} child{swimlaneChildCount > 1 ? "ren" : ""}</span>
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        {editing
          ? <>
              {(effectiveType === "image" || effectiveType === "link") && (
                <div style={{ fontSize: 9, color: effectiveType === "image" ? "#e11d48" : "#2563eb", marginBottom: 4, padding: "3px 0", opacity: 0.7 }}>
                  {effectiveType === "image" ? "Line 1: image URL or paste. Lines below: caption." : "Line 1: https://... URL. Lines below: description."}
                </div>
              )}
              {effectiveType === "text" && (
                <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", marginBottom: 4, padding: "3px 0", opacity: 0.6 }}>
                  Tip: Start with https:// → link node · data:image → image · [A]→[B] → diagram · |col|col| → table
                </div>
              )}
              <textarea ref={taRef} value={draft}
                onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                onBlur={e => { if (!e.relatedTarget || !cRef.current?.contains(e.relatedTarget)) commit(); }}
                onKeyDown={e => { if (e.key === "Escape") commit(); }}
                onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
                style={{ width: "100%", minHeight: 80, fontFamily: "'Fira Code',monospace", fontSize: 11, lineHeight: 1.7, padding: "4px 0", border: "none", background: "transparent", color: "var(--color-text-primary)", resize: "none", outline: "none", display: "block", userSelect: "text" }} />
            </>
          : effectiveType === "diagram"
            ? <div style={{ pointerEvents: "none", padding: "6px 0" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#7c3aed", marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>{"\u25b3"} Diagram</div>
                <div style={{ background: "#7c3aed08", border: "1px dashed #7c3aed33", borderRadius: 8, padding: "8px 10px" }}>
                  {draft.replace(/^#+ .+\n?/, "").split("\n").map((line, i) => {
                    const trimmed = line.trim();
                    if (!trimmed) return null;
                    /* Lines with arrows: [A] --> [B] --> [C] */
                    if (/\[.+\]/.test(trimmed) && /--|->/.test(trimmed)) {
                      const parts = trimmed.split(/\s*-+>\s*/);
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
                          {parts.map((p, j) => {
                            const boxMatch = p.match(/^\[(.+)\]$/);
                            const label = boxMatch ? boxMatch[1] : p;
                            return (
                              <span key={j} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                {j > 0 && <span style={{ fontSize: 11, color: "#7c3aed", fontWeight: 700 }}>{"\u2192"}</span>}
                                <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, border: "1.5px solid #7c3aed55", background: "#7c3aed12", fontSize: 10, fontWeight: 600, color: "#7c3aed", fontFamily: "'Inter',system-ui,sans-serif", whiteSpace: "nowrap" }}>{label}</span>
                              </span>
                            );
                          })}
                        </div>
                      );
                    }
                    /* Standalone box: [Decision] */
                    if (/^\[.+\]$/.test(trimmed)) {
                      const label = trimmed.slice(1, -1);
                      return (
                        <div key={i} style={{ marginBottom: 4 }}>
                          <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, border: "1.5px solid #7c3aed55", background: "#7c3aed12", fontSize: 10, fontWeight: 600, color: "#7c3aed", fontFamily: "'Inter',system-ui,sans-serif" }}>{label}</span>
                        </div>
                      );
                    }
                    /* Branch lines: | Yes --> [A] */
                    if (/^\|/.test(trimmed)) {
                      const branchContent = trimmed.slice(1).trim();
                      const branchParts = branchContent.split(/\s*-+>\s*/);
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, paddingLeft: 16 }}>
                          <span style={{ fontSize: 10, color: "#7c3aed88", fontFamily: "'Fira Code',monospace" }}>{"\u2502"}</span>
                          {branchParts.map((p, j) => {
                            const boxMatch = p.match(/^\[(.+)\]$/);
                            if (boxMatch) {
                              return (
                                <span key={j} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  {j > 0 && <span style={{ fontSize: 11, color: "#7c3aed", fontWeight: 700 }}>{"\u2192"}</span>}
                                  <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, border: "1.5px solid #7c3aed55", background: "#7c3aed12", fontSize: 10, fontWeight: 600, color: "#7c3aed", fontFamily: "'Inter',system-ui,sans-serif", whiteSpace: "nowrap" }}>{boxMatch[1]}</span>
                                </span>
                              );
                            }
                            return (
                              <span key={j} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                {j > 0 && <span style={{ fontSize: 11, color: "#7c3aed", fontWeight: 700 }}>{"\u2192"}</span>}
                                <span style={{ fontSize: 10, color: "#7c3aed", fontFamily: "'Fira Code',monospace", fontStyle: "italic" }}>{p}</span>
                              </span>
                            );
                          })}
                        </div>
                      );
                    }
                    /* Fallback: plain monospace text */
                    return <div key={i} style={{ fontFamily: "'Fira Code',monospace", fontSize: 10, lineHeight: 1.6, color: "var(--color-text-secondary)", whiteSpace: "pre-wrap" }}>{line}</div>;
                  })}
                </div>
              </div>
            : effectiveType === "table"
            ? <div style={{ pointerEvents: "none", padding: "6px 0" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#0891b2", marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>{"\u2593"} Table</div>
                {(() => {
                  const raw = draft.replace(/^#+ .+\n?/, "");
                  const lines = raw.split("\n").filter(l => l.trim());
                  const isTableSyntax = lines.length > 0 && lines.every(l => l.trim().startsWith("|"));
                  if (!isTableSyntax) {
                    return <div style={{ background: "#0891b208", border: "1px dashed #0891b233", borderRadius: 8, padding: "8px 10px", fontFamily: "'Fira Code',monospace", fontSize: 10, lineHeight: 1.6, color: "var(--color-text-secondary)", whiteSpace: "pre-wrap", overflowX: "auto" }}>{raw}</div>;
                  }
                  const parseCells = r => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
                  const isSep = r => /^\|[\s\-:|]+\|$/.test(r.trim());
                  const sepIdx = lines.findIndex(l => isSep(l));
                  const headerCells = sepIdx > 0 ? parseCells(lines[sepIdx - 1]) : null;
                  const bodyLines = headerCells ? lines.slice(sepIdx + 1) : lines;
                  return (
                    <div style={{ background: "#0891b208", border: "1px dashed #0891b233", borderRadius: 8, padding: "6px 8px", overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        {headerCells && (
                          <thead>
                            <tr>
                              {headerCells.map((c, i) => <th key={i} style={{ fontSize: 9, fontWeight: 700, color: "#0891b2", padding: "4px 8px", borderBottom: "1.5px solid #0891b244", textAlign: "left" }}>{c}</th>)}
                            </tr>
                          </thead>
                        )}
                        <tbody>
                          {bodyLines.filter(l => !isSep(l)).map((r, ri) => (
                            <tr key={ri}>
                              {parseCells(r).map((c, ci) => <td key={ci} style={{ fontSize: 10, padding: "4px 8px", borderBottom: "0.5px solid #0891b218", color: "var(--color-text-secondary)" }}>{c}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            : effectiveType === "image"
            ? <div style={{ padding: "6px 0" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#e11d48", marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>{"\ud83d\uddbc"} Image</div>
                {(() => {
                  const lines = (draft || "").split("\n");
                  const src = lines[0]?.trim();
                  const caption = lines.slice(1).join("\n").trim();
                  const isImg = src && (src.startsWith("data:image") || src.startsWith("http") || src.startsWith("blob:"));
                  return (
                    <div style={{ background: "#e11d4808", border: "1px dashed #e11d4833", borderRadius: 8, padding: "6px", overflow: "hidden" }}>
                      {isImg
                        ? <img src={src} alt={caption || node.title}
                            style={{ width: "100%", borderRadius: 6, display: "block", maxHeight: 200, objectFit: "cover", cursor: "zoom-in", transition: "box-shadow 0.15s" }}
                            onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 0 0 2.5px #e11d48aa"; setHoverRect(e.currentTarget.getBoundingClientRect()); }}
                            onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; setHoverRect(null); }} />
                        : <div onClick={e => { e.stopPropagation(); setEditing(true); }}
                            style={{ padding: "16px 12px", textAlign: "center", cursor: "pointer", color: "#e11d4888", fontSize: 10, lineHeight: 1.5 }}>
                            Paste an image (Ctrl+V) or<br />double-click to enter a URL
                          </div>}
                      {caption && <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 4, padding: "0 2px", lineHeight: 1.4 }}>{caption}</div>}
                    </div>
                  );
                })()}
              </div>
            : effectiveType === "link"
            ? <div style={{ pointerEvents: "none", padding: "6px 0" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#2563eb", marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>{"\ud83d\udd17"} Link</div>
                {(() => {
                  const lines = (draft || "").split("\n");
                  const url = lines[0]?.trim();
                  const desc = lines.slice(1).join("\n").trim();
                  const isUrl = url && (url.startsWith("http://") || url.startsWith("https://"));
                  let domain = "";
                  try { domain = isUrl ? new URL(url).hostname.replace("www.", "") : ""; } catch {}
                  return (
                    <div style={{ background: "#2563eb08", border: "1px dashed #2563eb33", borderRadius: 8, padding: "10px 12px", pointerEvents: "auto" }}>
                      {isUrl ? (
                        <>
                          <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                            style={{ fontSize: 11, fontWeight: 600, color: "#2563eb", textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", borderRadius: 4, padding: "1px 2px", transition: "background 0.15s,box-shadow 0.15s" }}
                            onMouseEnter={e => { e.currentTarget.style.textDecoration = "underline"; e.currentTarget.style.background = "#2563eb14"; e.currentTarget.style.boxShadow = "0 0 0 2px #2563eb44"; setHoverRect(e.currentTarget.getBoundingClientRect()); }}
                            onMouseLeave={e => { e.currentTarget.style.textDecoration = "none"; e.currentTarget.style.background = "transparent"; e.currentTarget.style.boxShadow = "none"; setHoverRect(null); }}>
                            {node.title || url}
                          </a>
                          <div style={{ fontSize: 9, color: "#2563eb88", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                            <img src={"https://www.google.com/s2/favicons?domain=" + domain + "&sz=16"} width={12} height={12} style={{ borderRadius: 2 }} onError={e => e.currentTarget.style.display = "none"} />
                            {domain}
                          </div>
                          {desc && <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.4 }}>{desc}</div>}
                        </>
                      ) : (
                        <div style={{ fontSize: 10, color: "#2563eb88", textAlign: "center", padding: "8px 0" }}>
                          Double-click to enter a URL
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            : effectiveType === "audio"
            ? <div style={{ padding: "6px 0" }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#059669", marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>{"\ud83c\udfa4"} Audio</div>
                {(() => {
                  const lines = (draft || "").split("\n");
                  const src = lines[0]?.trim();
                  const caption = lines.slice(1).join("\n").trim();
                  const hasAudio = src && src.startsWith("data:audio");
                  return (
                    <div style={{ background: "#05966908", border: "1px dashed #05966933", borderRadius: 8, padding: "10px 12px" }}>
                      {hasAudio && (
                        <audio controls src={src} style={{ width: "100%", height: 32, marginBottom: caption ? 6 : 0 }} onClick={e => e.stopPropagation()} />
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {recording
                          ? <button onClick={e => { e.stopPropagation(); stopRecording(); }}
                              style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 10, fontWeight: 600, padding: "4px 12px", borderRadius: 6, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, animation: "pulse 1s infinite" }}>
                              {"\u23f9"} Stop
                            </button>
                          : <button onClick={e => { e.stopPropagation(); startRecording(); }}
                              style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 10, fontWeight: 600, padding: "4px 12px", borderRadius: 6, border: "none", background: "#059669", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                              {"\u23fa"} Record
                            </button>}
                        {hasAudio && !recording && !caption && (
                          <button onClick={e => { e.stopPropagation(); transcribeAudio(); }} disabled={transcribing}
                            style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 6, border: "0.5px solid #05966944", background: transcribing ? "#05966918" : "transparent", color: "#059669", cursor: transcribing ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 4, opacity: transcribing ? 0.6 : 1 }}>
                            {transcribing ? "Transcribing..." : "\u2728 Transcribe"}
                          </button>
                        )}
                        {hasAudio && !recording && caption && !caption.includes("## Key Points") && (
                          <button onClick={e => { e.stopPropagation(); summarizeAudio(); }} disabled={summarizing}
                            style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 6, border: "0.5px solid #05966944", background: summarizing ? "#05966918" : "transparent", color: "#059669", cursor: summarizing ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 4, opacity: summarizing ? 0.6 : 1 }}>
                            {summarizing ? "Summarizing..." : "\u2728 Summarize"}
                          </button>
                        )}
                        {!hasAudio && !recording && <span style={{ fontSize: 9, color: "#05966988" }}>Click to record a voice memo</span>}
                      </div>
                      {caption && <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 6, lineHeight: 1.4, whiteSpace: "pre-wrap" }}><MD text={caption} /></div>}
                    </div>
                  );
                })()}
              </div>
            : <div
                style={{ pointerEvents: "auto", cursor: "text" }}
                onClick={e => { e.stopPropagation(); onClick(); setEditing(true); }}
                onDoubleClick={e => { e.stopPropagation(); }}
              ><MD text={displayBody} /></div>}

        {/* Entry context hint */}
        {node.entryContext?.trigger && !editing && (
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", lineHeight: 1.5, fontStyle: "italic" }}>
              Why: {node.entryContext.trigger.slice(0, 60)}{node.entryContext.trigger.length > 60 ? "..." : ""}
            </div>
          </div>
        )}

        {/* Anchor dots */}
        {(hov || sel) && ["top", "right", "bottom", "left"].map(dir => (
          <div key={dir}
            onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onAnchorDown(e, node.id, dir); }}
            onMouseEnter={e => e.currentTarget.style.transform = "scale(1.5)"}
            onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
            style={{ position: "absolute", ...apos[dir], width: anchorSize, height: anchorSize, borderRadius: "50%", background: accent, border: "2px solid var(--color-background-primary)", cursor: "crosshair", zIndex: 30, boxShadow: "0 0 0 2px " + accent + "55", transition: "transform 0.1s" }} />
        ))}

        {/* Resize handles */}
        {(hov || sel) && resizeHandles.map(rh => {
          const rs = IS_TOUCH ? 22 : 8;
          return <div key={rh.dir}
            onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onResizeStart(e, node.id, rh.dir); }}
            style={{ position: "absolute", ...rh.style, width: rs, height: rs, borderRadius: IS_TOUCH ? 4 : 2, background: "var(--color-background-primary)", border: "1.5px solid " + accent, zIndex: 32 }} />;
        })}

        {/* Node type cycle button removed — now in the header badge */}

        {/* Collapse toggle — always visible when collapsed so children can be restored;
             only visible on hover/select when expanded to avoid floating "-" artifacts */}
        {isParent && (node.collapsed || hov || sel) && (
          <div onClick={e => { e.stopPropagation(); onToggleCollapse(node.id); }} title={node.collapsed ? "Expand children" : "Collapse children"}
            style={{ position: "absolute", right: IS_TOUCH ? -18 : -10, top: h / 2 - (IS_TOUCH ? 16 : 8), width: IS_TOUCH ? 32 : 16, height: IS_TOUCH ? 32 : 16, borderRadius: "50%", background: "var(--color-background-primary)", border: "1px solid var(--color-border-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 35, fontSize: IS_TOUCH ? 14 : 9, color: "var(--color-text-tertiary)" }}>
            {node.collapsed ? "+" : "-"}
          </div>
        )}
      </div>

      {selToolbar && <SelectionToolbar x={selToolbar.x} y={selToolbar.y} text={selToolbar.text} loading={tbLoading} onAction={handleTb} />}

      {/* ── Image hover-to-enlarge preview ──────────────────────────────────── */}
      {hoverRect && effectiveType === "image" && (() => {
        const lines = (node.body || "").split("\n");
        const src = lines[0]?.trim();
        const caption = lines.slice(1).join("\n").trim();
        if (!src || !(src.startsWith("data:image") || src.startsWith("http") || src.startsWith("blob:"))) return null;
        const left = hoverRect.right + 14;
        const top = Math.min(hoverRect.top, window.innerHeight - 420);
        return createPortal(
          <div style={{ position: "fixed", left, top, zIndex: 9999, pointerEvents: "none", maxWidth: 360, animation: "fadeIn 0.15s ease" }}>
            <div style={{ background: "var(--color-background-primary)", borderRadius: 14, boxShadow: "0 12px 40px rgba(0,0,0,0.22)", overflow: "hidden", border: "0.5px solid var(--color-border-tertiary)" }}>
              <img src={src} alt={caption || node.title}
                style={{ width: "100%", display: "block", maxHeight: 360, objectFit: "contain", background: "#00000008" }} />
              {caption && (
                <div style={{ padding: "8px 14px 10px", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.4, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                  {caption}
                </div>
              )}
            </div>
          </div>,
          document.body
        );
      })()}

      {/* ── Link hover preview card ──────────────────────────────────────────── */}
      {hoverRect && effectiveType === "link" && (() => {
        const lines = (node.body || "").split("\n");
        const url = lines[0]?.trim();
        const desc = lines.slice(1).join("\n").trim();
        if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) return null;
        let domain = ""; try { domain = new URL(url).hostname.replace("www.", ""); } catch {}
        const left = hoverRect.right + 14;
        const top = Math.min(hoverRect.top, window.innerHeight - 200);
        return createPortal(
          <div style={{ position: "fixed", left, top, zIndex: 9999, pointerEvents: "none", width: 300, animation: "fadeIn 0.15s ease" }}>
            <div style={{ background: "var(--color-background-primary)", borderRadius: 14, boxShadow: "0 12px 40px rgba(0,0,0,0.18)", padding: "14px 16px", border: "0.5px solid var(--color-border-tertiary)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <img src={"https://www.google.com/s2/favicons?domain=" + domain + "&sz=32"} width={22} height={22}
                  style={{ borderRadius: 5, flexShrink: 0 }} onError={e => e.currentTarget.style.display = "none"} />
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.title || domain}</div>
              </div>
              <div style={{ fontSize: 10, color: "#2563eb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: desc ? 8 : 0 }}>{url}</div>
              {desc && <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{desc}</div>}
              <div style={{ marginTop: 10, fontSize: 9, color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", gap: 4 }}>
                <span>🔗</span><span>{domain}</span>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}
    </>
  );
}
