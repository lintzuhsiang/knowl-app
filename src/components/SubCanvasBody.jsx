import { useState, useEffect, useRef, memo } from "react";
import MD from "./MD";

/**
 * Editable body panel shown at the top of every drill-in sub-canvas.
 * Displays the parent node's title + body as rendered markdown.
 * Single-click the panel to edit. Escape or blur saves and exits edit mode.
 *
 * The first heading line is stripped if it duplicates the node title,
 * so users don't see "# Caching" followed by the title "Caching".
 */
export default memo(function SubCanvasBody({ node, accent, onSave, maxH }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(node.body || "");
  const taRef                 = useRef(null);

  // Sync draft if parent node body changes externally
  useEffect(() => { if (!editing) setDraft(node.body || ""); }, [node.body, editing]);

  // Auto-resize + focus textarea when entering edit mode
  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      taRef.current.style.height = "auto";
      taRef.current.style.height = taRef.current.scrollHeight + "px";
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== (node.body || "")) onSave(draft);
  };

  const rawBody = (node.body || "").trim();
  const bodyText = (() => {
    const nl = rawBody.indexOf('\n');
    const firstLine = nl === -1 ? rawBody : rawBody.slice(0, nl);
    if (/^#+\s/.test(firstLine)) {
      const headingText = firstLine.replace(/^#+\s*/, '').trim();
      if (headingText.toLowerCase() === (node.title || '').toLowerCase()) {
        return nl === -1 ? '' : rawBody.slice(nl + 1).trimStart();
      }
    }
    return rawBody;
  })();

  return (
    <div style={{
      flexShrink: 0,
      background: "var(--color-background-primary)",
      borderBottom: "none",
      position: "relative",
      boxShadow: "0 2px 12px rgba(0,0,0,0.10)",
      zIndex: 2,
      maxHeight: maxH,
      overflowY: "auto",
    }}>
      {/* Colored accent stripe at top to visually anchor the header */}
      <div style={{ height: 3, background: `linear-gradient(90deg, ${accent}, ${accent}88)` }} />
      {/* Title bar */}
      <div style={{ padding: "10px 20px 0", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent, flexShrink: 0 }} />
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)", flex: 1, letterSpacing: "-0.02em" }}>{node.title}</div>
        <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", padding: "2px 7px", borderRadius: 4, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600 }}>Summary</div>
        {!editing && (
          <div style={{ fontSize: 9, color: "var(--color-text-tertiary)", padding: "2px 6px", borderRadius: 4, border: "0.5px solid var(--color-border-tertiary)", cursor: "pointer", transition: "all 0.12s" }}
            onClick={() => setEditing(true)}
            onMouseEnter={e => { e.currentTarget.style.color = accent; e.currentTarget.style.borderColor = accent + "55"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-tertiary)"; e.currentTarget.style.borderColor = "var(--color-border-tertiary)"; }}>
            edit
          </div>
        )}
        {editing && (
          <div style={{ fontSize: 9, color: accent, padding: "2px 6px", borderRadius: 4, border: "0.5px solid " + accent + "55" }}>editing</div>
        )}
      </div>

      {/* Body */}
      {editing ? (
        <div style={{ padding: "6px 20px 12px" }}>
          <textarea ref={taRef} value={draft}
            onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
            onBlur={commit}
            onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); commit(); } if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commit(); } }}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            placeholder={'Add notes for "' + node.title + '"...'}
            style={{ width: "100%", fontFamily: "'Fira Code',monospace", fontSize: 12, lineHeight: 1.8, padding: "4px 0", border: "none", background: "transparent", color: "var(--color-text-primary)", resize: "none", outline: "none", display: "block", boxSizing: "border-box", minHeight: 60, maxHeight: 300, overflow: "auto" }}
          />
        </div>
      ) : (
        <div onClick={() => setEditing(true)} style={{ padding: "6px 20px 12px", cursor: "text", maxHeight: 180, overflow: "hidden" }}>
          {bodyText
            ? <div style={{ pointerEvents: "none" }}><MD text={bodyText} /></div>
            : <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", fontStyle: "italic", paddingTop: 2 }}>Click to add notes…</div>
          }
        </div>
      )}
    </div>
  );
});
