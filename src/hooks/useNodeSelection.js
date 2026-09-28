import { useState, useRef, useMemo, useCallback } from "react";

/**
 * Owns node-selection state for the canvas.
 *
 *   sel               array of selected node ids (multi-select)
 *   setSel            setter (accepts array OR updater fn)
 *   hov               id of currently hovered node (or null)
 *   setHov            setter
 *   focusNodeId       id of "focus" node (filter dimming neighbors), or null
 *   setFocusNodeId    setter — accepts an id OR an updater fn
 *   toggleFocus(id)   convenience: if focused, clear; else focus on id
 *   selRef            ref always tracking latest `sel` (for handlers
 *                     that should not re-bind on every selection change,
 *                     e.g. keyboard shortcuts)
 *   selNodes          memoized array of the actual node objects for
 *                     the current selection (filters out missing)
 *   clearSelection()  sel = [], hov = null (does NOT touch focus)
 *
 * Returned setters use stable identities so passing them into deps
 * arrays doesn't churn callbacks unnecessarily.
 */
export default function useNodeSelection(nodeMap = null) {
  const [sel, setSel] = useState([]);
  const [hov, setHov] = useState(null);
  const [focusNodeId, setFocusNodeId] = useState(null);

  // Ref mirror — for keyboard shortcuts and drag handlers
  const selRef = useRef(sel);
  selRef.current = sel;

  const selNodes = useMemo(
    () => (nodeMap ? sel.map((id) => nodeMap[id]).filter(Boolean) : []),
    [sel, nodeMap]
  );

  const clearSelection = useCallback(() => {
    setSel([]);
    setHov(null);
  }, []);

  const toggleFocus = useCallback((id) => {
    setFocusNodeId((cur) => (cur ? null : id));
  }, []);

  return {
    sel, setSel,
    hov, setHov,
    focusNodeId, setFocusNodeId,
    selRef,
    selNodes,
    clearSelection,
    toggleFocus,
  };
}
