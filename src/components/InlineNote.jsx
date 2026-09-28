import { useState, useEffect, useRef, memo } from "react";

/**
 * Lightweight note block positioned in a sub-canvas at the exact spot the user clicked.
 * Click to edit inline, hover to reveal a delete button. No title, no handles — just text.
 *
 * Interaction model:
 *   mousedown + move > 5px → drag (calls onMove live)
 *   mousedown + release < 5px → click → enter edit mode
 *   Enter (no shift) = save, Escape = cancel, blur = save
 *   Empty text on commit → onDelete
 */
export default memo(function InlineNote({ note, accent, zoom, onUpdate, onDelete, onMove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(note.text);
  const [hov, setHov]         = useState(false);
  const [dragging, setDragging] = useState(false);
  const taRef                 = useRef(null);
  const dragState             = useRef(null);

  useEffect(() => { if (!editing) setDraft(note.text); }, [note.text, editing]);
  useEffect(() => {
    if (editing && taRef.current) {
      taRef.current.focus();
      taRef.current.style.height = "auto";
      taRef.current.style.height = taRef.current.scrollHeight + "px";
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t) { if (t !== note.text) onUpdate(note.id, t); }
    else onDelete(note.id);
  };

  const handleMouseDown = (e) => {
    if (editing) return;
    e.stopPropagation();
    e.preventDefault();
    const z = zoom || 1;
    dragState.current = { startClientX: e.clientX, startClientY: e.clientY, startNoteX: note.x, startNoteY: note.y, moved: false };

    const onMv = (me) => {
      if (!dragState.current) return;
      const dist = Math.hypot(me.clientX - dragState.current.startClientX, me.clientY - dragState.current.startClientY);
      if (dist > 5) {
        if (!dragState.current.moved) { dragState.current.moved = true; setDragging(true); }
        onMove(note.id, dragState.current.startNoteX + (me.clientX - dragState.current.startClientX) / z, dragState.current.startNoteY + (me.clientY - dragState.current.startClientY) / z);
      }
    };
    const onUp = () => {
      if (!dragState.current?.moved) setEditing(true);
      dragState.current = null; setDragging(false);
      window.removeEventListener("mousemove", onMv);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMv);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      style={{ position: "absolute", left: note.x, top: note.y, zIndex: dragging ? 50 : 5, minWidth: 120, maxWidth: 280 }}
      onMouseDown={handleMouseDown}
      onClick={e => e.stopPropagation()}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}>
      {editing ? (
        <textarea ref={taRef} value={draft}
          onChange={e => { setDraft(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); } if (e.key === "Escape") { setEditing(false); setDraft(note.text); } }}
          style={{ width: 240, minHeight: 34, padding: "5px 9px", fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, lineHeight: 1.6, border: "1.5px solid " + accent + "99", borderRadius: 7, background: "var(--color-background-primary)", color: "var(--color-text-primary)", resize: "none", outline: "none", boxSizing: "border-box", display: "block", overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }} />
      ) : (
        <div style={{ position: "relative", display: "inline-block" }}>
          <div style={{ border: "1px solid " + (hov ? accent + "66" : "var(--color-border-secondary)"), borderRadius: 7, padding: "5px 10px", fontSize: 12, fontFamily: "'Inter',system-ui,sans-serif", color: "var(--color-text-primary)", background: "var(--color-background-primary)", cursor: dragging ? "grabbing" : "grab", lineHeight: 1.5, whiteSpace: "pre-wrap", maxWidth: 260, transition: "border-color 0.12s", userSelect: "none" }}>
            {note.text}
          </div>
          {hov && !dragging && (
            <div onClick={e => { e.stopPropagation(); onDelete(note.id); }}
              style={{ position: "absolute", top: -7, right: -7, width: 16, height: 16, borderRadius: "50%", background: "#64748b", color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", lineHeight: 1 }}>×</div>
          )}
        </div>
      )}
    </div>
  );
});
