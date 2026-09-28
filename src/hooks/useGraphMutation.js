import { useState, useCallback } from "react";
import { uid } from "../lib/constants";

/**
 * Owns canvas-scoped graph mutation primitives + undo history.
 *
 *   mut(fn)               — apply a node-map mutation on the CURRENT canvas
 *                           (reads canvasKey from the passed-in ref so it
 *                           always targets whichever canvas is on screen).
 *   pushUndo()            — snapshot the full graph; returns the deep clone
 *                           so callers can pass it back to addToast for "undo".
 *   undo()                — pop most recent snapshot back into graph state.
 *   history               — array of snapshots (length capped at 20).
 *
 * Inline-note helpers live here too because they're another flavor of
 * graph mutation that needs canvasKey scoping.
 *
 * @param graphRef       ref tracking latest graph state (read-only)
 * @param setGraph       React setter for graph
 * @param canvasKeyRef   ref tracking current canvas key (root topic or drill key)
 */
export default function useGraphMutation({ graphRef, setGraph, canvasKeyRef }) {
  const [history, setHistory] = useState([]);

  const mut = useCallback((fn) => {
    const key = canvasKeyRef.current;
    setGraph((prev) => {
      const g = Object.assign({}, prev);
      const canvas = g[key] || { label: key, nodeMap: {}, edges: [] };
      const nm = Object.assign({}, canvas.nodeMap);
      fn(nm);
      g[key] = Object.assign({}, canvas, { nodeMap: nm });
      return g;
    });
  }, [canvasKeyRef, setGraph]);

  /**
   * Like `mut` but for ops that need to touch BOTH nodeMap AND edges in one
   * atomic update. `fn` receives a draft `{nodeMap, edges}` and MUST return
   * the new shape (can be partial — undefined fields fall back to canvas).
   *
   * Used by applySuggestion for merge / link / unlink / delete which all
   * touch nodes and edges together.
   */
  const mutCanvas = useCallback((fn) => {
    const key = canvasKeyRef.current;
    setGraph((prev) => {
      const g = Object.assign({}, prev);
      const canvas = g[key] || { label: key, nodeMap: {}, edges: [] };
      const draft = {
        nodeMap: Object.assign({}, canvas.nodeMap),
        edges:   [...(canvas.edges || [])],
      };
      const next = fn(draft) || draft;
      g[key] = Object.assign({}, canvas, {
        nodeMap: next.nodeMap || draft.nodeMap,
        edges:   next.edges   || draft.edges,
      });
      return g;
    });
  }, [canvasKeyRef, setGraph]);

  const pushUndo = useCallback(() => {
    const saved = JSON.parse(JSON.stringify(graphRef.current));
    setHistory((prev) => [...prev.slice(-19), saved]);
    return saved;
  }, [graphRef]);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      setGraph(prev[prev.length - 1]);
      return prev.slice(0, -1);
    });
  }, [setGraph]);

  // ── Inline notes (per-canvas free-positioned text blocks) ────────────────
  const addInlineNote = useCallback((x, y, text) => {
    setGraph((prev) => {
      const key = canvasKeyRef.current;
      const g = Object.assign({}, prev);
      const canvas = g[key] || { label: key, nodeMap: {}, edges: [], inlineNotes: [] };
      const note = { id: uid(), x, y, text };
      g[key] = Object.assign({}, canvas, { inlineNotes: [...(canvas.inlineNotes || []), note] });
      return g;
    });
  }, [canvasKeyRef, setGraph]);

  const updateInlineNote = useCallback((noteId, text) => {
    setGraph((prev) => {
      const key = canvasKeyRef.current;
      const g = Object.assign({}, prev);
      const canvas = g[key]; if (!canvas) return prev;
      g[key] = Object.assign({}, canvas, {
        inlineNotes: (canvas.inlineNotes || []).map((n) =>
          n.id === noteId ? Object.assign({}, n, { text }) : n
        ),
      });
      return g;
    });
  }, [canvasKeyRef, setGraph]);

  const deleteInlineNote = useCallback((noteId) => {
    setGraph((prev) => {
      const key = canvasKeyRef.current;
      const g = Object.assign({}, prev);
      const canvas = g[key]; if (!canvas) return prev;
      g[key] = Object.assign({}, canvas, {
        inlineNotes: (canvas.inlineNotes || []).filter((n) => n.id !== noteId),
      });
      return g;
    });
  }, [canvasKeyRef, setGraph]);

  const moveInlineNote = useCallback((noteId, x, y) => {
    setGraph((prev) => {
      const key = canvasKeyRef.current;
      const g = Object.assign({}, prev);
      const canvas = g[key]; if (!canvas) return prev;
      g[key] = Object.assign({}, canvas, {
        inlineNotes: (canvas.inlineNotes || []).map((n) =>
          n.id === noteId ? Object.assign({}, n, { x, y }) : n
        ),
      });
      return g;
    });
  }, [canvasKeyRef, setGraph]);

  return {
    history, setHistory,
    mut, mutCanvas, pushUndo, undo,
    addInlineNote, updateInlineNote, deleteInlineNote, moveInlineNote,
  };
}
