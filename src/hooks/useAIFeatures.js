import { useState, useRef, useCallback } from "react";
import { api, getText, parseJ } from "../lib/api";
import { uid } from "../lib/constants";
import { findEmptySpot } from "../lib/graphHelpers";

/**
 * Bundle of "AI-assist" features that talk to the LLM and surface
 * inspectable previews to the user.
 *
 *  1. Gap scan        — find missing concepts + latent conflicts in the map
 *  2. Auto-link       — suggest 1-3 missing edges between existing nodes
 *  3. Fusion mapping  — map incoming free-text notes onto existing nodes
 *                       (update / conflict / new)
 *
 * State owned by this hook:
 *   gapDataMap          — { [topic]: { gaps, latentConflicts, suggestions } }
 *   gapScanState        — "idle" | "scanning" | "done"
 *   fusionPreview       — array of mappings awaiting user confirm, or null
 *   fusePhase           — "idle" | "thinking"
 *   autoLinkSuggestions — array of edge suggestions, or null
 *
 * `gapRef` mirrors `gapDataMap` so other parts of App.jsx (e.g. the digest
 * card useEffect, the openPanel callback) can read the latest value without
 * subscribing to re-renders.
 *
 * @param cur         current canvas object { label, nodeMap, edges }
 * @param topic       current topic key (gap data is stored per-topic)
 * @param pushUndo    snapshot helper that returns the previous graph
 * @param mut         atomic nodeMap mutator
 * @param addToast    toast notification helper
 * @param setSel      selection setter (for newly-created fusion nodes)
 * @param setGraph    graph setter (for accept-auto-link)
 * @param canvasKeyRef ref tracking current canvasKey
 */
export default function useAIFeatures({
  cur,
  topic,
  pushUndo,
  mut,
  addToast,
  setSel,
  setGraph,
  canvasKeyRef,
}) {
  const [gapDataMap, setGapDataMap]                 = useState({});
  const [gapScanState, setGapScanState]             = useState("idle");
  const [fusionPreview, setFusionPreview]           = useState(null);
  const [fusePhase, setFusePhase]                   = useState("idle");
  const [autoLinkSuggestions, setAutoLinkSuggestions] = useState(null);

  // gapRef mirrors gapDataMap for stale-closure-free reads in other effects
  const gapRef = useRef(gapDataMap); gapRef.current = gapDataMap;

  // ── 1. Gap scan ───────────────────────────────────────────────────────────
  const runGapScan = useCallback(async () => {
    setGapScanState("scanning");
    try {
      const nCtx = Object.values(cur.nodeMap).map(n => "id:\"" + n.id + "\" title:\"" + n.title + "\"\n" + n.body.replace(/^#+ /gm, "").slice(0, 250)).join("\n---\n");
      const eCtx = cur.edges.map(e => "\"" + e.from + "\" to \"" + e.to + "\" (" + e.label + ")").join("\n");
      const d = await api([{ role: "user", content: "Analyze knowledge map for \"" + cur.label + "\".\n\nNodes:\n" + nCtx + "\n\nEdges:\n" + eCtx + "\n\nFind: 1. Missing concepts (max 3). 2. Subtly contradictory nodes not yet marked (max 2). 3. Top 3 suggestions.\n\nReturn ONLY valid JSON:\n{\"gaps\":[{\"label\":\"...\",\"description\":\"...\",\"relatedNodeIds\":[\"nodeId\"]}],\"latentConflicts\":[{\"nodeAId\":\"nodeId\",\"nodeBId\":\"nodeId\",\"reason\":\"...\"}],\"suggestions\":[\"...\",\"...\",\"...\"]}" }], null, 700);
      const p = parseJ(getText(d));
      if (p) { setGapDataMap(prev => Object.assign({}, prev, { [topic]: p })); setGapScanState("done"); }
      else setGapScanState("idle");
    } catch (e) { setGapScanState("idle"); }
  }, [topic, cur]);

  // ── 2. Fusion mapping (incoming free-text → existing nodes) ───────────────
  const handleFuse = useCallback(async text => {
    setFusePhase("thinking");
    try {
      const nCtx = Object.values(cur.nodeMap).map(n => "id:\"" + n.id + "\" title:\"" + n.title + "\"\n" + n.body.replace(/^#+ /gm, "").slice(0, 200)).join("\n---\n");
      const d = await api([{ role: "user", content: "Map new notes to existing knowledge.\n\nExisting:\n" + nCtx + "\n\nNew notes:\n\"" + text + "\"\n\nFor each chunk: update / conflict / new.\n\nReturn ONLY valid JSON:\n{\"mappings\":[{\"type\":\"update\"|\"conflict\"|\"new\",\"nodeId\":\"existingId or null\",\"newTitle\":\"if new\",\"excerpt\":\"relevant phrase max 80 chars\",\"content\":\"what to add or new body\",\"conflictLabel\":\"if conflict\"}]}" }], null, 800);
      const p = parseJ(getText(d));
      if (p?.mappings?.length > 0) setFusionPreview(p.mappings);
      setFusePhase("idle");
    } catch (e) { setFusePhase("idle"); }
  }, [cur]);

  const applyFusion = useCallback(selected => {
    const saved = pushUndo();
    const newIds = [];
    mut(nm => {
      selected.forEach(m => {
        if (m.type === "update" && m.nodeId && nm[m.nodeId]) {
          nm[m.nodeId] = Object.assign({}, nm[m.nodeId], { body: nm[m.nodeId].body + "\n- " + m.content, summary: null });
        } else if (m.type === "conflict" && m.nodeId && nm[m.nodeId]) {
          nm[m.nodeId] = Object.assign({}, nm[m.nodeId], { conflict: { inp: m.content, label: m.conflictLabel || "New perspective", status: "unresolved" } });
        } else if (m.type === "new" && m.newTitle) {
          const nid = uid(); newIds.push(nid);
          const pos = findEmptySpot(nm);
          nm[nid] = { id: nid, x: pos.x, y: pos.y, h: 120, w: null, title: m.newTitle, body: "# " + m.newTitle + "\n" + (m.content || ""), summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" };
        }
      });
    });
    setFusionPreview(null);
    if (newIds.length > 0) setSel(newIds);
    addToast("Applied " + selected.length + " fusion change" + (selected.length !== 1 ? "s" : ""), () => { setGraph(saved); setSel([]); });
  }, [mut, pushUndo, addToast, setSel, setGraph]);

  // ── 3. Auto-link (suggest missing edges) ──────────────────────────────────
  const runAutoLink = useCallback(async () => {
    if (Object.keys(cur.nodeMap).length < 3) return;
    try {
      const nCtx = Object.values(cur.nodeMap).map(n => "id:\"" + n.id + "\" title:\"" + n.title + "\"").join("\n");
      const eCtx = cur.edges.map(e => e.from + " -> " + e.to).join("\n");
      const d = await api([{ role: "user", content: "Find missing links between nodes in this knowledge map.\n\nNodes:\n" + nCtx + "\n\nExisting edges:\n" + (eCtx || "(none)") + "\n\nSuggest 1-3 edges that should exist but are missing. Only suggest strong, obvious connections.\n\nReturn ONLY valid JSON:\n{\"suggestions\":[{\"from\":\"nodeId\",\"to\":\"nodeId\",\"label\":\"relationship\",\"reason\":\"why this link matters\"}]}" }], null, 300);
      const p = parseJ(getText(d));
      if (p?.suggestions?.length > 0) {
        const valid = p.suggestions.filter(s => cur.nodeMap[s.from] && cur.nodeMap[s.to] && !cur.edges.some(e => (e.from === s.from && e.to === s.to) || (e.from === s.to && e.to === s.from)));
        if (valid.length > 0) setAutoLinkSuggestions(valid);
      }
    } catch (e) { /* swallow */ }
  }, [cur]);

  const acceptAutoLink = useCallback(suggestion => {
    setGraph(prev => {
      const g = Object.assign({}, prev);
      const ck = canvasKeyRef.current;
      g[ck] = Object.assign({}, g[ck], { edges: [...g[ck].edges, { id: uid(), from: suggestion.from, to: suggestion.to, label: suggestion.label, dash: true }] });
      return g;
    });
    setAutoLinkSuggestions(prev => prev ? prev.filter(s => s !== suggestion) : null);
  }, [setGraph, canvasKeyRef]);

  return {
    // State
    gapDataMap, gapScanState, fusionPreview, fusePhase, autoLinkSuggestions,
    // External-write setters
    setGapDataMap, setGapScanState, setFusionPreview, setAutoLinkSuggestions,
    // Refs
    gapRef,
    // Actions
    runGapScan, handleFuse, applyFusion, runAutoLink, acceptAutoLink,
  };
}
