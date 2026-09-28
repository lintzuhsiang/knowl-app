import { useEffect } from "react";
import { uid } from "../lib/constants";

/**
 * Global keyboard shortcut handler. Owns the document-level `keydown` listener
 * that powers Cmd+K (search), Cmd+Z (undo), Cmd+C / Cmd+V (clipboard),
 * Cmd+D (duplicate), Delete/Backspace (remove), and Escape (dismiss overlays).
 *
 * State is read through refs (historyRef, graphRef, canvasKeyRef, clipboardRef,
 * selRef) so the handler always sees the latest values without re-subscribing
 * to `keydown` on every state change. Setters and the `mut` / `pushUndo` /
 * `addToast` helpers are stable references — the listener re-attaches only if
 * the host re-creates them.
 *
 * Skips when the focused element is an INPUT or TEXTAREA so typed letters
 * (e.g. "c" mid-word) don't trigger copy.
 */
export default function useKeyboardShortcuts({
  // Setters
  setSearchOpen,
  setSel,
  setGraph,
  setClipboard,
  setHistory,
  setNodeChatId,
  setTemplateMenu,
  // Refs (current state without re-subscribing)
  historyRef,
  graphRef,
  canvasKeyRef,
  clipboardRef,
  selRef,
  // Stable callbacks
  mut,
  pushUndo,
  addToast,
}) {
  useEffect(() => {
    const fn = e => {
      // Cmd/Ctrl+K — toggle search palette
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(o => !o);
      }
      // Cmd/Ctrl+Z — undo
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        const hist = historyRef.current;
        if (hist.length === 0) return;
        setGraph(hist[hist.length - 1]);
        setSel([]);
        setHistory(hist.slice(0, -1));
      }
      // Cmd/Ctrl+C — copy selected nodes
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
        const canvas = graphRef.current[canvasKeyRef.current];
        const selNow = canvas ? Object.values(canvas.nodeMap).filter(n => selRef.current.includes(n.id)) : [];
        if (selNow.length > 0) setClipboard(selNow);
      }
      // Cmd/Ctrl+V — paste copied nodes (+40px offset)
      if ((e.metaKey || e.ctrlKey) && e.key === "v" && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
        const cb = clipboardRef.current;
        if (cb.length === 0) return;
        e.preventDefault();
        const saved = pushUndo();
        const newIds = [];
        mut(nm => {
          cb.forEach(src => {
            const nid = uid();
            newIds.push(nid);
            nm[nid] = Object.assign({}, src, { id: nid, x: src.x + 40, y: src.y + 40, summary: null, conflict: null, tag: "new-domain" });
          });
        });
        setSel(newIds);
        addToast("Pasted " + cb.length + " node" + (cb.length > 1 ? "s" : ""), () => { setGraph(saved); setSel([]); });
      }
      // Escape — dismiss floating overlays
      if (e.key === "Escape") {
        setSearchOpen(false);
        setNodeChatId(null);
        setTemplateMenu(null);
      }
      // Delete / Backspace — remove selected nodes + their edges (skip when typing)
      if ((e.key === "Delete" || e.key === "Backspace") && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
        setSel(prev => {
          if (prev.length === 0) return prev;
          e.preventDefault();
          const saved = pushUndo();
          setGraph(g => {
            const ng = Object.assign({}, g);
            const ckey = canvasKeyRef.current;
            const nm = Object.assign({}, ng[ckey].nodeMap);
            prev.forEach(id => { delete nm[id]; });
            const edges = ng[ckey].edges.filter(ed => !prev.includes(ed.from) && !prev.includes(ed.to));
            ng[ckey] = Object.assign({}, ng[ckey], { nodeMap: nm, edges });
            return ng;
          });
          addToast("Deleted " + prev.length + " node" + (prev.length > 1 ? "s" : ""), () => { setGraph(saved); });
          return [];
        });
      }
      // Cmd/Ctrl+D — duplicate selected nodes (offset +30 so they don't exactly overlap)
      if ((e.metaKey || e.ctrlKey) && e.key === "d") {
        e.preventDefault();
        setSel(prev => {
          if (prev.length === 0) return prev;
          const nm = graphRef.current[canvasKeyRef.current]?.nodeMap || {};
          const newIds = [];
          mut(nmap => {
            prev.forEach(id => {
              const src = nm[id]; if (!src) return;
              const nid = uid();
              nmap[nid] = Object.assign({}, src, { id: nid, x: src.x + 30, y: src.y + 30, summary: null });
              newIds.push(nid);
            });
          });
          return newIds;
        });
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [pushUndo, mut, addToast, setSearchOpen, setSel, setGraph, setClipboard, setHistory, setNodeChatId, setTemplateMenu, historyRef, graphRef, canvasKeyRef, clipboardRef, selRef]);
}
