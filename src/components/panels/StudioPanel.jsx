import { useState, useRef, useEffect, useCallback } from "react";
import { api, apiStream, getText, parseJ } from "../../lib/api";
import { TASK_MODES, CC, NC } from "../../lib/constants";
import {
  STUDIO_MODES, detectIntent,
  buildTutorStart, buildTutorFollowUp,
  buildWarmUpPrompt, buildGeneratePrompt, parseTutorResponse,
} from "../../lib/studioModes";

export default function StudioPanel({
  topicLabel, nodes, edges, accent,
  initialMode, onHighlight, onHighlightSequence,
  onGhostNode, onGenerate, onNavigate,
  gapData, gapScanState, onGapScan,
  bookmarks, onClose,
}) {
  const [messages, setMessages] = useState([]);
  const [activeMode, setActiveMode] = useState(initialMode || null);
  const [subMode, setSubMode] = useState("general");
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState("idle");
  const [generatePreview, setGeneratePreview] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const prevInitRef = useRef(initialMode);

  // Sync initialMode from parent (header button clicks)
  useEffect(() => {
    if (initialMode && initialMode !== prevInitRef.current) {
      prevInitRef.current = initialMode;
      setActiveMode(initialMode);
      if (initialMode === "gaps" && gapScanState === "idle" && !gapData) {
        setTimeout(onGapScan, 300);
      }
    }
  }, [initialMode, gapScanState, gapData, onGapScan]);

  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages, phase, generatePreview, gapData]);

  useEffect(() => { inputRef.current?.focus(); }, [activeMode]);

  // ── Mode selection ─────────────────────────────────────────
  const pickMode = mode => {
    setActiveMode(mode);
    setGeneratePreview(null);
    if (mode === "gaps" && gapScanState === "idle" && !gapData) {
      setTimeout(onGapScan, 300);
    }
  };

  // ── Tutor: start session ───────────────────────────────────
  const startTutor = async () => {
    setPhase("thinking");
    setMessages([]);
    try {
      const d = await api([{ role: "user", content: buildTutorStart(topicLabel, nodes) }]);
      const p = parseTutorResponse(getText(d));
      const msg = { role: "assistant", content: p.message || "...", meta: { type: "tutor", highlight: p.highlight || [], ghostNode: p.ghostNode || null } };
      setMessages([msg]);
      if (p.highlight?.length > 0) onHighlight(p.highlight);
      if (p.ghostNode) onGhostNode(p.ghostNode);
      setPhase("active");
    } catch (e) { setPhase("idle"); }
  };

  // ── Tutor: follow-up ───────────────────────────────────────
  const sendTutor = async (text) => {
    const um = { role: "user", content: text, meta: { type: "tutor" } };
    const nh = [...messages, um];
    setMessages(nh); setPhase("thinking");
    const sys = buildTutorFollowUp(topicLabel, nodes);
    try {
      const d = await api(nh.map(m => ({ role: m.role, content: m.content })), sys);
      const p = parseTutorResponse(getText(d));
      const msg = { role: "assistant", content: p.message || "...", meta: { type: "tutor", highlight: p.highlight || [], ghostNode: p.ghostNode || null } };
      setMessages([...nh, msg]);
      if (p.highlight?.length > 0) onHighlight(p.highlight);
      if (p.ghostNode) onGhostNode(p.ghostNode);
      setPhase("active");
    } catch (e) { setPhase("active"); }
  };

  // ── Warm Up ────────────────────────────────────────────────
  const sendWarmUp = async (text) => {
    const um = { role: "user", content: text, meta: { type: "warmup", subMode } };
    const nh = [...messages, um];
    setMessages(nh); setPhase("thinking");
    try {
      const { prompt, sys } = buildWarmUpPrompt(topicLabel, nodes, subMode, text);
      const d = await api([{ role: "user", content: prompt }], sys, 800);
      const p = parseJ(getText(d));
      if (p) {
        const msg = { role: "assistant", content: p.summary || "...", meta: { type: "warmup", entryPoint: p.entryPoint, openQuestion: p.openQuestion, nodeSequence: p.nodeSequence } };
        setMessages([...nh, msg]);
        if (p.nodeSequence?.length > 0) onHighlightSequence(p.nodeSequence);
      }
      setPhase("active");
    } catch (e) { setPhase("active"); }
  };

  // ── Generate ───────────────────────────────────────────────
  const sendGenerate = async (text) => {
    const um = { role: "user", content: text, meta: { type: "generate" } };
    const nh = [...messages, um];
    setMessages(nh); setPhase("thinking"); setGeneratePreview(null);
    try {
      const d = await api([{ role: "user", content: buildGeneratePrompt(text, nodes, edges) }], null, 1500);
      const p = parseJ(getText(d));
      if (p?.nodes?.length > 0) {
        const msg = { role: "assistant", content: p.nodes.length + " nodes ready to add to map", meta: { type: "generate", preview: p } };
        setMessages([...nh, msg]);
        setGeneratePreview(p);
      }
      setPhase("active");
    } catch (e) { setPhase("active"); }
  };

  // ── Chat (fallback) ────────────────────────────────────────
  const sendChat = async (text) => {
    const um = { role: "user", content: text, meta: { type: "chat" } };
    const nh = [...messages, um];
    const aiTs = Date.now();
    const placeholder = { role: "assistant", content: "", ts: aiTs, meta: { type: "chat" }, streaming: true };
    setMessages([...nh, placeholder]);
    setPhase("thinking");
    try {
      const ctx = Object.values(nodes).map(n => "\"" + n.title + "\": " + n.body.replace(/^#+ /gm, "")).join("\n");
      const sys = "Knowledge map for \"" + topicLabel + "\". Nodes:\n" + ctx + "\n\nBe concise.";
      const finalText = await apiStream(nh.map(m => ({ role: m.role, content: m.content })), sys, 400, {
        onToken: (_chunk, full) => {
          setMessages(prev => {
            const next = [...prev];
            const idx = next.findIndex(m => m.ts === aiTs && m.role === "assistant");
            if (idx >= 0) next[idx] = { ...next[idx], content: full.replace(/```[a-z]*|```/g, "") };
            return next;
          });
        },
      });
      const cleaned = (finalText || "").replace(/```[a-z]*|```/g, "").trim() || "...";
      setMessages(prev => {
        const next = [...prev];
        const idx = next.findIndex(m => m.ts === aiTs && m.role === "assistant");
        if (idx >= 0) next[idx] = { ...next[idx], content: cleaned, streaming: false };
        return next;
      });
      setPhase("active");
    } catch (e) {
      setMessages(prev => prev.filter(m => !(m.ts === aiTs && m.role === "assistant")));
      setPhase("active");
    }
  };

  // ── Unified send ───────────────────────────────────────────
  const send = () => {
    if (!input.trim() || phase === "thinking") return;
    setPhase("thinking"); // guard against double-submit
    const text = input.trim();
    setInput("");

    // Smart detection if no active mode
    const mode = activeMode || detectIntent(text);
    if (!activeMode && mode !== "chat") setActiveMode(mode);

    if (mode === "tutor") {
      if (messages.filter(m => m.meta?.type === "tutor").length === 0) {
        startTutor();
      } else {
        sendTutor(text);
      }
    } else if (mode === "warmup") {
      sendWarmUp(text);
    } else if (mode === "generate") {
      sendGenerate(text);
    } else {
      sendChat(text);
    }
  };

  // ── Preset prompt click (warm up) ──────────────────────────
  const onPresetClick = (promptText) => {
    const full = promptText + topicLabel;
    setInput("");
    setActiveMode("warmup");
    sendWarmUp(full);
  };

  // ── Apply generated nodes ──────────────────────────────────
  const applyGenerate = (preview) => {
    onGenerate(preview);
    setGeneratePreview(null);
    const msg = { role: "assistant", content: "Applied " + preview.nodes.length + " nodes to your map.", meta: { type: "system" } };
    setMessages(prev => [...prev, msg]);
  };

  // ── Type icon/color helpers ────────────────────────────────
  const typeIcon = t => t === "diagram" ? "\u25b3" : t === "table" ? "\u2593" : "\u00b6";
  const typeColor = t => t === "diagram" ? "#7c3aed" : t === "table" ? "#0891b2" : accent;

  const mode = TASK_MODES[subMode];
  const isGenerate = activeMode === "generate";
  const hasMessages = messages.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter',system-ui,sans-serif" }}>

      {/* ── Header ──────────────────────────────────────────── */}
      <div style={{ padding: "10px 14px 8px", borderBottom: "0.5px solid var(--color-border-tertiary)", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: accent }}>Studio</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "var(--color-text-tertiary)", padding: "0 2px" }}>x</button>
        </div>

        {/* Mode chips */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {Object.entries(STUDIO_MODES).map(([key, m]) => (
            <button key={key} onClick={() => pickMode(key)}
              style={{
                fontFamily: "inherit", fontSize: 10, fontWeight: 600,
                padding: "3px 9px", borderRadius: 100, border: "none", cursor: "pointer",
                transition: "all 0.15s",
                background: activeMode === key ? accent + "22" : "var(--color-background-secondary)",
                color: activeMode === key ? accent : "var(--color-text-tertiary)",
                outline: activeMode === key ? "1.5px solid " + accent + "55" : "none",
              }}>
              {m.icon} {m.label}
            </button>
          ))}
          {activeMode && (
            <button onClick={() => { setActiveMode(null); setGeneratePreview(null); }}
              style={{ fontFamily: "inherit", fontSize: 9, padding: "2px 7px", borderRadius: 100, border: "0.5px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer" }}>
              clear
            </button>
          )}
        </div>

        {/* Warm-up sub-modes */}
        {activeMode === "warmup" && (
          <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
            {Object.entries(TASK_MODES).map(([key, m]) => (
              <button key={key} onClick={() => setSubMode(key)}
                style={{
                  fontFamily: "inherit", fontSize: 9, fontWeight: 600,
                  padding: "2px 8px", borderRadius: 100, border: "none", cursor: "pointer",
                  background: subMode === key ? m.color + "22" : "var(--color-background-secondary)",
                  color: subMode === key ? m.color : "var(--color-text-tertiary)",
                  outline: subMode === key ? "1px solid " + m.color + "44" : "none",
                }}>
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Messages / Content ──────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 10px 4px" }}>

        {/* Empty state: no mode selected */}
        {!activeMode && !hasMessages && (
          <div style={{ padding: "20px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 22, marginBottom: 10, opacity: 0.3 }}>{"\u2728"}</div>
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.65, marginBottom: 14 }}>
              Pick a mode above, or just type — I will detect your intent.
            </div>
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.8 }}>
              Try: "quiz me" &middot; "warm up on..." &middot; "generate cards for..." &middot; "find gaps"
            </div>
          </div>
        )}

        {/* Tutor empty state */}
        {activeMode === "tutor" && messages.filter(m => m.meta?.type === "tutor").length === 0 && phase !== "thinking" && (
          <div style={{ padding: "20px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 24, marginBottom: 10, opacity: 0.35 }}>?</div>
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.65, marginBottom: 14 }}>
              I will ask Socratic questions about your map. Nodes highlight as we discuss. Missing concepts become ghost nodes.
            </div>
            <button onClick={startTutor}
              style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer" }}>
              Start session
            </button>
          </div>
        )}

        {/* Warm-up preset prompts (show when no warmup messages yet) */}
        {activeMode === "warmup" && messages.filter(m => m.meta?.type === "warmup").length === 0 && phase !== "thinking" && (
          <div style={{ padding: "4px 2px" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1.65, marginBottom: 10 }}>
              Pick a prompt or type your own below.
            </div>
            {mode.prompts.map((s, i) => (
              <button key={i} onClick={() => onPresetClick(s)}
                style={{
                  fontFamily: "inherit", display: "block", width: "100%", fontSize: 11,
                  padding: "7px 11px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)",
                  background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer",
                  textAlign: "left", marginBottom: 5, transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--color-background-secondary)"; e.currentTarget.style.color = "var(--color-text-primary)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--color-text-secondary)"; }}>
                {s}<span style={{ color: mode.color, fontWeight: 600 }}>{topicLabel}</span>
              </button>
            ))}
          </div>
        )}

        {/* Gaps inline results */}
        {activeMode === "gaps" && (
          <div>
            {gapScanState === "scanning" && !gapData && (
              <div style={{ padding: "24px", textAlign: "center", fontSize: 12, color: "var(--color-text-tertiary)", animation: "pulse 1.5s infinite" }}>
                Analyzing map for gaps...
              </div>
            )}
            {!gapData && gapScanState !== "scanning" && (
              <div style={{ padding: "20px 6px", textAlign: "center" }}>
                <div style={{ fontSize: 24, marginBottom: 10, opacity: 0.35 }}>o</div>
                <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.65, marginBottom: 14 }}>
                  Scan for missing concepts, hidden contradictions, and what to explore next.
                </div>
                <button onClick={onGapScan}
                  style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer" }}>
                  Run analysis
                </button>
              </div>
            )}
            {gapData && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
                    {(gapData.gaps?.length || 0) + (gapData.latentConflicts?.length || 0)} items found
                  </div>
                  <button onClick={onGapScan} disabled={gapScanState === "scanning"}
                    style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 500, padding: "2px 8px", borderRadius: 5, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: gapScanState === "scanning" ? "var(--color-text-tertiary)" : accent, cursor: gapScanState === "scanning" ? "default" : "pointer" }}>
                    {gapScanState === "scanning" ? "..." : "Re-scan"}
                  </button>
                </div>
                {gapData.gaps?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-tertiary)", padding: "3px 0 5px" }}>Knowledge Gaps ({gapData.gaps.length})</div>
                    {gapData.gaps.map((g, i) => (
                      <div key={i} onClick={() => g.relatedNodeIds?.[0] && onNavigate(g.relatedNodeIds[0])}
                        style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 4, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", cursor: g.relatedNodeIds?.[0] ? "pointer" : "default", transition: "border-color 0.15s" }}
                        onMouseEnter={e => { if (g.relatedNodeIds?.[0]) e.currentTarget.style.borderColor = accent + "66"; }}
                        onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 2 }}>{g.label}</div>
                        <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>{g.description}</div>
                      </div>
                    ))}
                  </div>
                )}
                {gapData.latentConflicts?.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-tertiary)", padding: "3px 0 5px" }}>Latent Conflicts ({gapData.latentConflicts.length})</div>
                    {gapData.latentConflicts.map((c, i) => (
                      <div key={i} onClick={() => c.nodeAId && onNavigate(c.nodeAId)}
                        style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 4, background: CC + "08", border: "0.5px solid " + CC + "33", cursor: "pointer" }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = CC + "66"}
                        onMouseLeave={e => e.currentTarget.style.borderColor = CC + "33"}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: CC, marginBottom: 2 }}>! Latent tension</div>
                        <div style={{ fontSize: 10, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{c.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
                {gapData.suggestions?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-tertiary)", padding: "3px 0 5px" }}>Explore Next</div>
                    {gapData.suggestions.map((s, i) => (
                      <div key={i} style={{ padding: "7px 10px", borderRadius: 8, marginBottom: 4, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                        - {s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Generate empty state */}
        {activeMode === "generate" && messages.filter(m => m.meta?.type === "generate").length === 0 && phase !== "thinking" && (
          <div style={{ padding: "20px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 24, marginBottom: 10, opacity: 0.35 }}>+</div>
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.65 }}>
              Paste a paragraph below — AI extracts nodes, relationships & hierarchy for your map.
            </div>
          </div>
        )}

        {/* Chat messages */}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 8, display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "92%", fontSize: 12, lineHeight: 1.65, padding: "7px 10px", borderRadius: 10,
              background: m.role === "user" ? accent + "18" : m.meta?.type === "system" ? NC + "12" : "var(--color-background-secondary)",
              color: "var(--color-text-primary)",
              border: m.role === "user" ? "0.5px solid " + accent + "33" : "0.5px solid var(--color-border-tertiary)",
            }}>
              {m.content}

              {/* Tutor: highlight indicator */}
              {m.meta?.type === "tutor" && m.meta?.highlight?.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 9, fontWeight: 700, color: accent, opacity: 0.8 }}>highlighted on map</div>
              )}

              {/* Warm-up: entry point + follow-up */}
              {m.meta?.type === "warmup" && m.meta?.entryPoint && (
                <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: 7, background: (mode?.color || accent) + "0a", border: "0.5px solid " + (mode?.color || accent) + "33" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: mode?.color || accent, marginBottom: 2 }}>ENTRY POINT</div>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{m.meta.entryPoint}</div>
                </div>
              )}
              {m.meta?.type === "warmup" && m.meta?.openQuestion && (
                <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: 7, background: (mode?.color || accent) + "0a", border: "0.5px solid " + (mode?.color || accent) + "33" }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: mode?.color || accent, marginBottom: 2 }}>FOLLOW-UP</div>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{m.meta.openQuestion}</div>
                </div>
              )}
              {m.meta?.type === "warmup" && m.meta?.nodeSequence?.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 9, fontWeight: 700, color: mode?.color || accent, opacity: 0.8 }}>touring {m.meta.nodeSequence.length} nodes on map</div>
              )}
            </div>
          </div>
        ))}

        {/* Generate preview cards */}
        {generatePreview && (
          <div style={{ marginTop: 4, marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 8 }}>
              {generatePreview.nodes.length} nodes + {(generatePreview.edges || []).length} edges:
            </div>
            {generatePreview.nodes.map(n => (
              <div key={n.tempId} style={{ padding: "7px 10px", borderRadius: 8, marginBottom: 4, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", marginLeft: n.parentTempId ? 16 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 100, background: typeColor(n.nodeType) + "18", color: typeColor(n.nodeType), border: "0.5px solid " + typeColor(n.nodeType) + "44" }}>
                    {typeIcon(n.nodeType)} {n.nodeType || "text"}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-primary)" }}>{n.title}</div>
                </div>
                {n.body && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2, lineHeight: 1.45 }}>{n.body.slice(0, 80)}{n.body.length > 80 ? "..." : ""}</div>}
              </div>
            ))}
            {(generatePreview.edges || []).length > 0 && (
              <div style={{ marginTop: 6 }}>
                {generatePreview.edges.map((e, i) => {
                  const fromN = generatePreview.nodes.find(n => n.tempId === e.from);
                  const toN = generatePreview.nodes.find(n => n.tempId === e.to);
                  return (
                    <div key={i} style={{ fontSize: 10, color: "var(--color-text-secondary)", padding: "2px 0", display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ fontWeight: 600 }}>{fromN?.title || e.from}</span>
                      <span style={{ color: accent }}>{"\u2192"}</span>
                      <span style={{ fontWeight: 600 }}>{toN?.title || e.to}</span>
                      {e.label && <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", fontStyle: "italic" }}>({e.label})</span>}
                    </div>
                  );
                })}
              </div>
            )}
            <button onClick={() => applyGenerate(generatePreview)}
              style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "6px 16px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer", marginTop: 8, width: "100%" }}>
              Apply {generatePreview.nodes.length} nodes to map
            </button>
          </div>
        )}

        {/* Thinking indicator */}
        {phase === "thinking" && (
          <div style={{ display: "flex", marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", padding: "7px 10px", background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", animation: "pulse 1.5s infinite" }}>
              {activeMode === "generate" ? "Extracting nodes..." : activeMode === "warmup" ? "Building warm-up..." : "thinking..."}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input area ──────────────────────────────────────── */}
      {activeMode !== "gaps" && (
        <div style={{ padding: "8px 10px", borderTop: "0.5px solid var(--color-border-tertiary)", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 5, alignItems: "flex-end" }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => { setInput(e.target.value); if (!isGenerate) { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 80) + "px"; } }}
              onKeyDown={e => {
                if (isGenerate && e.key === "Enter" && e.metaKey) { e.preventDefault(); send(); }
                else if (!isGenerate && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={
                activeMode === "tutor" ? "Your answer..." :
                activeMode === "warmup" ? "Ask about " + topicLabel + "..." :
                activeMode === "generate" ? "Paste paragraph here (Cmd+Enter to generate)..." :
                "Type anything — I will detect your intent..."
              }
              rows={isGenerate ? 4 : 1}
              style={{
                flex: 1, fontFamily: isGenerate ? "'Fira Code',monospace" : "inherit",
                fontSize: 12, lineHeight: 1.6, padding: "5px 9px", borderRadius: 8,
                border: "0.5px solid " + (isGenerate ? accent + "88" : "var(--color-border-secondary)"),
                background: "var(--color-background-secondary)", color: "var(--color-text-primary)",
                resize: isGenerate ? "vertical" : "none", outline: "none",
                minHeight: isGenerate ? 80 : 30, maxHeight: isGenerate ? 200 : 80,
                overflow: isGenerate ? "auto" : "hidden",
              }}
            />
            <button onClick={send} disabled={phase === "thinking" || !input.trim()}
              style={{
                fontFamily: "inherit", fontSize: 11, fontWeight: 600,
                padding: "5px 12px", borderRadius: 8, border: "none",
                background: accent, color: "#fff", cursor: "pointer", flexShrink: 0,
                opacity: phase === "thinking" || !input.trim() ? 0.4 : 1,
              }}>
              {phase === "thinking" ? "..." : isGenerate ? "Generate" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
