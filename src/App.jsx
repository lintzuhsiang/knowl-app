import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { api, getText, parseJ } from "./lib/api";
import { TOPIC_COLORS, NW, SR, MERGE_R, ZOOM_COMPACT, uid, IS_TOUCH } from "./lib/constants";
import useTouch from "./lib/useTouch";
import TouchFAB from "./components/TouchFAB";
import useServerSync from "./hooks/useServerSync";
import useKeyboardShortcuts from "./hooks/useKeyboardShortcuts";
import useAIFeatures from "./hooks/useAIFeatures";
import useNodeInput from "./hooks/useNodeInput";
import useGraphMutation from "./hooks/useGraphMutation";
import useDrillState from "./hooks/useDrillState";
import useCanvasViewport from "./hooks/useCanvasViewport";
import useNodeSelection from "./hooks/useNodeSelection";
import AuthGate from "./components/AuthGate";
import AccountSettingsModal from "./components/AccountSettingsModal";
import { nodeW, nodeH, getAnchors, nearest, rectsOverlap } from "./lib/utils";
import { buildGraph, findEmptySpot, NODE_TEMPLATES, buildContextPack } from "./lib/graphHelpers";
import { trackNodeView } from "./api/graphSync";
import { applySuggestion } from "./lib/applySuggestion";
import Toast from "./components/Toast";
import GhostNode from "./components/GhostNode";
import DigestCard from "./components/DigestCard";
import Edges from "./components/Edges";
import EdgeLabel from "./components/EdgeLabel";
import KNode from "./components/KNode";
import InputBar from "./components/InputBar";
import InlineNote from "./components/InlineNote";
import SubCanvasBody from "./components/SubCanvasBody";
import TopBar from "./components/TopBar";
import DrillBreadcrumb from "./components/DrillBreadcrumb";
import MultiSelectBar from "./components/MultiSelectBar";
import ConflictModal from "./components/modals/ConflictModal";
import FusionModal from "./components/modals/FusionModal";
import DocumentImportModal from "./components/modals/DocumentImportModal";
import NoteMigrationModal from "./components/modals/NoteMigrationModal";
import StudioPanel from "./components/panels/StudioPanel";
import ChatPanel from "./components/panels/ChatPanel";
import TensionPanel from "./components/panels/TensionPanel";
import NodeContextCapture from "./components/capture/NodeContextCapture";
import SearchPalette from "./components/SearchPalette";
import AutoLinkSuggestions from "./components/AutoLinkSuggestions";
import Minimap from "./components/Minimap";
import NodeChatPanel from "./components/NodeChatPanel";
import MD from "./components/MD";

export default function App() {
  const [graph, setGraph] = useState(buildGraph);
  const [topic, setTopic] = useState("system-design");
  // newTopicInput moved to useNodeInput
  // history state moved to useGraphMutation hook
  const [toasts, setToasts] = useState([]);
  // sel / hov / focusNodeId moved to useNodeSelection (declared after `cur` so selNodes can memoize)
  const [mergeTarget, setMergeTarget] = useState(null);
  const [pendingMerge, setPendingMerge] = useState(null); // { src, tgt, origX, origY }
  const [conflictNode, setConflictNode] = useState(null);
  const [drawing, setDrawing] = useState(null);
  const [lasso, setLasso] = useState(null);
  // pan / zoom state moved to useCanvasViewport hook
  const [topicViews, setTopicViews] = useState({}); // per-topic { pan, zoom }
  // drillPath state moved to useDrillState hook
  const [subBodyMaxH, setSubBodyMaxH] = useState(220); // px — draggable sub-canvas body height
  const [chatWidth, setChatWidth] = useState(320);     // px — draggable chat panel width
  const [merging, setMerging] = useState(false);
  const [tensionOpen, setTensionOpen] = useState(false);
  const [summaryGenState, setSummaryGenState] = useState("idle");
  const [rightPanel, setRightPanel] = useState(null);
  const [highlighted, setHighlighted] = useState([]);
  const [ghostNodes, setGhostNodes] = useState([]);
  // gapDataMap, gapScanState moved to useAIFeatures
  const [digestCard, setDigestCard] = useState(null);
  // fusionPreview, fusePhase moved to useAIFeatures
  // contextCapture moved to useNodeInput
  const [importModal, setImportModal] = useState(false);
  const [resizing, setResizing] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [noteMigrationModal, setNoteMigrationModal] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  // autoLinkSuggestions moved to useAIFeatures
  // focusNodeId moved to useNodeSelection
  const [savedViews, setSavedViews] = useState([]);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // templateMenu, nodeChatId, touchEditId (+auto-clear), quickTextPos moved to useNodeInput
  const [dropHint, setDropHint] = useState(false);

  // ── Chat panel state (keyed per canvas so switching topic / drill-in preserves convo) ──
  const [chatOpen, setChatOpen]         = useState(true);
  const [chatMessagesByKey, setChatMessagesByKey] = useState({}); // { [canvasKey]: Message[] }
  const [chatConceptsByKey, setChatConceptsByKey] = useState({}); // { [canvasKey]: Concept[] }

  // Track whether a lasso-modifier key (Cmd on Mac / Ctrl on Win) is held
  // Using a global listener is more reliable than reading e.metaKey on the synthetic mousedown event
  useEffect(() => {
    const onDown = e => { if (e.key === "Meta" || e.key === "Control") lassoKeyHeld.current = true; };
    const onUp   = e => { if (e.key === "Meta" || e.key === "Control") lassoKeyHeld.current = false; };
    // Use capture phase so we get the event before any element-level handlers
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup",   onUp,   true);
    return () => { window.removeEventListener("keydown", onDown, true); window.removeEventListener("keyup", onUp, true); };
  }, []);

  // Track whether Space is held — Space+drag = pan
  // Use BOTH a ref (for event handlers) and state (for cursor reactivity)
  const spaceHeld = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);
  useEffect(() => {
    const onDown = e => {
      if ((e.key === " " || e.code === "Space") && !["INPUT","TEXTAREA"].includes(e.target.tagName)) {
        e.preventDefault();
        if (!spaceHeld.current) { spaceHeld.current = true; setSpaceDown(true); }
      }
    };
    const onUp = e => {
      if (e.key === " " || e.code === "Space") { spaceHeld.current = false; setSpaceDown(false); }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup",   onUp,   true);
    return () => { window.removeEventListener("keydown", onDown, true); window.removeEventListener("keyup", onUp, true); };
  }, []);

  const nodeCountRef = useRef(0);

  const drag = useRef(null);
  const resizingRef = useRef(null);
  const cvRef = useRef(null);
  const hlTimers = useRef([]);
  const graphRef = useRef(graph); graphRef.current = graph;

  // ── Server sync (auth gate + startup load + debounced save + polling) ─────
  const { syncStatus, authNeeded, handleAuth } = useServerSync(graph, setGraph, graphRef);

  // ── Canvas viewport (pan / zoom / wheel) ──────────────────────────────────
  const {
    pan, setPan, zoom, setZoom,
    panRef, zoomRef, cSizeRef,
    toCanvas, resetViewport,
  } = useCanvasViewport({ cvRef, attachTrigger: authNeeded });

  const topicRef = useRef(topic); topicRef.current = topic;
  const topicViewsRef = useRef(topicViews); topicViewsRef.current = topicViews;

  // ── Drill-in state (drillPath, canvasKey, sub-canvas parent helpers) ──────
  const {
    drillPath, setDrillPath,
    canvasKey,
    drillParentNode,
    updateDrillParentBody,
  } = useDrillState({ topic, graph, setGraph });
  const canvasKeyRef = useRef(canvasKey);
  canvasKeyRef.current = canvasKey;

  // ── Graph mutation primitives (mut / pushUndo / undo / inline notes) ──────
  const {
    history, setHistory,
    mut, mutCanvas, pushUndo, undo,
    addInlineNote, updateInlineNote, deleteInlineNote, moveInlineNote,
  } = useGraphMutation({ graphRef, setGraph, canvasKeyRef });

  // Structural context pack for the current canvas (breadcrumb + drill-parent
  // body + in-canvas nodes/hierarchy/edges). Replaces flat node-title injection
  // used by ChatPanel (Feature 1) and later Tutor/Warmup modes (Feature 3).
  const contextPack = useMemo(
    () => buildContextPack(graph, topic, drillPath),
    [graph, topic, drillPath]
  );

  // Derive current-canvas chat slice + setters that write back into the per-key map.
  const chatMessages = chatMessagesByKey[canvasKey] || [];
  const chatConcepts = chatConceptsByKey[canvasKey] || [];
  const setChatMessages = useCallback(next => {
    setChatMessagesByKey(prev => {
      const cur = prev[canvasKey] || [];
      const val = typeof next === "function" ? next(cur) : next;
      return { ...prev, [canvasKey]: val };
    });
  }, [canvasKey]);
  const setChatConcepts = useCallback(next => {
    setChatConceptsByKey(prev => {
      const cur = prev[canvasKey] || [];
      const val = typeof next === "function" ? next(cur) : next;
      return { ...prev, [canvasKey]: val };
    });
  }, [canvasKey]);
  const drawingRef = useRef(drawing); drawingRef.current = drawing;
  // drillPathRef removed — dead code from Wave 1 refactor; drillPath now lives in useDrillState
  const canvasSingleClickTimer = useRef(null);
  // quickTextCommitRef moved to useNodeInput
  const canvasMouseDownPos = useRef(null); // track mousedown position to guard against accidental quick-text
  const lassoKeyHeld = useRef(false);      // tracks whether a lasso-modifier (Cmd/Ctrl) is currently held
  const lassoRef = useRef(lasso); lassoRef.current = lasso;
  const lassoJustFinished = useRef(false);
  const mergingRef = useRef(merging); mergingRef.current = merging;
  const historyRef = useRef(history); historyRef.current = history;
  const [clipboard, setClipboard] = useState([]); // copied node objects for paste
  const clipboardRef = useRef(clipboard); clipboardRef.current = clipboard;
  // selRef + selNodes provided by useNodeSelection (declared below after `cur`)
  const [cSize, setCSize] = useState({ w: 800, h: 480 });

  const topicKeys = useMemo(() => Object.keys(graph).filter(k => !k.includes("::drill::")), [graph]);
  const accent    = useMemo(() => TOPIC_COLORS[topicKeys.indexOf(topic) % TOPIC_COLORS.length], [topicKeys, topic]);
  const cur       = useMemo(() => graph[canvasKey] || { label: "", nodeMap: {}, edges: [] }, [graph, canvasKey]);
  const compact   = zoom < ZOOM_COMPACT;

  // ── Node selection (sel / hov / focusNodeId + selRef + selNodes) ──────────
  const {
    sel, setSel,
    hov, setHov,
    focusNodeId, setFocusNodeId,
    selRef,
    selNodes,
  } = useNodeSelection(cur.nodeMap);

  useLayoutEffect(() => {
    const el = cvRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => { const s = { w: e.contentRect.width, h: e.contentRect.height }; setCSize(s); cSizeRef.current = s; });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // BUG-4 FIX: Track node count to re-trigger summary generation for new nodes
  useEffect(() => {
    const count = Object.keys(cur.nodeMap).length;
    if (compact && count > nodeCountRef.current && summaryGenState === "done") {
      setSummaryGenState("idle");
    }
    nodeCountRef.current = count;
  }, [cur.nodeMap, compact, summaryGenState]);

  useEffect(() => {
    if (!compact || summaryGenState !== "idle") return;
    const need = Object.values(cur.nodeMap).filter(n => !n.summary);
    if (!need.length) { setSummaryGenState("done"); return; }
    setSummaryGenState("generating");
    const payload = need.map(n => "id:\"" + n.id + "\"\ntitle:\"" + n.title + "\"\nbody:\n" + n.body.replace(/^#+ /gm, "").slice(0, 300)).join("\n---\n");
    api([{ role: "user", content: "For each node, write a 1-sentence summary (max 12 words). Return JSON only: [{\"id\":\"...\",\"summary\":\"...\"},...]\n\n" + payload }], null, 400)
      .then(d => {
        const parsed = parseJ(getText(d));
        const arr = Array.isArray(parsed) ? parsed : [];
        if (arr.length > 0) setGraph(prev => { const key = canvasKeyRef.current; const g = Object.assign({}, prev), canvas = g[key] || {label:key,nodeMap:{},edges:[]}, nm = Object.assign({}, canvas.nodeMap); arr.forEach(item => { if (nm[item.id]) nm[item.id] = Object.assign({}, nm[item.id], { summary: item.summary }); }); g[key] = Object.assign({}, canvas, { nodeMap: nm }); return g; });
        setSummaryGenState("done");
      }).catch(() => setSummaryGenState("idle"));
  }, [compact, canvasKey, summaryGenState]);

  useEffect(() => {
    setSummaryGenState("idle"); setGhostNodes([]); setContextCapture(null);
    const d = gapRef.current[topic];
    if (d) {
      const fc = Object.values(graph[topic]?.nodeMap || {}).filter(n => n.confidence === "fuzzy" || n.confidence === "question").length;
      setDigestCard({ gaps: d.gaps?.length || 0, conflicts: d.latentConflicts?.length || 0, topSuggestion: d.suggestions?.[0] || null, fuzzyCount: fc });
      setGapScanState("done");
    } else setGapScanState("idle");
  }, [topic]);

  // mut, pushUndo, undo, inline-note helpers all live in useGraphMutation (above)
  // toCanvas + onWheel + viewport refs all live in useCanvasViewport (above)

  const addToast = (msg, fn) => { const id = uid(); setToasts(prev => [...prev, { id, message: msg, undoFn: fn }]); };
  const dismissToast = id => setToasts(prev => prev.filter(t => t.id !== id));

  // ── AI-assist features (gap scan, fusion, auto-link) ─────────────────────────
  const {
    gapDataMap, gapScanState, fusionPreview, fusePhase, autoLinkSuggestions,
    setGapDataMap, setGapScanState, setFusionPreview, setAutoLinkSuggestions,
    gapRef,
    runGapScan, handleFuse, applyFusion, runAutoLink, acceptAutoLink,
  } = useAIFeatures({ cur, topic, pushUndo, mut, addToast, setSel, setGraph, canvasKeyRef });



  /* ── Feature: Drag-and-drop file import ──────────────────────────────── */
  const onCanvasDragOver = useCallback(e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropHint(true); }, []);
  const onCanvasDragLeave = useCallback(() => setDropHint(false), []);
  const onCanvasDrop = useCallback(e => {
    e.preventDefault();
    setDropHint(false);
    const rect = cvRef.current.getBoundingClientRect();
    const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const nx = Math.max(20, x - 130), ny = Math.max(20, y - 60);

    // Handle dropped text/url
    const text = e.dataTransfer.getData("text/plain");
    if (text && (text.startsWith("http://") || text.startsWith("https://"))) {
      const nid = uid();
      let domain = ""; try { domain = new URL(text).hostname.replace("www.", ""); } catch {}
      mut(nm => { nm[nid] = { id: nid, x: nx, y: ny, h: 120, w: 260, title: domain || "Link", body: text, summary: null, confidence: null, conflict: null, tag: "core", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "link" }; });
      setSel([nid]);
      return;
    }

    // Handle dropped image files
    const files = Array.from(e.dataTransfer.files || []);
    let offset = 0;
    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
    files.forEach(file => {
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_FILE_SIZE) { addToast("Image too large (max 5 MB): " + file.name); return; }
        const reader = new FileReader();
        reader.onload = () => {
          const nid = uid();
          mut(nm => { nm[nid] = { id: nid, x: nx + offset, y: ny, h: 180, w: 280, title: file.name.replace(/\.[^.]+$/, ""), body: reader.result, summary: null, confidence: null, conflict: null, tag: "core", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "image" }; });
          setSel([nid]);
        };
        reader.readAsDataURL(file);
        offset += 300;
      }
    });
  }, [mut, toCanvas]);


  const applyTemplate = useCallback((tmpl, cx, cy) => {
    const nid = uid();
    mut(nm => { nm[nid] = { id: nid, x: cx - (tmpl.w || 260) / 2, y: cy - 60, h: tmpl.h || 120, w: tmpl.w || null, title: tmpl.title, body: tmpl.body, summary: null, confidence: null, conflict: null, tag: "core", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: tmpl.nodeType || "text" }; });
    setSel([nid]);
    setTemplateMenu(null);
  }, [mut]);

  /* ── Feature: Canvas view bookmarks ──────────────────────────────────── */
  const saveView = useCallback(() => {
    const name = "View " + (savedViews.length + 1);
    setSavedViews(prev => [...prev, { name, pan: { ...pan }, zoom }]);
    addToast("Saved: " + name, () => {});
  }, [pan, zoom, savedViews.length]);

  const restoreView = useCallback(v => {
    setPan(v.pan);
    setZoom(v.zoom);
    setViewMenuOpen(false);
  }, []);

  const highlightNodes = useCallback(ids => {
    setHighlighted(ids); hlTimers.current.forEach(clearTimeout);
    hlTimers.current = [setTimeout(() => setHighlighted([]), 4000)];
  }, []);

  const highlightSequence = useCallback(ids => {
    hlTimers.current.forEach(clearTimeout); hlTimers.current = [];
    ids.forEach((id, i) => {
      const t = setTimeout(() => {
        const n = graphRef.current[canvasKeyRef.current]?.nodeMap[id];
        if (n) { const z = zoomRef.current, cs = cSizeRef.current; setPan({ x: cs.w / 2 - (n.x + nodeW(n) / 2) * z, y: cs.h / 2 - (n.y + nodeH(n) / 2) * z }); setHighlighted([id]); }
      }, i * 2200);
      hlTimers.current.push(t);
    });
    hlTimers.current.push(setTimeout(() => setHighlighted([]), ids.length * 2200 + 1500));
  }, []);

  // onWheel + wheel-listener attachment moved into useCanvasViewport

  const onNodeDown = useCallback((e, id) => {
    if (e.detail >= 2) return; // Don't start drag on double-click — let onDoubleClick fire cleanly
    e.preventDefault(); e.stopPropagation();
    const n = graphRef.current[canvasKeyRef.current]?.nodeMap[id];
    if (!n) return;

    // Space + drag on a node → pan (treat same as canvas pan)
    if (spaceHeld.current) {
      drag.current = { type: "pan", startX: e.clientX, startY: e.clientY, ox: panRef.current.x, oy: panRef.current.y };
      setIsDragging(true);
      return;
    }

    // Shift + drag from node body → start drawing an edge from this node
    if (e.shiftKey) {
      const a = getAnchors(n);
      // Pick the anchor nearest the mouse
      const rect = cvRef.current?.getBoundingClientRect();
      const z = zoomRef.current, p = panRef.current;
      const mx = rect ? (e.clientX - rect.left - p.x) / z : n.x;
      const my = rect ? (e.clientY - rect.top  - p.y) / z : n.y;
      const near = a.reduce((best, anch) => {
        const d = Math.hypot(anch.x - mx, anch.y - my);
        return d < best.d ? { anch, d } : best;
      }, { anch: a[0], d: Infinity }).anch;
      setDrawing({
        fromId: id,
        x1: near.x * z + p.x, y1: near.y * z + p.y,
        x2: near.x * z + p.x, y2: near.y * z + p.y,
        snap: null,
      });
      return;
    }

    // Alt/Option + drag → duplicate the node and drag the copy
    if (e.altKey) {
      const nid = uid();
      const ox = e.clientX - (n.x + 24) * zoom - pan.x;
      const oy = e.clientY - (n.y + 24) * zoom - pan.y;
      mut(nm => { nm[nid] = Object.assign({}, n, { id: nid, x: n.x + 24, y: n.y + 24, summary: null, conflict: null, tag: "new-domain" }); });
      drag.current = { type: "node", id: nid, ox, oy, origX: n.x + 24, origY: n.y + 24 };
      setIsDragging(true);
      setSel([nid]);
      return;
    }

    // Plain drag → move node
    drag.current = { type: "node", id, ox: e.clientX - n.x * zoom - pan.x, oy: e.clientY - n.y * zoom - pan.y, origX: n.x, origY: n.y };
    setIsDragging(true);
    // Shift also adds to selection (handled via modifier here for multi-select click)
    setSel(prev => prev.includes(id) ? prev : [id]);
  }, [pan, zoom, mut]);

  const onCanvasDown = useCallback(e => {
    if (e.target !== cvRef.current) return;
    canvasMouseDownPos.current = { x: e.clientX, y: e.clientY };
    const rect = cvRef.current.getBoundingClientRect();
    const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);

    // Space + drag → pan the canvas (highest priority)
    if (spaceHeld.current) {
      drag.current = { type: "pan", startX: e.clientX, startY: e.clientY, ox: pan.x, oy: pan.y };
      setIsDragging(true);
      return;
    }

    // Cmd/Ctrl + drag on empty canvas → draw a custom-size node
    if (e.metaKey || e.ctrlKey || lassoKeyHeld.current) {
      drag.current = { type: "nodeCreate", x1: x, y1: y, x2: x, y2: y };
      return;
    }

    // Plain drag on canvas → lasso box-select
    drag.current = { type: "lasso", x1: x, y1: y };
    const start = { x1: x, y1: y, x2: x, y2: y };
    lassoRef.current = start;
    setLasso(start);
  }, [pan, zoom]);

  const onAnchorDown = useCallback((e, fid, dir) => {
    e.preventDefault(); e.stopPropagation();
    const n = graphRef.current[canvasKeyRef.current]?.nodeMap[fid]; if (!n) return; const a = getAnchors(n).find(x => x.dir === dir);
    setDrawing({ fromId: fid, x1: a.x * zoom + pan.x, y1: a.y * zoom + pan.y, x2: a.x * zoom + pan.x, y2: a.y * zoom + pan.y, snap: null });
  }, [pan, zoom]);

  const onResizeStart = useCallback((e, id, dir) => {
    const n = graphRef.current[canvasKeyRef.current]?.nodeMap[id];
    if (!n) return;
    const r = { nodeId: id, dir, startX: e.clientX, startY: e.clientY, origW: nodeW(n), origH: nodeH(n), origX: n.x, origY: n.y };
    resizingRef.current = r;
    setResizing(r);
  }, []);

  const toggleCollapse = useCallback(id => {
    mut(nm => { nm[id] = Object.assign({}, nm[id], { collapsed: !nm[id].collapsed }); });
  }, [mut]);

  // ── Node-creation input layer (canvas dbl-click, touch taps, edge draw) ────
  const {
    newTopicInput, contextCapture, templateMenu, nodeChatId, touchEditId, quickTextPos,
    setNewTopicInput, setContextCapture, setTemplateMenu, setNodeChatId, setTouchEditId, setQuickTextPos,
    quickTextCommitRef,
    handleCanvasDbl: onCanvasDbl,
    touchCanvasDoubleTap, touchNodeDoubleTap, touchAnchorDown, touchFinishEdge,
  } = useNodeInput({
    mut, setSel, setGraph, setDrawing,
    cvRef, toCanvas, canvasSingleClickTimer,
    canvasKeyRef, graphRef, panRef, zoomRef,
  });

  useTouch({
    cvRef, drag, panRef, zoomRef, setPan, setZoom,
    graphRef, topic: canvasKey, toCanvas, mut,
    setSel, setHov, setIsDragging, setMergeTarget,
    setDrawing, setTemplateMenu, setContextCapture,
    onCanvasDoubleTap: touchCanvasDoubleTap,
    onNodeDoubleTap: touchNodeDoubleTap,
    onAnchorDown: touchAnchorDown,
    onFinishEdge: touchFinishEdge,
  });

  // ── Keyboard shortcuts (Cmd+K, Cmd+Z, Cmd+C/V, Cmd+D, Delete, Escape) ───────
  useKeyboardShortcuts({
    setSearchOpen, setSel, setGraph, setClipboard, setHistory, setNodeChatId, setTemplateMenu,
    historyRef, graphRef, canvasKeyRef, clipboardRef, selRef,
    mut, pushUndo, addToast,
  });

  useEffect(() => {
    const mv = e => {
      if (resizingRef.current) {
        const r = resizingRef.current;
        const dx = (e.clientX - r.startX) / zoomRef.current;
        const dy = (e.clientY - r.startY) / zoomRef.current;
        const minW = 160, minH = 80;
        let nw = r.origW, nh = r.origH, nx = r.origX, ny = r.origY;
        const d = r.dir;
        if (d.includes("e")) nw = Math.max(minW, r.origW + dx);
        if (d.includes("w")) { const delta = Math.min(dx, r.origW - minW); nx = r.origX + delta; nw = r.origW - delta; }
        if (d.includes("s")) nh = Math.max(minH, r.origH + dy);
        if (d.includes("n")) { const delta = Math.min(dy, r.origH - minH); ny = r.origY + delta; nh = r.origH - delta; }
        mut(nm => { nm[r.nodeId] = Object.assign({}, nm[r.nodeId], { w: Math.round(nw), h: Math.round(nh), x: Math.round(nx), y: Math.round(ny) }); });
        return;
      }
      if (drag.current?.type === "node") {
        const { id, ox, oy } = drag.current;
        // BUG-6 FIX: Use refs instead of closure values for pan/zoom
        const curPan = panRef.current, curZoom = zoomRef.current;
        const nx = (e.clientX - ox - curPan.x) / curZoom, ny = (e.clientY - oy - curPan.y) / curZoom;
        mut(nm => { nm[id] = Object.assign({}, nm[id], { x: nx, y: ny }); });
        const nm = graphRef.current[canvasKeyRef.current]?.nodeMap || {}; let mt = null;
        for (const [nid, n] of Object.entries(nm)) { if (nid === id) continue; if (Math.hypot(nx + nodeW(nm[id] || {}) / 2 - (n.x + nodeW(n) / 2), ny + nodeH(nm[id] || {}) / 2 - (n.y + nodeH(n) / 2)) < MERGE_R) { mt = nid; break; } }
        setMergeTarget(mt);
      }
      if (drag.current?.type === "group") {
        const { startX, startY, origPositions } = drag.current;
        const curZoom = zoomRef.current;
        const dx = (e.clientX - startX) / curZoom, dy = (e.clientY - startY) / curZoom;
        mut(nm => { Object.entries(origPositions).forEach(([id, pos]) => { if (nm[id]) nm[id] = Object.assign({}, nm[id], { x: Math.round(pos.x + dx), y: Math.round(pos.y + dy) }); }); });
      }
      if (drag.current?.type === "pan") setPan({ x: drag.current.ox + (e.clientX - drag.current.startX), y: drag.current.oy + (e.clientY - drag.current.startY) });
      if (drag.current?.type === "lasso") {
        const rect = cvRef.current?.getBoundingClientRect(); if (!rect) return;
        const z = zoomRef.current, p = panRef.current;
        const x = (e.clientX - rect.left - p.x) / z;
        const y = (e.clientY - rect.top  - p.y) / z;
        const base = lassoRef.current || (drag.current ? { x1: drag.current.x1, y1: drag.current.y1, x2: x, y2: y } : null);
        const updated = base ? { ...base, x2: x, y2: y } : null;
        lassoRef.current = updated;
        setLasso(updated);
      }
      if (drag.current?.type === "nodeCreate") {
        const rect = cvRef.current?.getBoundingClientRect(); if (!rect) return;
        const z = zoomRef.current, p = panRef.current;
        const x = (e.clientX - rect.left - p.x) / z;
        const y = (e.clientY - rect.top  - p.y) / z;
        drag.current = { ...drag.current, x2: x, y2: y };
        // Trigger re-render of the ghost rect via lasso state (reuse lasso visual)
        setLasso({ x1: drag.current.x1, y1: drag.current.y1, x2: x, y2: y, isNodeCreate: true });
      }
      if (drawingRef.current) {
        const rect = cvRef.current?.getBoundingClientRect(); if (!rect) return;
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const curPan = panRef.current, curZoom = zoomRef.current;
        const cx = (sx - curPan.x) / curZoom, cy = (sy - curPan.y) / curZoom;
        const nm = graphRef.current[canvasKeyRef.current]?.nodeMap || {}; let snap = null;
        for (const [nid, n] of Object.entries(nm)) {
          if (nid === drawingRef.current.fromId) continue;
          const a = nearest(n, cx, cy); const ax = a.x * curZoom + curPan.x, ay = a.y * curZoom + curPan.y;
          if (Math.hypot(ax - sx, ay - sy) < SR) { snap = { nodeId: nid, anch: a, sx: ax, sy: ay }; break; }
        }
        setDrawing(prev => Object.assign({}, prev, { x2: snap ? snap.sx : sx, y2: snap ? snap.sy : sy, snap }));
      }
    };
    const up = async (e) => {
      setIsDragging(false);
      if (resizingRef.current) { resizingRef.current = null; setResizing(null); return; }
      if (drag.current?.type === "node" && !mergingRef.current) {
        const { id, origX, origY } = drag.current;
        const nm = graphRef.current[canvasKeyRef.current]?.nodeMap || {}; const srcNode = nm[id]; let lt = null;
        if (srcNode) { for (const [nid, n] of Object.entries(nm)) { if (nid === id) continue; if (Math.hypot(srcNode.x + nodeW(srcNode) / 2 - (n.x + nodeW(n) / 2), srcNode.y + nodeH(srcNode) / 2 - (n.y + nodeH(n) / 2)) < MERGE_R) { lt = nid; break; } } }
        if (lt) {
          const tgt = nm[lt];
          if (srcNode && tgt) {
            // Show confirm pill instead of auto-merging
            setPendingMerge({ src: srcNode, tgt, origX, origY });
          }
        }
        setMergeTarget(null);
      }
      if (drag.current?.type === "group") {
        // group drag complete – positions already updated live
      }
      // Lasso selection: compute final rect from drag start + mouseup position
      // (not from lassoRef which can be stale due to React 18 batching)
      if (drag.current?.type === "lasso" && drag.current.x1 !== undefined) {
        const rect = cvRef.current?.getBoundingClientRect();
        if (rect && e) {
          const z = zoomRef.current, p = panRef.current;
          const x2 = (e.clientX - rect.left - p.x) / z;
          const y2 = (e.clientY - rect.top  - p.y) / z;
          const { x1, y1 } = drag.current;
          const lx = Math.min(x1, x2), ly = Math.min(y1, y2);
          const lw = Math.abs(x2 - x1), lh = Math.abs(y2 - y1);
          // Skip selection for tiny accidental drags (< 3px) — treat as a click
          if (lw >= 3 || lh >= 3) {
            const caught = Object.values(graphRef.current[canvasKeyRef.current]?.nodeMap || {}).filter(n => rectsOverlap(lx, ly, lw, lh, n.x, n.y, nodeW(n), nodeH(n))).map(n => n.id);
            // Also catch InlineNotes inside the lasso rectangle (~120×30 bounding box)
            const caughtNotes = (graphRef.current[canvasKeyRef.current]?.inlineNotes || [])
              .filter(note => rectsOverlap(lx, ly, lw, lh, note.x, note.y, 120, 30))
              .map(note => note.id);
            if (caught.length > 0 || caughtNotes.length > 0) { setSel([...caught, ...caughtNotes]); }
            // Mark that a real lasso selection happened so onClick doesn't clear it
            lassoJustFinished.current = true;
            requestAnimationFrame(() => { lassoJustFinished.current = false; });
          }
        }
        setLasso(null);
        lassoRef.current = null;
      }
      // Cmd+drag: create a custom-size node from drawn rect
      if (drag.current?.type === "nodeCreate") {
        const { x1, y1, x2, y2 } = drag.current;
        const lx = Math.min(x1, x2), ly = Math.min(y1, y2);
        const lw = Math.abs(x2 - x1), lh = Math.abs(y2 - y1);
        if (lw >= 30 && lh >= 20) { // ignore tiny accidental Cmd+clicks
          pushUndo();
          const nid = uid();
          mut(nm => {
            nm[nid] = {
              id: nid, x: Math.round(lx), y: Math.round(ly),
              w: Math.round(lw), h: Math.round(lh),
              title: "New node", body: "- ",
              summary: null, confidence: null, conflict: null,
              tag: "core", relatedTo: null, parentId: null,
              collapsed: false, entryContext: null, nodeType: "text",
            };
          });
          setSel([nid]); setContextCapture({ nodeId: nid });
        }
        setLasso(null); lassoRef.current = null;
      }
      drag.current = null;
      // BUG-2 FIX: Edge creation no longer auto-sets parentId
      const curDrawing = drawingRef.current;
      if (curDrawing?.snap) {
        const eid = uid();
        setGraph(prev => { const g = Object.assign({}, prev); const ck = canvasKeyRef.current; const already = g[ck].edges.find(ed => (ed.from === curDrawing.fromId && ed.to === curDrawing.snap.nodeId) || (ed.from === curDrawing.snap.nodeId && ed.to === curDrawing.fromId)); if (!already) g[ck] = Object.assign({}, g[ck], { edges: [...g[ck].edges, { id: eid, from: curDrawing.fromId, to: curDrawing.snap.nodeId, label: "", dash: false }] }); return g; });
      }
      setDrawing(null);
    };
    window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
  }, [graph, mergeTarget, mut]);

  /* ── Auto-arrange: similarity-aware force-directed layout ──────────────── */
  const doAutoArrange = useCallback(() => {
    const nodes = Object.values(graphRef.current[canvasKeyRef.current]?.nodeMap || {});
    const edges = graphRef.current[canvasKeyRef.current]?.edges || [];
    if (nodes.length < 2) return;
    const saved = pushUndo();
    const N = nodes.length;

    // ── Jaccard text similarity between node bodies ──
    const bagOfWords = text => new Set(
      text.toLowerCase().replace(/[^\w ]/g, " ").split(/\s+/).filter(w => w.length > 3)
    );
    const simMatrix = {}; // "idA|idB" → 0..1
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = nodes[i], b = nodes[j];
        const wa = bagOfWords(a.title + " " + a.body);
        const wb = bagOfWords(b.title + " " + b.body);
        let inter = 0; wa.forEach(w => { if (wb.has(w)) inter++; });
        const union = new Set([...wa, ...wb]).size;
        simMatrix[a.id + "|" + b.id] = union === 0 ? 0 : inter / union;
      }
    }
    // Edge pairs get extra attraction
    const edgePairs = new Set(edges.map(e => e.from + "|" + e.to).concat(edges.map(e => e.to + "|" + e.from)));

    // ── Physics constants ──
    const REPEL       = 14000; // node-pair repulsion
    const OVERLAP_K   = 10;    // extra push when nodes overlap
    const EDGE_K      = 0.018; // edge spring
    const SIM_K       = 0.010; // similarity attraction
    const GRAVITY     = 0.004; // centroid pull (keeps graph together)
    const MAXSTEP     = 28;

    // Start from current positions (work in node-center space)
    const pos = {};
    nodes.forEach(n => pos[n.id] = { x: n.x + nodeW(n) / 2, y: n.y + nodeH(n) / 2 });

    for (let iter = 0; iter < 160; iter++) {
      const disp = {};
      nodes.forEach(n => disp[n.id] = { x: 0, y: 0 });

      // Gentle centroid gravity (prevents isolated nodes flying away)
      const gx = nodes.reduce((s, n) => s + pos[n.id].x, 0) / N;
      const gy = nodes.reduce((s, n) => s + pos[n.id].y, 0) / N;
      nodes.forEach(n => {
        disp[n.id].x += (gx - pos[n.id].x) * GRAVITY;
        disp[n.id].y += (gy - pos[n.id].y) * GRAVITY;
      });

      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = pos[a.id].x - pos[b.id].x;
          const dy = pos[a.id].y - pos[b.id].y;
          const d2 = Math.max(dx * dx + dy * dy, 1);
          const d  = Math.sqrt(d2);
          const nx = dx / d, ny = dy / d;

          // 1. Repulsion (all pairs)
          const repF = REPEL / d2;
          disp[a.id].x += nx * repF; disp[a.id].y += ny * repF;
          disp[b.id].x -= nx * repF; disp[b.id].y -= ny * repF;

          // 2. Overlap prevention: strong push when bounding boxes overlap
          const minSep = (nodeW(a) + nodeW(b)) / 2 + 40;
          if (d < minSep) {
            const push = (minSep - d) * OVERLAP_K;
            disp[a.id].x += nx * push; disp[a.id].y += ny * push;
            disp[b.id].x -= nx * push; disp[b.id].y -= ny * push;
          }

          // 3. Edge attraction (connected nodes spring to ~260px)
          const key = a.id + "|" + b.id;
          const rkey = b.id + "|" + a.id;
          if (edgePairs.has(key) || edgePairs.has(rkey)) {
            const stretch = d - 260;
            const eF = stretch * EDGE_K;
            disp[a.id].x -= nx * eF; disp[a.id].y -= ny * eF;
            disp[b.id].x += nx * eF; disp[b.id].y += ny * eF;
          }

          // 4. Similarity attraction (similar content → cluster closer)
          const sim = simMatrix[key] || simMatrix[rkey] || 0;
          if (sim > 0.08) {
            const sF = sim * SIM_K * d;
            disp[a.id].x -= nx * sF; disp[a.id].y -= ny * sF;
            disp[b.id].x += nx * sF; disp[b.id].y += ny * sF;
          }
        }
      }

      // Apply displacements, capped at MAXSTEP
      nodes.forEach(n => {
        const d = Math.hypot(disp[n.id].x, disp[n.id].y);
        const sc = d > MAXSTEP ? MAXSTEP / d : 1;
        pos[n.id].x = Math.max(80, pos[n.id].x + disp[n.id].x * sc);
        pos[n.id].y = Math.max(80, pos[n.id].y + disp[n.id].y * sc);
      });
    }

    mut(nm => {
      nodes.forEach(n => {
        nm[n.id] = Object.assign({}, nm[n.id], {
          x: Math.round(pos[n.id].x - nodeW(nm[n.id]) / 2),
          y: Math.round(pos[n.id].y - nodeH(nm[n.id]) / 2),
        });
      });
    });

    // Fit viewport to show all nodes
    const xs = nodes.map(n => pos[n.id].x), ys = nodes.map(n => pos[n.id].y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const cs = cSizeRef.current;
    const fitZ = Math.max(0.25, Math.min(cs.w / (maxX - minX + 500), cs.h / (maxY - minY + 400), 1.1));
    setZoom(fitZ);
    setPan({ x: cs.w / 2 - cx * fitZ, y: cs.h / 2 - cy * fitZ });
    addToast("Arranged " + N + " nodes by similarity", () => { setGraph(saved); setSel([]); });
  }, [pushUndo, mut, addToast]);

  const doAIMerge = async (nodeA, nodeB, origAX, origAY) => {
    const saved = pushUndo();
    const ckDoAI = canvasKeyRef.current;
    if (origAX !== undefined && saved[ckDoAI]?.nodeMap?.[nodeA.id]) { saved[ckDoAI].nodeMap[nodeA.id].x = origAX; saved[ckDoAI].nodeMap[nodeA.id].y = origAY; }
    try {
      const mergePrompt = "Merge these two knowledge nodes into one combined node. Keep all key facts from both.\n\nNode A title: " + nodeA.title + "\nNode A body:\n" + nodeA.body + "\n\nNode B title: " + nodeB.title + "\nNode B body:\n" + nodeB.body + "\n\nRespond with ONLY this JSON (no markdown fences, no explanation):\n{\"title\": \"combined title\", \"body\": \"merged body in markdown bullet points\"}";
      const d = await api([{ role: "user", content: mergePrompt }], null, 800);
      const raw = getText(d);
      let p = parseJ(raw);
      // Fallback: if parseJ missed it, try to extract title+body manually
      if (!p?.title || !p?.body) {
        const tm = raw.match(/"title"\s*:\s*"([^"]+)"/);
        const bm = raw.match(/"body"\s*:\s*"([\s\S]+?)"\s*\}/);
        if (tm && bm) p = { title: tm[1], body: bm[1].replace(/\\n/g, "\n") };
      }
      if (!p?.title || !p?.body) { addToast("Merge failed — try again"); return; }
      mut(nm => {
        const curNode = graphRef.current[canvasKeyRef.current]?.nodeMap?.[nodeA.id] || nm[nodeA.id];
        nm[nodeA.id] = Object.assign({}, curNode, { title: p.title, body: p.body, summary: null, x: origAX !== undefined ? origAX : curNode.x, y: origAY !== undefined ? origAY : curNode.y });
        delete nm[nodeB.id];
      });
      setGraph(prev => { const g = Object.assign({}, prev); const ck2 = canvasKeyRef.current; g[ck2] = Object.assign({}, g[ck2], { edges: g[ck2].edges.filter(e => e.from !== nodeB.id && e.to !== nodeB.id) }); return g; });
      setSel([nodeA.id]);
      addToast("Merged \"" + nodeA.title + "\" + \"" + nodeB.title + "\"", () => { setGraph(saved); setSel([]); });
    } catch (e) { addToast("Merge failed — " + (e.message || "try again")); }
  };

  // findEmptySpot is imported from lib/graphHelpers — pure function, no hook wrapper needed

  // runGapScan, handleFuse, applyFusion moved to useAIFeatures hook

  // BUG-3 FIX: handleImport now pushes undo with real restore function
  const handleImport = useCallback(parsedNodes => {
    const saved = pushUndo();
    const idMap = {}; parsedNodes.forEach(n => { idMap[n.tempId] = uid(); });
    const newNodes = {};
    let rootX = 60, rootY = 60;
    const roots = parsedNodes.filter(n => !n.parentTempId);
    roots.forEach((root, ri) => {
      const cx = rootX + ri * (NW + 60);
      newNodes[idMap[root.tempId]] = { id: idMap[root.tempId], x: cx, y: rootY, h: 120, w: null, title: root.title, body: "# " + root.title + "\n" + (root.body || ""), summary: null, confidence: null, conflict: null, tag: "core", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" };
      const children = parsedNodes.filter(n => n.parentTempId === root.tempId);
      children.forEach((child, ci) => {
        newNodes[idMap[child.tempId]] = { id: idMap[child.tempId], x: cx, y: rootY + 180 + ci * 170, h: 120, w: null, title: child.title, body: "## " + child.title + "\n" + (child.body || ""), summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: idMap[root.tempId], collapsed: false, entryContext: null, nodeType: "text" };
        const grandchildren = parsedNodes.filter(n => n.parentTempId === child.tempId);
        grandchildren.forEach((gc, gi) => {
          newNodes[idMap[gc.tempId]] = { id: idMap[gc.tempId], x: cx + NW + 40, y: rootY + 180 + ci * 170 + gi * 140, h: 100, w: null, title: gc.title, body: "### " + gc.title + "\n" + (gc.body || ""), summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: idMap[child.tempId], collapsed: false, entryContext: null, nodeType: "text" };
        });
      });
    });
    const newEdges = parsedNodes.filter(n => n.parentTempId).map(n => ({ id: uid(), from: idMap[n.parentTempId], to: idMap[n.tempId], label: "contains", dash: false }));
    setGraph(prev => { const g = Object.assign({}, prev); const ck = canvasKeyRef.current; const nm = Object.assign({}, g[ck].nodeMap, ...[newNodes]); g[ck] = Object.assign({}, g[ck], { nodeMap: nm, edges: [...g[ck].edges, ...newEdges] }); return g; });
    setImportModal(false);
    const rootIds = roots.map(n => idMap[n.tempId]); if (rootIds.length > 0) setSel([rootIds[0]]);
    addToast("Imported " + parsedNodes.length + " nodes", () => { setGraph(saved); setSel([]); });
  }, [pushUndo]);

  // NEW FEATURE: Note Migration handler
  const handleNoteMigration = useCallback(result => {
    const saved = pushUndo();
    const idMap = {};
    result.nodes.forEach(n => { idMap[n.tempId] = uid(); });
    const newNodes = {};
    result.nodes.forEach((n, i) => {
      const pos = findEmptySpot(Object.assign({}, (graphRef.current[canvasKeyRef.current] || {nodeMap:{}}).nodeMap, newNodes));
      const nid = idMap[n.tempId];
      newNodes[nid] = { id: nid, x: pos.x, y: pos.y, h: n.nodeType === "diagram" ? 180 : 120, w: n.nodeType === "diagram" ? 340 : null, title: n.title, body: n.body, summary: null, confidence: n.confidence || null, conflict: null, tag: i === 0 ? "core" : "new-domain", relatedTo: null, parentId: n.parentTempId ? idMap[n.parentTempId] : null, collapsed: false, entryContext: null, nodeType: n.nodeType || "text" };
    });
    const newEdges = (result.edges || []).map(e => ({ id: uid(), from: idMap[e.from], to: idMap[e.to], label: e.label || "", dash: e.dash || false }));
    setGraph(prev => { const g = Object.assign({}, prev); const ck = canvasKeyRef.current; const nm = Object.assign({}, g[ck].nodeMap, newNodes); g[ck] = Object.assign({}, g[ck], { nodeMap: nm, edges: [...g[ck].edges, ...newEdges] }); return g; });
    setNoteMigrationModal(false);
    const firstId = idMap[result.nodes[0]?.tempId];
    if (firstId) { setSel([firstId]); highlightNodes(Object.values(idMap)); }
    addToast("Migrated " + result.nodes.length + " nodes from notes", () => { setGraph(saved); setSel([]); });
  }, [graph, pushUndo, highlightNodes]);

  const addGhostNode = useCallback(d => {
    const pos = findEmptySpot((graphRef.current[canvasKeyRef.current] || {nodeMap:{}}).nodeMap);
    setGhostNodes(prev => [...prev, { id: uid(), x: pos.x, y: pos.y, title: d.title || "New concept", body: d.body || "# " + (d.title || "New concept") + "\n", reason: d.reason || null }]);
  }, []);

  const confirmGhost = useCallback(gn => {
    mut(nm => { nm[gn.id] = { id: gn.id, x: gn.x, y: gn.y, h: 120, w: null, title: gn.title, body: gn.body, summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" }; });
    setGhostNodes(prev => prev.filter(g => g.id !== gn.id)); setSel([gn.id]);
  }, [mut]);

  // ── Chat: commit discovered concepts as nodes arranged in a circle ────────
  /**
   * Apply an accepted suggestion (Feature 2 + Phase 4 propose-tool flow).
   * Wraps applySuggestion with pushUndo + addToast(undo) so each accept is
   * undoable. Returns the dispatcher result for ChatPanel to surface.
   */
  const handleApplySuggestion = useCallback((suggestion) => {
    pushUndo();
    const result = applySuggestion(suggestion, { mutCanvas });
    if (result.ok) {
      addToast(result.summary + " — tap to undo", () => undo());
    } else {
      addToast("Couldn't apply: " + (result.error || 'unknown error'));
    }
    return result;
  }, [pushUndo, mutCanvas, undo]);

  const addNodesFromChat = useCallback(concepts => {
    if (!concepts?.length) return;
    pushUndo();
    const cx = (cSizeRef.current.w / 2 - panRef.current.x) / zoomRef.current;
    const cy = (cSizeRef.current.h / 2 - panRef.current.y) / zoomRef.current;
    const count = concepts.length;
    const radius = count > 1 ? 240 : 0;
    concepts.forEach((c, i) => {
      const angle = (2 * Math.PI * i) / Math.max(count, 1) - Math.PI / 2;
      const x = Math.round(cx + Math.cos(angle) * radius - 100);
      const y = Math.round(cy + Math.sin(angle) * radius - 40);
      const nid = uid();
      mut(nm => {
        nm[nid] = {
          id: nid, x, y, h: 80, w: null,
          title: c.title,
          body: c.body ? "# " + c.title + "\n" + c.body : "# " + c.title + "\n- ",
          summary: null, confidence: null, conflict: null,
          tag: "new-domain", relatedTo: null, parentId: null,
          collapsed: false, entryContext: null, nodeType: "text",
        };
      });
    });
  }, [mut, pushUndo]);



  const handleGroupSummary = (groupNodes, userText) => {
    const nid = uid(); const titles = groupNodes.map(n => n.title).join(", ");
    mut(nm => { const pos = findEmptySpot(nm); nm[nid] = { id: nid, x: pos.x, y: pos.y, h: 100, w: null, title: "Group: " + titles.slice(0, 40) + (titles.length > 40 ? "..." : ""), body: "# Group Summary\n" + userText, summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" }; });
    setGraph(prev => { const g = Object.assign({}, prev); const ck = canvasKeyRef.current; g[ck] = Object.assign({}, g[ck], { edges: [...g[ck].edges, ...groupNodes.map(n => ({ id: uid(), from: n.id, to: nid, label: "grouped", dash: true }))] }); return g; });
    setSel([nid]);
  };

  // Handles split / rewrite / append results from InputBar
  const onSplitResult = (srcId, result) => {
    const saved = pushUndo();
    const newIds = [];
    mut(nm => {
      if (result.updatedBody) nm[srcId] = Object.assign({}, nm[srcId], { body: result.updatedBody, summary: null });
      (result.newNodes || []).forEach(nn => {
        if (!nn.title) return;
        const nid = uid(); newIds.push(nid);
        const pos = findEmptySpot(nm);
        nm[nid] = { id: nid, x: pos.x, y: pos.y, h: 120, w: null, title: nn.title, body: nn.body || "# " + nn.title, summary: null, confidence: null, conflict: null, tag: "core", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" };
      });
    });
    if (newIds.length > 0) setGraph(prev => { const g = Object.assign({}, prev); const ck = canvasKeyRef.current; g[ck] = Object.assign({}, g[ck], { edges: [...g[ck].edges, ...newIds.map((nid, i) => ({ id: uid(), from: srcId, to: nid, label: (result.newNodes?.[i]?.edgeLabel) || "split", dash: false }))] }); return g; });
    const action = result.action || "split";
    const msg = action === "rewrite" ? "Rewritten" : action === "append" ? "Appended to node" : "Split into " + (newIds.length + 1) + " nodes";
    addToast(msg, () => { setGraph(saved); setSel([]); });
  };

  // BUG-1 FIX: Extract action now creates node + edge in a single setGraph call
  const onSelectionAction = async (action, text, node, draft, onUpdate) => {
    if (action === "extract") {
      const cleaned = draft.replace(text, "").replace(/\n{3,}/g, "\n\n").trim(); onUpdate(cleaned);
      const nid = uid();
      setGraph(prev => {
        const g = Object.assign({}, prev);
        const ck = canvasKeyRef.current;
        const nm = Object.assign({}, g[ck].nodeMap);
        const pos = findEmptySpot(nm);
        nm[nid] = { id: nid, x: pos.x, y: pos.y, h: 120, w: null, title: text.slice(0, 40), body: "# " + text.slice(0, 40) + "\n" + text, summary: null, confidence: null, conflict: null, tag: "core", relatedTo: node.id, parentId: null, collapsed: false, entryContext: null, nodeType: "text" };
        g[ck] = Object.assign({}, g[ck], { nodeMap: nm, edges: [...g[ck].edges, { id: uid(), from: node.id, to: nid, label: "extracted", dash: false }] });
        return g;
      });
    } else if (action === "elaborate") {
      try { const d = await api([{ role: "user", content: "Elaborate with 2-3 concrete sub-points in markdown.\n\nContext: \"" + node.title + "\"\nSelected: \"" + text + "\"\n\nReturn ONLY bullet lines to append." }], null, 250); onUpdate(draft.replace(text, text + "\n" + getText(d).replace(/```[a-z]*|```/g, "").trim())); } catch (e) { }
    } else if (action === "question") {
      openPanel("tutor");
    }
  };

  const resolve = (id, res, txt) => { mut(nm => { nm[id] = Object.assign({}, nm[id], { conflict: Object.assign({}, nm[id].conflict, { status: res, mergedText: txt || null }) }); }); setConflictNode(null); };

  const handleInput = p => {
    if (!p || !Array.isArray(p.items) || p.items.length === 0) return;
    const saved = pushUndo();
    // Map tempIds (e.g. "n1") from the LLM response to real uids so edges can reference them.
    const idMap = {};
    p.items.forEach(it => { if (it.action === "new" && it.tempId) idMap[it.tempId] = uid(); });
    // Precompute node positions BEFORE calling mut(), since mut's updater runs asynchronously
    // during React's commit phase — anything collected inside it is not available in time
    // to pan the canvas afterwards.
    const prepared = []; // { it, nid, pos }
    {
      const nmScratch = Object.assign({}, graphRef.current[canvasKeyRef.current]?.nodeMap || {});
      const newItems = p.items.filter(it => it.action === "new");
      // Cluster new nodes together near the current viewport center instead of
      // scattering them across the canvas via sequential findEmptySpot calls.
      const PAD = 30, colStep = NW + PAD * 2, rowStep = 150;
      const COLS = Math.min(Math.max(newItems.length, 1), 3);
      let clusterOrigin = null;
      if (newItems.length > 0) {
        const cs = cSizeRef.current, z = zoomRef.current, pn = panRef.current;
        const vcx = (-pn.x + cs.w / 2) / z;
        const vcy = (-pn.y + cs.h / 2) / z;
        const existingNodes = Object.values(nmScratch);
        const overlaps = (x, y) => existingNodes.some(n =>
          x < n.x + nodeW(n) + PAD && x + NW > n.x - PAD &&
          y < n.y + (n.h || 120) + PAD && y + 120 > n.y - PAD
        );
        outer: for (let r = 0; r <= 30; r++) {
          const steps = r === 0 ? 1 : r * 8;
          for (let qi = 0; qi < steps; qi++) {
            const angle = (qi / steps) * Math.PI * 2;
            const ox = Math.max(60, Math.round(vcx + Math.cos(angle) * r * colStep - COLS * colStep / 2));
            const oy = Math.max(60, Math.round(vcy + Math.sin(angle) * r * rowStep - rowStep / 2));
            let fits = true;
            for (let i = 0; i < newItems.length; i++) {
              if (overlaps(ox + (i % COLS) * colStep, oy + Math.floor(i / COLS) * rowStep)) { fits = false; break; }
            }
            if (fits) { clusterOrigin = { x: ox, y: oy }; break outer; }
          }
        }
      }
      let clusterIdx = 0;
      p.items.forEach(it => {
        if (it.action !== "new") return;
        const nid = idMap[it.tempId] || uid();
        let pos;
        if (clusterOrigin) {
          const col = clusterIdx % COLS, row = Math.floor(clusterIdx / COLS);
          pos = { x: clusterOrigin.x + col * colStep, y: clusterOrigin.y + row * rowStep };
        } else {
          pos = findEmptySpot(nmScratch);
        }
        clusterIdx++;
        nmScratch[nid] = { id: nid, x: pos.x, y: pos.y, h: 120, w: null };
        prepared.push({ it, nid, pos });
      });
    }
    const newIds = prepared.map(pr => pr.nid);
    const newPositions = prepared.map(pr => ({ x: pr.pos.x, y: pr.pos.y, w: NW, h: 120 }));
    mut(nm => {
      prepared.forEach(({ it, nid, pos }) => {
        const title = it.title || "New concept";
        const body = it.body ? ("# " + title + "\n" + it.body) : ("# " + title + "\n" + (p.inputText || ""));
        nm[nid] = { id: nid, x: pos.x, y: pos.y, h: 120, w: null, title, body, summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" };
      });
      p.items.forEach(it => {
        if (it.action === "update" && it.targetId && nm[it.targetId]) {
          const add = it.body || p.inputText || "";
          nm[it.targetId] = Object.assign({}, nm[it.targetId], { body: nm[it.targetId].body + "\n- " + add, summary: null });
        } else if (it.action === "conflict" && it.targetId && nm[it.targetId]) {
          nm[it.targetId] = Object.assign({}, nm[it.targetId], { conflict: { inp: it.body || p.inputText || "", label: it.conflictLabel || "New perspective", status: "unresolved" } });
        }
      });
    });
    // Apply proposed edges (either between new tempIds or to existing node ids).
    const resolveId = ref => idMap[ref] || ref;
    const newEdges = (p.edges || [])
      .map(e => ({ from: resolveId(e.from), to: resolveId(e.to), label: e.label || "" }))
      .filter(e => e.from && e.to && e.from !== e.to);
    if (newEdges.length > 0) {
      setGraph(prev => {
        const g = Object.assign({}, prev);
        const ck = canvasKeyRef.current;
        const nm = g[ck].nodeMap;
        const existingEdges = g[ck].edges;
        const added = newEdges
          .filter(e => nm[e.from] && nm[e.to])
          .filter(e => !existingEdges.some(x => (x.from === e.from && x.to === e.to) || (x.from === e.to && x.to === e.from)))
          .map(e => ({ id: uid(), from: e.from, to: e.to, label: e.label, dash: true, pending: true }));
        if (added.length === 0) return g;
        g[ck] = Object.assign({}, g[ck], { edges: [...existingEdges, ...added] });
        return g;
      });
    }
    if (newIds.length > 0) {
      setSel(newIds);
      if (newIds.length === 1) setContextCapture({ nodeId: newIds[0] });
      highlightNodes(newIds);
      // Pan the canvas so the newly-created nodes are visible. Without this, findEmptySpot
      // can place new nodes outside the current viewport (e.g. in a column beyond the visible
      // width) and the user thinks Apply did nothing. Use positions captured inside the
      // mutator rather than reading back from graphRef (which may not have updated yet).
      if (newPositions.length > 0) {
        const minX = Math.min(...newPositions.map(n => n.x));
        const maxX = Math.max(...newPositions.map(n => n.x + n.w));
        const minY = Math.min(...newPositions.map(n => n.y));
        const maxY = Math.max(...newPositions.map(n => n.y + n.h));
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const z = zoomRef.current, cs = cSizeRef.current;
        setPan({ x: cs.w / 2 - cx * z, y: cs.h / 2 - cy * z });
      }
    }
    const count = p.items.length;
    addToast("Added " + count + " item" + (count === 1 ? "" : "s") + " from note", () => { setGraph(saved); setSel([]); });
  };

  const navigateTo = useCallback(relId => {
    const n = cur.nodeMap[relId]; if (!n) return;
    const z = zoomRef.current, cs = cSizeRef.current;
    setPan({ x: cs.w / 2 - (n.x + nodeW(n) / 2) * z, y: cs.h / 2 - (n.y + nodeH(n) / 2) * z }); setSel([relId]);
  }, [cur]);
  const navigateAndHL = useCallback(id => { navigateTo(id); highlightNodes([id]); }, [navigateTo, highlightNodes]);

  // NEW FEATURE: Toggle bookmark on a node
  const toggleBookmark = useCallback(id => {
    setBookmarks(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, []);

  // runAutoLink, acceptAutoLink moved to useAIFeatures hook

  const gapScanStateRef = useRef(gapScanState); gapScanStateRef.current = gapScanState;
  const openPanel = useCallback(tab => {
    setRightPanel(tab);
    if (tab === "gaps" && gapScanStateRef.current === "idle" && !gapRef.current[topicRef.current]) setTimeout(runGapScan, 400);
  }, [runGapScan]);

  // NEW FEATURE: Change node type (text/diagram/table)
  const changeNodeType = useCallback((id, nodeType) => {
    pushUndo();
    mut(nm => { nm[id] = Object.assign({}, nm[id], { nodeType }); });
  }, [mut, pushUndo]);

  // drillParentNode + updateDrillParentBody now provided by useDrillState (above)

  const drillInto = useCallback((nodeId, nodeTitle) => {
    setSel([]); setHov(null); setPendingMerge(null); setNodeChatId(null);
    setDrillPath(prev => [...prev, { id: nodeId, title: nodeTitle }]);
    resetViewport();
    trackNodeView(nodeId); // memory metadata: this counts as opening the node
  }, [setDrillPath, resetViewport]);

  const drillBack = useCallback((idx) => {
    setSel([]); setHov(null); setPendingMerge(null); setNodeChatId(null);
    setDrillPath(prev => prev.slice(0, idx));
    resetViewport();
  }, [setDrillPath, resetViewport]);

  const cc          = useMemo(() => Object.values(cur.nodeMap).filter(n => n.conflict && n.conflict.status === "unresolved").length, [cur.nodeMap]);
  // selNodes provided by useNodeSelection (above)
  const gapCount    = useMemo(() => (gapDataMap[topic]?.gaps?.length || 0) + (gapDataMap[topic]?.latentConflicts?.length || 0), [gapDataMap, topic]);
  const lassoScreen = useMemo(() => lasso ? { x: Math.min(lasso.x1, lasso.x2) * zoom + pan.x, y: Math.min(lasso.y1, lasso.y2) * zoom + pan.y, w: Math.abs(lasso.x2 - lasso.x1) * zoom, h: Math.abs(lasso.y2 - lasso.y1) * zoom } : null, [lasso, zoom, pan.x, pan.y]);
  const parentIds   = useMemo(() => new Set(Object.values(cur.nodeMap).filter(n => n.parentId).map(n => n.parentId)), [cur.nodeMap]);
  const visibleNodes = useMemo(() => Object.values(cur.nodeMap).filter(n => { if (!n.parentId) return true; const p = cur.nodeMap[n.parentId]; return !p?.collapsed; }), [cur.nodeMap]);

  // ── Focus mode: compute connected node set ───────────────────────────────
  const focusConnected = useMemo(() => {
    if (!focusNodeId || !cur.nodeMap[focusNodeId]) return null;
    const s = new Set([focusNodeId]);
    cur.edges.forEach(e => { if (e.from === focusNodeId) s.add(e.to); if (e.to === focusNodeId) s.add(e.from); });
    Object.values(cur.nodeMap).forEach(n => { if (n.parentId === focusNodeId) s.add(n.id); });
    const fn = cur.nodeMap[focusNodeId]; if (fn.parentId) s.add(fn.parentId);
    return s;
  }, [focusNodeId, cur.nodeMap, cur.edges]);

  // ── Swimlane: expand children in a horizontal row below their parent ─────
  // When a parent node has swimlaneOpen=true, its children are positioned
  // in a tidy row directly below it. Their actual nodeMap positions are
  // overridden at render time (not stored) so moving the parent doesn't
  // require updating all children too.
  const { swimlaneOverride, swimlaneActive, hasSwimlane } = useMemo(() => {
    const override = {}; // childId → { x, y }
    const active = new Set(); // ids that are part of an open swimlane
    Object.values(cur.nodeMap).forEach(parent => {
      if (!parent.swimlaneOpen) return;
      const children = Object.values(cur.nodeMap).filter(n => n.parentId === parent.id);
      if (children.length === 0) return;
      active.add(parent.id);
      const GAP = 20, ROW_Y = parent.y + nodeH(parent) + 52;
      const totalW = children.reduce((s, c) => s + nodeW(c), 0) + GAP * (children.length - 1);
      let cx = parent.x + nodeW(parent) / 2 - totalW / 2;
      children.forEach(child => {
        override[child.id] = { x: Math.round(cx), y: ROW_Y };
        active.add(child.id);
        cx += nodeW(child) + GAP;
      });
    });
    return { swimlaneOverride: override, swimlaneActive: active, hasSwimlane: active.size > 0 };
  }, [cur.nodeMap]);

  // ── Stable callbacks for TopBar (avoid defeating React.memo) ────────────────
  const handleTopicChange = useCallback(id => {
    const curTopic = topicRef.current;
    setTopicViews(prev => Object.assign({}, prev, { [curTopic]: { pan: panRef.current, zoom: zoomRef.current } }));
    const saved = topicViewsRef.current[id];
    if (saved) { setPan(saved.pan); setZoom(saved.zoom); } else { setPan({ x: 0, y: 0 }); setZoom(1); }
    setTopic(id); setDrillPath([]); setSel([]); setHov(null); setTensionOpen(false); setRightPanel(null); setFusionPreview(null); setContextCapture(null); setAutoLinkSuggestions(null); setFocusNodeId(null);
  }, []);
  const handleCreateTopic = useCallback((key, label) => {
    setGraph(prev => Object.assign({}, prev, { [key]: { label, nodeMap: {}, edges: [] } }));
    setTopic(key); setNewTopicInput(null);
  }, []);
  const openImportModal    = useCallback(() => setImportModal(true), []);
  const openMigrateModal   = useCallback(() => setNoteMigrationModal(true), []);
  const openSearch         = useCallback(() => setSearchOpen(true), []);
  const handleChatToggle   = useCallback(() => setChatOpen(o => !o), []);
  const handleUndo = useCallback(() => {
    undo();
    setSel([]);
  }, [undo]);
  const handleToggleFocus  = useCallback(firstSel => setFocusNodeId(f => f ? null : firstSel), []);
  const handleTensionToggle = useCallback(() => setTensionOpen(o => !o), []);
  const handleResetView    = useCallback(() => { resetViewport(); }, [resetViewport]);
  const handleViewMenuToggle = useCallback(() => setViewMenuOpen(o => !o), []);
  const handleDeleteView   = useCallback(i => setSavedViews(prev => prev.filter((_, j) => j !== i)), []);

  // ── Auth gate ───────────────────────────────────────────────────────────────
  if (authNeeded === null) return null; // still checking
  if (authNeeded) return <AuthGate onAuth={handleAuth} error={authNeeded === "invalid"} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: IS_TOUCH ? "var(--vv-height, 100%)" : "100%", minHeight: IS_TOUCH ? 0 : 640, fontFamily: "'Inter',system-ui,sans-serif", position: "relative", background: "var(--color-background-primary)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400&display=swap');
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
        @keyframes highlightPulse{0%,100%{box-shadow:0 0 0 0 rgba(245,158,11,0)}50%{box-shadow:0 0 0 8px rgba(245,158,11,0.25),0 0 20px rgba(245,158,11,0.12)}}
        @keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      `}</style>

      <TopBar
        topicKeys={topicKeys} topic={topic} graph={graph} accent={accent} zoom={zoom}
        newTopicInput={newTopicInput} chatOpen={chatOpen} chatConcepts={chatConcepts}
        historyCount={history.length} merging={merging} fusePhase={fusePhase}
        focusNodeId={focusNodeId} rightPanel={rightPanel} gapCount={gapCount} gapScanState={gapScanState}
        conflictCount={cc} tensionOpen={tensionOpen} syncStatus={syncStatus}
        viewMenuOpen={viewMenuOpen} savedViews={savedViews} sel={sel}
        onTopicChange={handleTopicChange}
        onNewTopicInput={setNewTopicInput}
        onCreateTopic={handleCreateTopic}
        onImport={openImportModal}
        onMigrate={openMigrateModal}
        onSearch={openSearch}
        onChatToggle={handleChatToggle}
        onUndo={handleUndo}
        onAutoLink={runAutoLink} onAutoArrange={doAutoArrange}
        onToggleFocus={handleToggleFocus}
        onOpenPanel={openPanel}
        onTensionToggle={handleTensionToggle}
        onResetView={handleResetView}
        onViewMenuToggle={handleViewMenuToggle}
        onSaveView={saveView} onRestoreView={restoreView}
        onDeleteView={handleDeleteView}
        onOpenAccount={() => setAccountOpen(true)}
      />

      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", minHeight: 0 }}
          onMouseLeave={() => { if (!isDragging) setSpaceDown(false); }}
        >

      {drillPath.length > 0 && (
        <DrillBreadcrumb drillPath={drillPath} topicLabel={graph[topic]?.label || topic} accent={accent} onDrillBack={drillBack} />
      )}

      {/* Sub-canvas: parent node body — click edit, double-click canvas to add child nodes */}
      {drillPath.length > 0 && drillParentNode && (
        <SubCanvasBody key={canvasKey} node={drillParentNode} accent={accent} onSave={updateDrillParentBody} maxH={subBodyMaxH} />
      )}
      {/* Draggable separator between summary and child-node canvas */}
      {drillPath.length > 0 && (
        <div
          style={{
            height: 24,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.03)",
            borderTop: "1px solid rgba(0,0,0,0.08)",
            borderBottom: "1px solid rgba(0,0,0,0.08)",
            flexShrink: 0,
            cursor: "ns-resize",
            userSelect: "none",
            transition: "background 0.15s",
          }}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.07)"}
          onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
          onMouseDown={e => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = subBodyMaxH;
            const onMove = mv => setSubBodyMaxH(Math.max(80, Math.min(500, startH + mv.clientY - startY)));
            const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2.5, pointerEvents: "none" }}>
            <div style={{ width: 32, height: 2, borderRadius: 2, background: "rgba(0,0,0,0.28)" }} />
            <div style={{ width: 32, height: 2, borderRadius: 2, background: "rgba(0,0,0,0.28)" }} />
            <div style={{ width: 32, height: 2, borderRadius: 2, background: "rgba(0,0,0,0.28)" }} />
          </div>
        </div>
      )}

        <div ref={cvRef} style={{
          flex: 1, minWidth: 0, position: "relative", overflow: "hidden",
          background: drillPath.length > 0 ? "var(--color-background-tertiary)" : "var(--color-background-tertiary)",
          cursor: spaceDown
            ? (isDragging ? "grabbing" : "grab")
            : drawing ? "crosshair"
            : lasso?.isNodeCreate ? "crosshair"
            : lasso ? "crosshair"
            : resizingRef.current ? "move"
            : isDragging ? "grabbing"
            : "default",
          touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none",
        }}
          onMouseDown={onCanvasDown}
          onClick={e => {
            if (e.target !== cvRef.current) return;
            if (lassoJustFinished.current) return;
            setSel([]); setHov(null); setContextCapture(null); setNewTopicInput(null); setTemplateMenu(null);
          }}
          onDoubleClick={onCanvasDbl}
          onDragOver={onCanvasDragOver} onDragLeave={onCanvasDragLeave} onDrop={onCanvasDrop}
          onContextMenu={e => {
            e.preventDefault();
            // Only show template menu when right-clicking on the empty canvas background,
            // not on nodes (KNode's onContextMenu calls stopPropagation for those).
            if (e.target !== cvRef.current && e.target.closest && e.target.closest('[data-nodeid]')) return;
            const rect = cvRef.current.getBoundingClientRect();
            const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
            setTemplateMenu({ x, y, screenX: e.clientX - rect.left, screenY: e.clientY - rect.top });
          }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, transformOrigin: "0 0", transform: "translate(" + pan.x + "px," + pan.y + "px) scale(" + zoom + ")" }}>
            {visibleNodes.filter(n => !n.parentId).map(parent => {
              const children = visibleNodes.filter(n => n.parentId === parent.id);
              if (children.length === 0) return null;
              // Use override positions when swimlane is open
              const getPos = n => swimlaneOverride[n.id] ? swimlaneOverride[n.id] : { x: n.x, y: n.y };
              const allGroupNodes = [parent, ...children];
              const minX = Math.min(...allGroupNodes.map(n => getPos(n).x)) - 28;
              const minY = Math.min(...allGroupNodes.map(n => getPos(n).y)) - 28;
              const maxX = Math.max(...allGroupNodes.map(n => getPos(n).x + nodeW(n))) + 28;
              const maxY = Math.max(...allGroupNodes.map(n => getPos(n).y + nodeH(n) + 20)) + 28;
              return <div key={"grp-" + parent.id}
                onMouseDown={e => {
                  if (e.target !== e.currentTarget) return; // let clicks pass through to nodes inside
                  e.preventDefault(); e.stopPropagation();
                  const origPositions = {};
                  allGroupNodes.forEach(n => { origPositions[n.id] = { x: n.x, y: n.y }; });
                  drag.current = { type: "group", startX: e.clientX, startY: e.clientY, origPositions };
                  setIsDragging(true);
                }}
                style={{ position: "absolute", left: minX, top: minY, width: maxX - minX, height: maxY - minY, border: "1.5px dashed " + accent + (parent.swimlaneOpen ? "55" : "33"), borderRadius: 18, background: accent + (parent.swimlaneOpen ? "07" : "04"), pointerEvents: "auto", cursor: "grab", zIndex: 0 }} />;
            })}
            <Edges nodes={cur.nodeMap} edges={cur.edges} accent={accent} sel={sel} hov={hov}
              drawing={drawing ? { x1: (drawing.x1 - pan.x) / zoom, y1: (drawing.y1 - pan.y) / zoom, x2: (drawing.x2 - pan.x) / zoom, y2: (drawing.y2 - pan.y) / zoom, snap: drawing.snap } : null}
              W={cSize.w / zoom} H={cSize.h / zoom} />
            {cur.edges.map(e => <EdgeLabel key={e.id} e={e} nodes={cur.nodeMap} accent={accent} sel={sel} hov={hov}
              onSave={(eid, lbl) => setGraph(prev => { const g = Object.assign({}, prev); g[canvasKey] = Object.assign({}, g[canvasKey], { edges: g[canvasKey].edges.map(ed => ed.id === eid ? Object.assign({}, ed, { label: lbl }) : ed) }); return g; })}
              onDelete={eid => setGraph(prev => { const g = Object.assign({}, prev); g[canvasKey] = Object.assign({}, g[canvasKey], { edges: g[canvasKey].edges.filter(ed => ed.id !== eid) }); return g; })}
              onConfirm={eid => setGraph(prev => { const g = Object.assign({}, prev); g[canvasKey] = Object.assign({}, g[canvasKey], { edges: g[canvasKey].edges.map(ed => ed.id === eid ? Object.assign({}, ed, { pending: false, dash: false }) : ed) }); return g; })} />)}
            {visibleNodes.map(node => <KNode key={node.id} node={node} accent={accent}
              sel={sel.includes(node.id)} hov={hov === node.id} mergeTarget={mergeTarget === node.id}
              compact={compact} highlighted={highlighted.includes(node.id)}
              dimmed={focusConnected ? !focusConnected.has(node.id) : hasSwimlane ? !swimlaneActive.has(node.id) : false}
              dragging={isDragging && sel.includes(node.id)}
              isParent={parentIds.has(node.id)}
              bookmarked={bookmarks.includes(node.id)}
              overridePos={swimlaneOverride[node.id]}
              swimlaneOpen={!!node.swimlaneOpen}
              swimlaneChildCount={Object.values(cur.nodeMap).filter(n => n.parentId === node.id).length}
              onToggleSwimlane={id => mut(nm => { nm[id] = Object.assign({}, nm[id], { swimlaneOpen: !nm[id].swimlaneOpen }); })}
              onDown={onNodeDown} onEnter={() => setHov(node.id)} onLeave={() => setHov(null)}
              onClick={() => setSel(prev => prev.includes(node.id) ? prev : [node.id])}
              onDbl={(id, body) => mut(nm => { nm[id] = Object.assign({}, nm[id], { body, summary: null }); })}
              onConflict={setConflictNode} onAnchorDown={onAnchorDown}
              onSelectionAction={onSelectionAction} onNavigateToRelated={navigateTo}
              onConfidenceChange={(id, conf) => mut(nm => { nm[id] = Object.assign({}, nm[id], { confidence: conf }); })}
              onResizeStart={onResizeStart} onToggleCollapse={toggleCollapse}
              onBookmark={toggleBookmark} onChangeNodeType={changeNodeType}
              onColorChange={(id, color, category) => mut(nm => { nm[id] = Object.assign({}, nm[id], { color: color ?? nm[id].color, category: category !== undefined ? category : nm[id].category }); })}
              onTagChange={(id, tag) => mut(nm => { nm[id] = Object.assign({}, nm[id], { tag }); })}
              editRequested={touchEditId === node.id}
              onNodeContextMenu={(e, id) => { e.preventDefault(); e.stopPropagation(); setNodeChatId(id); setTemplateMenu(null); }}
              onDrillIn={drillInto} />)}
            {ghostNodes.map(gn => <GhostNode key={gn.id} gn={gn} accent={accent} onConfirm={confirmGhost} onDismiss={id => setGhostNodes(prev => prev.filter(g => g.id !== id))} />)}
            {contextCapture && cur.nodeMap[contextCapture.nodeId] && <NodeContextCapture node={cur.nodeMap[contextCapture.nodeId]} accent={accent}
              onSave={fields => { mut(nm => { nm[contextCapture.nodeId] = Object.assign({}, nm[contextCapture.nodeId], { entryContext: fields }); }); setContextCapture(null); }}
              onDismiss={() => setContextCapture(null)} />}
            {/* NodeChat — rendered inside canvas transform so it moves with the node */}
            {nodeChatId && cur.nodeMap[nodeChatId] && (
              <NodeChatPanel
                node={cur.nodeMap[nodeChatId]}
                allNodes={cur.nodeMap} edges={cur.edges} accent={accent} zoom={zoom}
                onResult={p => { handleInput(p); setNodeChatId(null); }}
                onClose={() => setNodeChatId(null)}
              />
            )}
            {/* Pending merge confirm pill */}
            {pendingMerge && cur.nodeMap[pendingMerge.tgt.id] && (() => {
              const tgt = cur.nodeMap[pendingMerge.tgt.id];
              const cx = tgt.x + nodeW(tgt) / 2;
              const cy = tgt.y - 44;
              const invScale = 1 / (zoom || 1);
              return (
                <div onMouseDown={e => e.stopPropagation()} style={{ position: "absolute", left: cx, top: cy, transform: "translateX(-50%) scale(" + invScale + ")", transformOrigin: "top center", zIndex: 200, display: "flex", gap: 4, background: "var(--color-background-primary)", border: "0.5px solid " + accent + "55", borderRadius: 100, padding: "5px 8px", boxShadow: "0 4px 20px rgba(0,0,0,0.18)", fontFamily: "'Inter',system-ui,sans-serif", animation: "fadeIn 0.15s ease", whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", padding: "0 4px", alignSelf: "center" }}>Merge into "{tgt.title.slice(0,18)}{tgt.title.length > 18 ? "…" : ""}"?</span>
                  <button onClick={() => {
                    const {src, tgt: t, origX, origY} = pendingMerge;
                    const currentSrc = graphRef.current[canvasKeyRef.current]?.nodeMap?.[src.id] || src;
                    const currentTgt = graphRef.current[canvasKeyRef.current]?.nodeMap?.[t.id] || t;
                    setPendingMerge(null);
                    setMerging(true);
                    doAIMerge(currentSrc, currentTgt, origX, origY).finally(() => setMerging(false));
                  }} style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 100, border: "none", background: accent, color: "#fff", cursor: "pointer" }}>Merge ✓</button>
                  <button onClick={() => { const {src,origX,origY} = pendingMerge; mut(nm => { nm[src.id] = Object.assign({},nm[src.id],{x:origX,y:origY}); }); setPendingMerge(null); }} style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 100, border: "none", background: "var(--color-background-secondary)", color: "var(--color-text-secondary)", cursor: "pointer" }}>Cancel</button>
                </div>
              );
            })()}
            {/* ── Inline notes: free-positioned thin-bordered text blocks ── */}
            {(cur.inlineNotes || []).map(note => (
              <InlineNote key={note.id} note={note} accent={accent} zoom={zoom}
                onUpdate={updateInlineNote} onDelete={deleteInlineNote} onMove={moveInlineNote} />
            ))}
            {/* ── Floating quick-text input (Space+click on any canvas) ── */}
            {/* Creates a real KNode when committed, not an InlineNote */}
            {quickTextPos && (
              <div
                onMouseDown={e => e.stopPropagation()}
                style={{ position: "absolute", left: quickTextPos.x, top: quickTextPos.y, zIndex: 300 }}>
                <textarea
                  autoFocus
                  rows={1}
                  placeholder="Jot a thought… (Enter to save, Esc to cancel)"
                  onBlur={e => {
                    const text = e.target.value.trim();
                    if (text) {
                      const nid = uid();
                      mut(nm => { nm[nid] = { id: nid, x: quickTextPos.x, y: quickTextPos.y, h: 80, w: null, title: text.length > 50 ? text.slice(0, 50) + "…" : text, body: "# " + (text.length > 50 ? text.slice(0, 50) : text) + "\n" + text, summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" }; });
                      setSel([nid]);
                    }
                    setQuickTextPos(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      const text = e.target.value.trim();
                      if (text) {
                        const nid = uid();
                        mut(nm => { nm[nid] = { id: nid, x: quickTextPos.x, y: quickTextPos.y, h: 80, w: null, title: text.length > 50 ? text.slice(0, 50) + "…" : text, body: "# " + (text.length > 50 ? text.slice(0, 50) : text) + "\n" + text, summary: null, confidence: null, conflict: null, tag: "new-domain", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" }; });
                        setSel([nid]);
                      }
                      setQuickTextPos(null);
                    }
                    if (e.key === "Escape") { e.preventDefault(); setQuickTextPos(null); }
                  }}
                  onChange={e => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                  style={{ width: 260, minHeight: 34, maxHeight: 160, padding: "6px 10px", fontFamily: "'Inter',system-ui,sans-serif", fontSize: 13, lineHeight: 1.6, border: "1.5px solid " + accent + "88", borderRadius: 8, background: "var(--color-background-primary)", color: "var(--color-text-primary)", boxShadow: "0 4px 16px rgba(0,0,0,0.16)", resize: "none", outline: "none", display: "block", boxSizing: "border-box", overflow: "hidden" }}
                />
              </div>
            )}
          </div>
          {/* Lasso / nodeCreate rect overlay — rendered OUTSIDE overflow:hidden so it
               can extend to the full canvas container without clipping */}
          {lassoScreen && (
            <svg style={{
              position: "absolute", inset: 0,
              pointerEvents: "none", zIndex: 50,
              width: "100%", height: "100%",
              overflow: "visible",
            }}>
              {lasso?.isNodeCreate
                ? <rect x={lassoScreen.x} y={lassoScreen.y} width={lassoScreen.w} height={lassoScreen.h} fill={accent + "10"} stroke={accent} strokeWidth={2} rx={8} />
                : <rect x={lassoScreen.x} y={lassoScreen.y} width={lassoScreen.w} height={lassoScreen.h} fill={accent + "18"} stroke={accent} strokeWidth={1.5} strokeDasharray="5,3" rx={4} />
              }
            </svg>
          )}
          {/* ── Sub-canvas empty state ─────────────────────────────────── */}
          {drillPath.length > 0 && Object.keys(cur.nodeMap).length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, pointerEvents: "none", fontFamily: "'Inter',system-ui,sans-serif" }}>
              <div style={{ fontSize: 28, opacity: 0.15 }}>⊞</div>
              <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", opacity: 0.4, textAlign: "center", lineHeight: 1.9 }}>
                <span style={{ opacity: 0.8 }}>Double-click</span> empty space to create a node<br />
                <span style={{ opacity: 0.8 }}>Drag</span> empty space to box-select<br />
                <span style={{ opacity: 0.8 }}>Space + drag</span> to pan · <span style={{ opacity: 0.8 }}>⌘ + drag</span> to draw node size
              </div>
            </div>
          )}
          {/* ── Multi-select action bar ─────────────────────────────────── */}
          {selNodes.length >= 2 && !merging && (
            <MultiSelectBar selNodes={selNodes} accent={accent}
              onMerge={() => { const [a, b] = selNodes; setMerging(true); doAIMerge(a, b).finally(() => setMerging(false)); }}
              onMakeChild={() => { const [parent, child] = selNodes; pushUndo(); mut(nm => { nm[child.id] = Object.assign({}, nm[child.id], { parentId: parent.id }); }); setSel([]); addToast('"' + child.title + '" → child of "' + parent.title + '"', () => { mut(nm => { nm[child.id] = Object.assign({}, nm[child.id], { parentId: null }); }); }); }}
              onDelete={() => { pushUndo(); sel.forEach(id => mut(nm => { delete nm[id]; })); setSel([]); }}
              onClear={() => setSel([])}
            />
          )}
          {compact && <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: "var(--color-text-tertiary)", background: "var(--color-background-secondary)", padding: "3px 10px", borderRadius: 100, border: "0.5px solid var(--color-border-tertiary)", pointerEvents: "none", whiteSpace: "nowrap" }}>Semantic view — zoom in to read</div>}
          {digestCard && <DigestCard data={digestCard} onDismiss={() => setDigestCard(null)} />}
          <Minimap nodes={cur.nodeMap} edges={cur.edges} pan={pan} zoom={zoom} canvasSize={cSize} accent={accent} onPan={setPan} nodeW={nodeW} nodeH={nodeH} />
          <TouchFAB accent={accent}
            onCreateNode={() => {
              const cs = cSizeRef.current;
              const { x, y } = toCanvas(cs.w / 2, cs.h / 2);
              const nid = uid();
              const nx = Math.max(20, x - NW / 2);
              const ny = Math.max(20, y - 60);
              mut(nm => { nm[nid] = { id: nid, x: nx, y: ny, h: 80, w: null, title: "New node", body: "- ", summary: null, confidence: null, conflict: null, tag: "core", relatedTo: null, parentId: null, collapsed: false, entryContext: null, nodeType: "text" }; });
              setSel([nid]); setContextCapture({ nodeId: nid });
            }}
            onUndo={() => { undo(); setSel([]); }}
            undoCount={history.length}
            onSearch={() => setSearchOpen(true)}
          />
          {focusNodeId && <button onClick={() => setFocusNodeId(null)} style={{ position: "absolute", bottom: 16, right: 190, zIndex: 42, fontFamily: "'Inter',system-ui,sans-serif", fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 6, border: "0.5px solid " + accent + "55", background: accent + "14", color: accent, cursor: "pointer", whiteSpace: "nowrap" }}>Exit Focus</button>}
          {/* Drop hint overlay */}
          {dropHint && <div style={{ position: "absolute", inset: 0, background: accent + "0a", border: "3px dashed " + accent + "44", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, pointerEvents: "none" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: accent, background: "var(--color-background-primary)", padding: "8px 20px", borderRadius: 8, boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}>Drop to create node</div>
          </div>}
          {/* Node right-click chat panel */}
          {/* Template context menu */}
          {templateMenu && <div style={{ position: "absolute", left: templateMenu.screenX, top: templateMenu.screenY, zIndex: 70, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: 6, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", minWidth: 150, fontFamily: "'Inter',system-ui,sans-serif" }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: "var(--color-text-tertiary)", padding: "4px 8px", letterSpacing: "0.06em", textTransform: "uppercase" }}>New from template</div>
            {NODE_TEMPLATES.map((t, i) => <div key={i} onClick={() => applyTemplate(t, templateMenu.x, templateMenu.y)}
              style={{ fontSize: 11, padding: "6px 8px", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "var(--color-text-primary)", transition: "background 0.1s" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontSize: 12, width: 18, textAlign: "center" }}>{t.icon}</span> {t.label}
            </div>)}
          </div>}
        </div>
        </div>
        {rightPanel && (
          <div style={{ width: 320, flexShrink: 0, borderLeft: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", display: "flex", flexDirection: "column", animation: "slideIn 0.2s ease", overflow: "hidden" }}>
            <StudioPanel
              topicLabel={cur.label} nodes={cur.nodeMap} edges={cur.edges} accent={accent}
              initialMode={rightPanel}
              onHighlight={highlightNodes} onHighlightSequence={highlightSequence}
              onGhostNode={addGhostNode} onGenerate={handleNoteMigration}
              onNavigate={navigateAndHL}
              gapData={gapDataMap[topic]} gapScanState={gapScanState} onGapScan={runGapScan}
              bookmarks={bookmarks}
              onClose={() => setRightPanel(null)}
            />
          </div>
        )}
        {chatOpen && (
          <>
            <div
              style={{ width: 8, flexShrink: 0, cursor: "ew-resize", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.03)", borderLeft: "1px solid rgba(0,0,0,0.08)", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.07)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.03)"}
              onMouseDown={e => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = chatWidth;
                const onMove = mv => setChatWidth(Math.max(240, Math.min(600, startW - (mv.clientX - startX))));
                const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 3, pointerEvents: "none" }}>
                <div style={{ width: 2, height: 28, borderRadius: 2, background: "rgba(0,0,0,0.28)" }} />
              </div>
            </div>
            <ChatPanel
              key={canvasKey}
              topic={cur.label}
              canvasKey={canvasKey}
              nodes={cur.nodeMap}
              contextPack={contextPack}
              accent={accent}
              messages={chatMessages}
              concepts={chatConcepts}
              onMessagesChange={setChatMessages}
              onConceptsChange={setChatConcepts}
              onAddNodes={addNodesFromChat}
              onApplySuggestion={handleApplySuggestion}
              width={chatWidth}
            />
          </>
        )}
      </div>




      {toasts.map(t => <Toast key={t.id} message={t.message} onUndo={() => { t.undoFn(); dismissToast(t.id); }} onDismiss={() => dismissToast(t.id)} />)}
      {conflictNode && <ConflictModal node={conflictNode} onClose={() => setConflictNode(null)} onResolve={resolve} />}
      {tensionOpen && <TensionPanel nodes={cur.nodeMap} onNavigate={id => { navigateTo(id); setTensionOpen(false); }} onClose={() => setTensionOpen(false)} />}
      {fusionPreview && <FusionModal mappings={fusionPreview} nodes={cur.nodeMap} accent={accent} onConfirm={applyFusion} onDismiss={() => setFusionPreview(null)} />}
      {importModal && <DocumentImportModal accent={accent} nodes={cur.nodeMap} onImport={handleImport} onClose={() => setImportModal(false)} />}
      {noteMigrationModal && <NoteMigrationModal accent={accent} nodes={cur.nodeMap} onMigrate={handleNoteMigration} onClose={() => setNoteMigrationModal(false)} />}
      {searchOpen && <SearchPalette nodes={cur.nodeMap} accent={accent} bookmarks={bookmarks} onNavigate={id => { navigateAndHL(id); setSearchOpen(false); }} onClose={() => setSearchOpen(false)} />}
      {autoLinkSuggestions && autoLinkSuggestions.length > 0 && <AutoLinkSuggestions suggestions={autoLinkSuggestions} nodes={cur.nodeMap} accent={accent} onAccept={acceptAutoLink} onDismiss={() => setAutoLinkSuggestions(null)} />}
      {accountOpen && <AccountSettingsModal onClose={() => setAccountOpen(false)} onLoggedOut={() => {}} />}
    </div>
  );
}
