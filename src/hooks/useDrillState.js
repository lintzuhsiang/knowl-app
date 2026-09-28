import { useState, useCallback, useMemo } from "react";

/**
 * Owns drill-in state for sub-canvas navigation.
 *
 *   drillPath              [{id, title}, ...] — drill stack
 *   setDrillPath           low-level setter (use when bulk-setting, e.g. on
 *                          topic switch when you want to clear back to root)
 *   canvasKey              the composite key for the current canvas:
 *                          "topic"  or  "topic::drill::id1::drill::id2..."
 *   drillParentNode        the node we drilled INTO at the current level
 *                          (read from its containing canvas), or null at root
 *   updateDrillParentBody  edit the drill-parent's body in its containing
 *                          canvas (used by SubCanvasBody inline editor)
 *
 * This hook intentionally does NOT own the drill ACTION callbacks
 * (drillInto / drillBack). Those need access to setters from other hooks
 * (useNodeInput's setNodeChatId, viewport's resetViewport, etc.) and are
 * easier to keep in App.jsx as composers.
 *
 * @param topic     current root topic key
 * @param graph     full graph state
 * @param setGraph  React setter for graph (for updateDrillParentBody)
 */
export default function useDrillState({ topic, graph, setGraph }) {
  const [drillPath, setDrillPath] = useState([]);

  const canvasKey = useMemo(
    () => drillPath.length === 0
      ? topic
      : topic + "::drill::" + drillPath.map(d => d.id).join("::drill::"),
    [topic, drillPath]
  );

  // Parent canvas key for the current drill level (i.e. the canvas that
  // CONTAINS the drill-parent node). At drill depth 1 that's the root topic.
  const parentCanvasKey = useMemo(() => {
    if (drillPath.length === 0) return null;
    if (drillPath.length === 1) return topic;
    return topic + "::drill::" + drillPath.slice(0, -1).map(d => d.id).join("::drill::");
  }, [topic, drillPath]);

  const drillParentNode = useMemo(() => {
    if (!parentCanvasKey) return null;
    const entry = drillPath[drillPath.length - 1];
    return graph[parentCanvasKey]?.nodeMap?.[entry.id] || null;
  }, [parentCanvasKey, drillPath, graph]);

  const updateDrillParentBody = useCallback((newBody) => {
    if (!parentCanvasKey) return;
    const entry = drillPath[drillPath.length - 1];
    setGraph(prev => {
      const g = Object.assign({}, prev);
      const canvas = g[parentCanvasKey]; if (!canvas) return prev;
      const nm = Object.assign({}, canvas.nodeMap);
      nm[entry.id] = Object.assign({}, nm[entry.id], { body: newBody, summary: null });
      g[parentCanvasKey] = Object.assign({}, canvas, { nodeMap: nm });
      return g;
    });
  }, [parentCanvasKey, drillPath, setGraph]);

  return {
    drillPath, setDrillPath,
    canvasKey,
    drillParentNode,
    updateDrillParentBody,
  };
}
