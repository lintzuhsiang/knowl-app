import { useState } from "react";
import { api, getText, parseJ } from "../../lib/api";
import { NC } from "../../lib/constants";

export default function DocumentImportModal({ accent, nodes, onImport, onClose }) {
  const [text, setText]       = useState("");
  const [phase, setPhase]     = useState("idle");
  const [preview, setPreview] = useState(null);

  const analyze = async () => {
    if (!text.trim()) return;
    setPhase("thinking");
    try {
      const prompt = "Parse this markdown document into knowledge nodes.\n\n# = level 1 parent, ## = level 2 child, ### = level 3 grandchild. Text under each heading is the body.\n\nDocument:\n" + text.slice(0, 3000) + "\n\nReturn ONLY valid JSON:\n{\"nodes\":[{\"tempId\":\"n1\",\"title\":\"...\",\"body\":\"markdown content\",\"level\":1,\"parentTempId\":null},{\"tempId\":\"n2\",\"title\":\"...\",\"body\":\"...\",\"level\":2,\"parentTempId\":\"n1\"}]}";
      const d = await api([{ role: "user", content: prompt }], null, 1200);
      const p = parseJ(getText(d));
      if (p?.nodes) { setPreview(p.nodes); setPhase("preview"); } else setPhase("idle");
    } catch (e) { setPhase("idle"); }
  };

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 8000, padding: "1rem" }}>
      <div style={{ background: "var(--color-background-primary)", borderRadius: 18, border: "0.5px solid var(--color-border-tertiary)", width: "100%", maxWidth: 660, maxHeight: "85%", fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "1.25rem 1.5rem", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: accent, marginBottom: 3 }}>Import Document</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Paste markdown — AI builds node hierarchy automatically</div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4 }}>
              # Heading = parent node &nbsp;|&nbsp; ## Heading = child &nbsp;|&nbsp; ### Heading = grandchild
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "var(--color-text-tertiary)" }}>x</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
          {phase !== "preview" && (
            <textarea value={text} onChange={e => setText(e.target.value)}
              placeholder={"# WFM Attach Project\n## Tech Challenge 1: Payload Variance\nHero ASINs caused timeout...\n### My Decision\nSet Aggressive Fallback...\n## Tech Challenge 2: SLA Negotiation\n..."}
              style={{ width: "100%", minHeight: 220, fontFamily: "'Fira Code',monospace", fontSize: 11, lineHeight: 1.7, padding: "10px 12px", borderRadius: 10, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", resize: "vertical", outline: "none" }} />
          )}
          {phase === "thinking" && <div style={{ padding: "32px", textAlign: "center", fontSize: 12, color: "var(--color-text-tertiary)", animation: "pulse 1.5s infinite" }}>Parsing structure...</div>}
          {phase === "preview" && preview && (
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 12 }}>{preview.length} nodes will be created:</div>
              {preview.map(n => (
                <div key={n.tempId} style={{ padding: "8px 12px", borderRadius: 9, marginBottom: 6, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", marginLeft: (n.level - 1) * 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 100, background: n.level === 1 ? accent + "18" : n.level === 2 ? NC + "18" : "#7c3aed18", color: n.level === 1 ? accent : n.level === 2 ? NC : "#7c3aed" }}>h{n.level}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)" }}>{n.title}</div>
                  </div>
                  {n.body && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3, lineHeight: 1.5 }}>{n.body.slice(0, 80)}{n.body.length > 80 ? "..." : ""}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: "1rem 1.5rem", borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <button onClick={onClose} style={{ fontFamily: "inherit", fontSize: 12, padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>Cancel</button>
          <div style={{ display: "flex", gap: 8 }}>
            {phase === "preview" && <button onClick={() => { setPhase("idle"); setPreview(null); }} style={{ fontFamily: "inherit", fontSize: 12, padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>Back</button>}
            {phase !== "preview" && <button onClick={analyze} disabled={!text.trim() || phase === "thinking"} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer", opacity: !text.trim() || phase === "thinking" ? 0.4 : 1 }}>{phase === "thinking" ? "..." : "Analyze"}</button>}
            {phase === "preview" && preview && <button onClick={() => onImport(preview)} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer" }}>Import {preview.length} nodes</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
