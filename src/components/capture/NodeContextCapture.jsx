import { useState, useEffect } from "react";
import { api, getText, parseJ } from "../../lib/api";
import { nodeW } from "../../lib/utils";

export default function NodeContextCapture({ node, accent, onSave, onDismiss }) {
  const [fields, setFields] = useState({ trigger: "", decision: "", discussion: "" });
  const [gen, setGen] = useState(false);

  useEffect(() => {
    if (node.entryContext) { setFields(node.entryContext); return; }
    setGen(true);
    api([{ role: "user", content: "Based on this knowledge node, suggest concise pre-fills (max 15 words each).\n\nTitle: \"" + node.title + "\"\nBody:\n" + node.body.replace(/^#+ /gm, "").slice(0, 300) + "\n\nReturn ONLY valid JSON:\n{\"trigger\":\"What problem triggered writing this\",\"decision\":\"Key design decision made\",\"discussion\":\"Most important conclusion\"}" }], null, 200)
      .then(d => { const p = parseJ(getText(d)); if (p) setFields({ trigger: p.trigger || "", decision: p.decision || "", discussion: p.discussion || "" }); })
      .finally(() => setGen(false));
  }, []);

  const fDefs = [
    { key: "trigger", icon: "?", label: "Why did you write this?", ph: "What problem or question triggered this..." },
    { key: "decision", icon: "!", label: "Key decision or insight", ph: "The main design decision or trade-off..." },
    { key: "discussion", icon: "o", label: "Conclusion from discussion", ph: "What you concluded after discussing this..." },
  ];

  return (
    <div style={{ position: "absolute", left: node.x + nodeW(node) + 12, top: node.y, width: 260, background: "var(--color-background-primary)", border: "1px solid " + accent + "55", borderRadius: 14, padding: "14px 16px", fontFamily: "'Inter',system-ui,sans-serif", zIndex: 25, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", animation: "fadeIn 0.2s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: accent, marginBottom: 2 }}>Context Capture</div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>Helps future you warm up faster</div>
        </div>
        <button onClick={onDismiss} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "var(--color-text-tertiary)" }}>x</button>
      </div>
      {gen && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginBottom: 10, animation: "pulse 1.5s infinite" }}>AI pre-filling...</div>}
      {fDefs.map(f => (
        <div key={f.key} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{f.icon} {f.label}</div>
          <textarea
            value={fields[f.key]}
            onChange={e => setFields(p => ({ ...p, [f.key]: e.target.value }))}
            placeholder={f.ph}
            rows={2}
            style={{ width: "100%", fontFamily: "inherit", fontSize: 11, lineHeight: 1.6, padding: "5px 8px", borderRadius: 7, resize: "none", outline: "none", border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", maxHeight: 60, overflow: "hidden" }}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onDismiss} style={{ fontFamily: "inherit", fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-tertiary)", cursor: "pointer" }}>Skip</button>
        <button onClick={() => onSave(fields)} style={{ fontFamily: "inherit", fontSize: 11, fontWeight: 600, padding: "4px 14px", borderRadius: 7, border: "none", background: accent, color: "#fff", cursor: "pointer" }}>Save</button>
      </div>
    </div>
  );
}
