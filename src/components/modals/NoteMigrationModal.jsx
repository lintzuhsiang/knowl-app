import { useState } from "react";
import { api, getText, parseJ } from "../../lib/api";
import { NC } from "../../lib/constants";

export default function NoteMigrationModal({ accent, nodes, onMigrate, onClose }) {
  const [text, setText]       = useState("");
  const [phase, setPhase]     = useState("idle");
  const [preview, setPreview] = useState(null);

  const analyze = async () => {
    if (!text.trim()) return;
    setPhase("thinking");
    try {
      const existingCtx = Object.values(nodes).map(n => "- " + n.title).join("\n");
      const prompt = "Break this paragraph into a small knowledge graph of 2-6 nodes with relationships.\n\nExisting nodes for reference:\n" + (existingCtx || "(none)") + "\n\nParagraph:\n" + text.slice(0, 3000) + "\n\nFor each node decide: is it best as text, diagram, or table?\n- text: regular notes/concepts\n- diagram: processes, flows, architectures\n- table: comparisons, data, matrices\n\nReturn ONLY valid JSON:\n{\"nodes\":[{\"tempId\":\"n1\",\"title\":\"...\",\"body\":\"markdown content\",\"nodeType\":\"text\",\"confidence\":null,\"parentTempId\":null},{\"tempId\":\"n2\",\"title\":\"...\",\"body\":\"...\",\"nodeType\":\"text\",\"confidence\":null,\"parentTempId\":\"n1\"}],\"edges\":[{\"from\":\"n1\",\"to\":\"n2\",\"label\":\"relates to\",\"dash\":false}]}";
      const d = await api([{ role: "user", content: prompt }], null, 1500);
      const p = parseJ(getText(d));
      if (p?.nodes?.length > 0) { setPreview(p); setPhase("preview"); }
      else setPhase("idle");
    } catch (e) { setPhase("idle"); }
  };

  const typeIcon = t => t === "diagram" ? "\u25b3" : t === "table" ? "\u2593" : "\u00b6";
  const typeColor = t => t === "diagram" ? "#7c3aed" : t === "table" ? "#0891b2" : accent;

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 8000, padding: "1rem" }}>
      <div style={{ background: "var(--color-background-primary)", borderRadius: 18, border: "0.5px solid var(--color-border-tertiary)", width: "100%", maxWidth: 660, maxHeight: "85%", fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "1.25rem 1.5rem", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: accent, marginBottom: 3 }}>Note Migration</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Paste a paragraph — AI extracts nodes, relationships & hierarchy</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "var(--color-text-tertiary)" }}>x</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "1rem 1.5rem" }}>
          {phase !== "preview" && (
            <textarea value={text} onChange={e => setText(e.target.value)}
              placeholder={"Message queues decouple services. Kafka excels at throughput with partitioned logs while RabbitMQ offers lower latency with exchange routing. Both pair with caching layers — Redis for L2 and in-process for L1. Load balancers distribute traffic, using sticky sessions for stateful workloads and round-robin for stateless ones..."}
              style={{ width: "100%", minHeight: 160, fontFamily: "'Fira Code',monospace", fontSize: 11, lineHeight: 1.7, padding: "10px 12px", borderRadius: 10, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", resize: "vertical", outline: "none" }} />
          )}
          {phase === "thinking" && <div style={{ padding: "32px", textAlign: "center", fontSize: 12, color: "var(--color-text-tertiary)", animation: "pulse 1.5s infinite" }}>Analyzing structure and extracting nodes...</div>}
          {phase === "preview" && preview && (
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 12 }}>{preview.nodes.length} nodes + {(preview.edges || []).length} relationships will be created:</div>
              {preview.nodes.map(n => (
                <div key={n.tempId} style={{ padding: "8px 12px", borderRadius: 9, marginBottom: 6, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", marginLeft: n.parentTempId ? 20 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 100, background: typeColor(n.nodeType) + "18", color: typeColor(n.nodeType), border: "0.5px solid " + typeColor(n.nodeType) + "44" }}>{typeIcon(n.nodeType)} {n.nodeType || "text"}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)" }}>{n.title}</div>
                    {n.parentTempId && <div style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>child</div>}
                  </div>
                  {n.body && <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3, lineHeight: 1.5 }}>{n.body.slice(0, 100)}{n.body.length > 100 ? "..." : ""}</div>}
                </div>
              ))}
              {(preview.edges || []).length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "var(--color-text-tertiary)", marginBottom: 6 }}>Relationships:</div>
                  {preview.edges.map((e, i) => {
                    const fromN = preview.nodes.find(n => n.tempId === e.from);
                    const toN = preview.nodes.find(n => n.tempId === e.to);
                    return (
                      <div key={i} style={{ fontSize: 11, color: "var(--color-text-secondary)", padding: "3px 0", display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ fontWeight: 600 }}>{fromN?.title || e.from}</span>
                        <span style={{ color: accent }}>{"\u2192"}</span>
                        <span style={{ fontWeight: 600 }}>{toN?.title || e.to}</span>
                        {e.label && <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", fontStyle: "italic" }}>({e.label})</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ padding: "1rem 1.5rem", borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <button onClick={onClose} style={{ fontFamily: "inherit", fontSize: 12, padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>Cancel</button>
          <div style={{ display: "flex", gap: 8 }}>
            {phase === "preview" && <button onClick={() => { setPhase("idle"); setPreview(null); }} style={{ fontFamily: "inherit", fontSize: 12, padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>Back</button>}
            {phase !== "preview" && <button onClick={analyze} disabled={!text.trim() || phase === "thinking"} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer", opacity: !text.trim() || phase === "thinking" ? 0.4 : 1 }}>{phase === "thinking" ? "..." : "Analyze"}</button>}
            {phase === "preview" && preview && <button onClick={() => onMigrate(preview)} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: accent, color: "#fff", cursor: "pointer" }}>Migrate {preview.nodes.length} nodes</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
