import { useState } from "react";
import { api, getText } from "../../lib/api";
import { CC, NC } from "../../lib/constants";

export default function ConflictModal({ node, onClose, onResolve }) {
  const [phase, setPhase] = useState("compare");
  const [merged, setMerged] = useState("");
  const [edited, setEdited] = useState("");

  const doMerge = async () => {
    setPhase("merging");
    try {
      const d = await api([{ role: "user", content: "Synthesize into one first-person paragraph, no headers, no bullets, name the tension.\n\nOriginal: \"" + node.body + "\"\nNew: \"" + node.conflict.inp + "\"\nTension: \"" + node.conflict.label + "\"\n\nOnly the paragraph." }], null, 300);
      const t = getText(d).replace(/```[a-z]*|```/g, "").trim();
      setMerged(t); setEdited(t); setPhase("editing");
    } catch (e) { setPhase("compare"); }
  };

  const steps = [["compare", "Compare"], ["merging", "Synthesize"], ["editing", "Edit"]];
  const si = ["compare", "merging", "editing"].indexOf(phase);

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 8000, padding: "1rem" }}>
      <div style={{ background: "var(--color-background-primary)", borderRadius: 18, border: "0.5px solid var(--color-border-tertiary)", width: "100%", maxWidth: 620, fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden" }}>
        <div style={{ padding: "1.25rem 1.5rem", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: CC, marginBottom: 3 }}>Conflict</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--color-text-primary)" }}>{node.title}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, padding: "4px 12px", borderRadius: 100, background: CC + "18", color: CC, border: "0.5px solid " + CC + "44" }}>! {node.conflict.label}</div>
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "var(--color-text-tertiary)" }}>x</button>
          </div>
        </div>
        <div style={{ padding: "1.25rem 1.5rem" }}>
          <div style={{ display: "flex", gap: 6, marginBottom: "1rem" }}>
            {steps.map(([s, l], i) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {i > 0 && <div style={{ width: 16, height: 1, background: "var(--color-border-tertiary)" }} />}
                <div style={{ fontSize: 11, fontWeight: 600, paddingBottom: 2, color: si >= i ? "var(--color-text-primary)" : "var(--color-text-tertiary)", borderBottom: si >= i ? "1.5px solid var(--color-text-primary)" : "1.5px solid transparent" }}>{l}</div>
              </div>
            ))}
          </div>
          {phase === "compare" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[{ l: "Past you", t: node.body.replace(/^#+ /gm, ""), c: "var(--color-text-tertiary)" }, { l: "New insight", t: node.conflict.inp, c: "var(--color-text-info)" }].map(item => (
                <div key={item.l} style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: "1rem", border: "0.5px solid var(--color-border-tertiary)" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: item.c, marginBottom: 8 }}>{item.l}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.75, color: "var(--color-text-primary)" }}>{item.t}</div>
                </div>
              ))}
            </div>
          )}
          {(phase === "merging" || phase === "editing") && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: phase === "merging" ? CC : NC, marginBottom: 8 }}>{phase === "merging" ? "Thinking..." : "Edit before saving"}</div>
              {phase === "editing"
                ? <textarea value={edited} onChange={e => setEdited(e.target.value)} style={{ width: "100%", minHeight: 100, fontFamily: "inherit", fontSize: 13, lineHeight: 1.75, padding: "0.875rem", borderRadius: 10, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", color: "var(--color-text-primary)", resize: "vertical" }} />
                : <div style={{ minHeight: 100, fontSize: 13, lineHeight: 1.75, color: "var(--color-text-primary)", padding: "0.875rem", background: "var(--color-background-secondary)", borderRadius: 10 }}>{merged}</div>}
            </div>
          )}
        </div>
        <div style={{ padding: "1rem 1.5rem", borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between" }}>
          <button onClick={() => onResolve(node.id, "dialectic", null)} style={{ fontFamily: "inherit", fontSize: 12, padding: "7px 16px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>Dialectic</button>
          <div style={{ display: "flex", gap: 10 }}>
            {phase === "compare" && <button onClick={doMerge} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: "var(--color-background-info)", color: "var(--color-text-info)", cursor: "pointer" }}>AI merge</button>}
            {phase === "editing" && (
              <>
                <button onClick={() => setPhase("compare")} style={{ fontFamily: "inherit", fontSize: 12, padding: "7px 14px", borderRadius: 8, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>Back</button>
                <button onClick={() => onResolve(node.id, "merged", edited)} style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "7px 18px", borderRadius: 8, border: "none", background: "#05996918", color: NC, cursor: "pointer" }}>Save</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
