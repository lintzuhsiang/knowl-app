import { useState, useEffect, useRef, useCallback } from "react";
import { NW, uid } from "../lib/constants";
import { getAnchors } from "../lib/utils";

/**
 * Bundles all the transient input/edit overlay state and the
 * "tap on canvas / tap on node" creation handlers.
 *
 * State owned by this hook:
 *   newTopicInput     — string (typing a new topic name) or null
 *   contextCapture    — { nodeId } when the after-create context-capture popover is open
 *   templateMenu      — { x, y, screenX, screenY } when the template picker is open
 *   nodeChatId        — id of the node being modified via right-click chat
 *   touchEditId       — id of the node that should focus-and-edit on next render
 *   quickTextPos      — { x, y } for the floating quick-text input under the cursor
 *
 * Refs:
 *   quickTextCommitRef — the floating quick-text input registers its commit fn here
 *                        so canvas drags / pan-zoom can flush+close the input cleanly.
 *
 * Handlers (return a new node id + open context capture / edit on the result):
 *   handleCanvasDbl   — desktop double-click on empty canvas
 *   touchCanvasDoubleTap — touch double-tap on empty canvas
 *   touchNodeDoubleTap   — touch double-tap on an existing node (enter edit)
 *   touchAnchorDown      — touch-down on a node anchor (start edge draw)
 *   touchFinishEdge      — touch-up while drawing → commit edge if snapped
 *
 * Auto-clear: when `touchEditId` flips truthy it auto-resets after 100ms so the
 * "edit" intent only fires once and doesn't get re-applied on every render.
 *
 * @param mut         atomic nodeMap mutator
 * @param setSel      selection setter (focus the new node)
 * @param setGraph    graph setter (used by touchFinishEdge)
 * @param setDrawing  drawing-state setter (touch edge drag)
 * @param cvRef       canvas div ref (used to compute click-relative coords)
 * @param toCanvas    (screenX, screenY) → canvas (x, y) helper
 * @param canvasSingleClickTimer  ref so handleCanvasDbl can cancel a pending quick-text
 * @param canvasKeyRef ref tracking current canvas key
 * @param graphRef    ref tracking latest graph
 * @param panRef      ref tracking latest pan
 * @param zoomRef     ref tracking latest zoom
 */
export default function useNodeInput({
  mut,
  setSel,
  setGraph,
  setDrawing,
  cvRef,
  toCanvas,
  canvasSingleClickTimer,
  canvasKeyRef,
  graphRef,
  panRef,
  zoomRef,
}) {
  // ── State ────────────────────────────────────────────────────────────────
  const [newTopicInput,  setNewTopicInput]  = useState(null);
  const [contextCapture, setContextCapture] = useState(null);
  const [templateMenu,   setTemplateMenu]   = useState(null);
  const [nodeChatId,     setNodeChatId]     = useState(null);
  const [touchEditId,    setTouchEditId]    = useState(null);
  const [quickTextPos,   setQuickTextPos]   = useState(null);

  // Floating quick-text input registers its commit fn here so canvas
  // gestures (pan/drag) can flush + close cleanly.
  const quickTextCommitRef = useRef(null);

  // touchEditId is a one-shot intent — auto-clear so it doesn't stick.
  useEffect(() => {
    if (touchEditId) {
      const t = setTimeout(() => setTouchEditId(null), 100);
      return () => clearTimeout(t);
    }
  }, [touchEditId]);

  // ── Node-creation handlers ───────────────────────────────────────────────
  // Builds the standard "blank" node shape at (x, y) and returns its id.
  const createBlankNode = useCallback((x, y) => {
    const nid = uid();
    const nx = Math.max(20, x - NW / 2);
    const ny = Math.max(20, y - 60);
    mut(nm => { nm[nid] = { id: nid, x: nx, y: ny, h: 80, w: null, title: "New node", body: "- ", summary: null, confidence: null, conflict: null, tag: "core", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" }; });
    return nid;
  }, [mut]);

  // Desktop double-click on empty canvas → new node + open context capture + enter edit
  const handleCanvasDbl = useCallback(e => {
    if (e.target !== cvRef.current) return;
    const rect = cvRef.current.getBoundingClientRect();
    const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const nid = createBlankNode(x, y);
    setSel([nid]);
    setContextCapture({ nodeId: nid });
    setTouchEditId(nid);
    // Cancel any pending single-click quick-text
    if (canvasSingleClickTimer.current) { clearTimeout(canvasSingleClickTimer.current); canvasSingleClickTimer.current = null; }
    setQuickTextPos(null);
  }, [createBlankNode, setSel, cvRef, toCanvas, canvasSingleClickTimer]);

  // Touch: double-tap on empty canvas → new node + open context capture
  const touchCanvasDoubleTap = useCallback((sx, sy) => {
    const { x, y } = toCanvas(sx, sy);
    const nid = createBlankNode(x, y);
    setSel([nid]);
    setContextCapture({ nodeId: nid });
  }, [createBlankNode, setSel, toCanvas]);

  // Touch: double-tap on an existing node → enter edit
  const touchNodeDoubleTap = useCallback(nodeId => {
    setTouchEditId(nodeId);
    setSel([nodeId]);
  }, [setSel]);

  // Touch: start edge draw from a node anchor
  const touchAnchorDown = useCallback((fid, dir) => {
    const n = graphRef.current[canvasKeyRef.current]?.nodeMap[fid]; if (!n) return;
    const a = getAnchors(n).find(x => x.dir === dir);
    const z = zoomRef.current, p = panRef.current;
    setDrawing({ fromId: fid, x1: a.x * z + p.x, y1: a.y * z + p.y, x2: a.x * z + p.x, y2: a.y * z + p.y, snap: null });
  }, [graphRef, canvasKeyRef, panRef, zoomRef, setDrawing]);

  // Touch: end edge draw → commit if snapped to a node, dedupe existing
  const touchFinishEdge = useCallback(() => {
    setDrawing(prev => {
      if (prev?.snap) {
        const eid = uid();
        setGraph(g => {
          const ng = Object.assign({}, g);
          const ck = canvasKeyRef.current;
          const already = ng[ck].edges.find(ed => (ed.from === prev.fromId && ed.to === prev.snap.nodeId) || (ed.from === prev.snap.nodeId && ed.to === prev.fromId));
          if (!already) ng[ck] = Object.assign({}, ng[ck], { edges: [...ng[ck].edges, { id: eid, from: prev.fromId, to: prev.snap.nodeId, label: "", dash: false }] });
          return ng;
        });
      }
      return null;
    });
  }, [setDrawing, setGraph, canvasKeyRef]);

  return {
    // State
    newTopicInput, contextCapture, templateMenu, nodeChatId, touchEditId, quickTextPos,
    // Setters (consumed by callers + cross-hook resets like topic switch)
    setNewTopicInput, setContextCapture, setTemplateMenu, setNodeChatId, setTouchEditId, setQuickTextPos,
    // Refs
    quickTextCommitRef,
    // Handlers
    handleCanvasDbl, touchCanvasDoubleTap, touchNodeDoubleTap, touchAnchorDown, touchFinishEdge,
  };
}
