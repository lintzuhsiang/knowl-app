import { useState, useRef, useEffect } from "react";

export default function SearchPalette({ nodes, accent, bookmarks, onNavigate, onClose }) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const all = Object.values(nodes);
  const filtered = query.trim()
    ? all.filter(n => {
        const q = query.toLowerCase();
        return n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
      })
    : all;

  // Bookmarked nodes first, then alphabetical
  const sorted = filtered.sort((a, b) => {
    const aB = bookmarks.includes(a.id) ? 0 : 1;
    const bB = bookmarks.includes(b.id) ? 0 : 1;
    if (aB !== bB) return aB - bB;
    return a.title.localeCompare(b.title);
  });

  const pick = id => { onNavigate(id); };

  const onKey = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, sorted.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && sorted[idx]) { e.preventDefault(); pick(sorted[idx].id); }
    else if (e.key === "Escape") onClose();
  };

  useEffect(() => { setIdx(0); }, [query]);

  return (
    <div onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 9000, paddingTop: 80 }}>
      <div style={{ background: "var(--color-background-primary)", borderRadius: 14, border: "0.5px solid var(--color-border-secondary)", width: "100%", maxWidth: 440, fontFamily: "'Inter',system-ui,sans-serif", overflow: "hidden", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", animation: "fadeIn 0.12s ease" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "0.5px solid var(--color-border-tertiary)", gap: 8 }}>
          <span style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>/</span>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey}
            placeholder="Search nodes..."
            style={{ flex: 1, fontFamily: "inherit", fontSize: 13, border: "none", background: "transparent", color: "var(--color-text-primary)", outline: "none" }} />
          <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", padding: "2px 6px", borderRadius: 4, background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)" }}>esc</span>
        </div>
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {sorted.length === 0 && <div style={{ padding: "20px 14px", textAlign: "center", fontSize: 12, color: "var(--color-text-tertiary)" }}>No matching nodes</div>}
          {sorted.slice(0, 20).map((n, i) => (
            <div key={n.id} onClick={() => pick(n.id)}
              onMouseEnter={() => setIdx(i)}
              style={{ padding: "8px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, background: i === idx ? accent + "0c" : "transparent", borderLeft: i === idx ? "2px solid " + accent : "2px solid transparent", transition: "background 0.08s" }}>
              {bookmarks.includes(n.id) && <span style={{ fontSize: 10, color: "#f59e0b", flexShrink: 0 }}>{"\u2605"}</span>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</div>
                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.body.replace(/^#+ /gm, "").slice(0, 60)}</div>
              </div>
              {n.nodeType && n.nodeType !== "text" && <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 100, background: "var(--color-background-secondary)", color: "var(--color-text-tertiary)", border: "0.5px solid var(--color-border-tertiary)" }}>{n.nodeType}</span>}
            </div>
          ))}
        </div>
        <div style={{ padding: "6px 14px", borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", gap: 12, fontSize: 10, color: "var(--color-text-tertiary)" }}>
          <span>{"\u2191\u2193"} navigate</span>
          <span>{"\u21b5"} open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
