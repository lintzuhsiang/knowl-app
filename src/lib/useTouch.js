import { useEffect, useRef } from "react";
import { clamp, MERGE_R, SR, IS_TOUCH } from "./constants";
import { nodeW, nodeH, getAnchors, nearest } from "./utils";

/**
 * useTouch — parallel touch layer for the Knowl canvas.
 * Handles: 1-finger pan, 2-finger pinch-to-zoom, node drag,
 * tap/double-tap, long-press context menu, and edge drawing.
 *
 * Does NOT modify existing mouse handlers — coexists via the
 * shared `drag` ref and state setters.
 */
export default function useTouch({
  cvRef, drag, panRef, zoomRef, setPan, setZoom,
  graphRef, topic, toCanvas, mut,
  setSel, setHov, setIsDragging, setMergeTarget,
  setDrawing, setTemplateMenu, setContextCapture,
  onCanvasDoubleTap,   // (sx, sy) => create node at screen coords
  onNodeDoubleTap,     // (nodeId) => trigger edit on node
  onAnchorDown,        // (nodeId, dir) => start edge drawing
  onFinishEdge,        // () => finalize edge from drawing state
}) {
  const touchState = useRef(null);
  const pinchRef = useRef(null);
  const lastTapRef = useRef({ time: 0, x: 0, y: 0 });
  const startTouch = useRef(null);
  const longPressTimer = useRef(null);
  const movedRef = useRef(false);
  const panStartRef = useRef(null); // snapshot of pan at touch start

  useEffect(() => {
    const el = cvRef.current;
    if (!el || !IS_TOUCH) return;

    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    /* ── Hit-test helpers ───────────────────────────────────── */
    const hitTestAnchor = (sx, sy, nm) => {
      // Check if touch is near an anchor dot of a selected/hovered node
      const curZoom = zoomRef.current, curPan = panRef.current;
      for (const [nid, n] of Object.entries(nm)) {
        const anchors = getAnchors(n);
        for (const a of anchors) {
          const ax = a.x * curZoom + curPan.x;
          const ay = a.y * curZoom + curPan.y;
          if (Math.hypot(sx - ax, sy - ay) < 22 * curZoom) {
            return { nodeId: nid, dir: a.dir };
          }
        }
      }
      return null;
    };

    const hitTestNode = (cx, cy, nm) => {
      // Returns topmost node containing world-coord point (cx, cy)
      // Iterate in reverse-render order would be ideal, but Object.entries is fine for small graphs
      let hit = null;
      for (const [nid, n] of Object.entries(nm)) {
        if (cx >= n.x && cx <= n.x + nodeW(n) && cy >= n.y && cy <= n.y + nodeH(n)) {
          hit = nid;
        }
      }
      return hit;
    };

    /* ── TOUCHSTART ─────────────────────────────────────────── */
    const onTouchStart = e => {
      clearTimeout(longPressTimer.current);

      if (e.touches.length === 2) {
        // Pinch start — override any single-finger state
        touchState.current = "pinch";
        const d = dist(e.touches[0], e.touches[1]);
        const m = mid(e.touches[0], e.touches[1]);
        const rect = el.getBoundingClientRect();
        pinchRef.current = {
          startDist: d,
          startZoom: zoomRef.current,
          startPan: { ...panRef.current },
          startMid: { x: m.x - rect.left, y: m.y - rect.top },
        };
        // Cancel any pending node drag
        if (drag.current) { drag.current = null; setIsDragging(false); }
        return;
      }

      if (e.touches.length !== 1) return;

      const t = e.touches[0];
      const rect = el.getBoundingClientRect();
      const sx = t.clientX - rect.left;
      const sy = t.clientY - rect.top;
      startTouch.current = { x: t.clientX, y: t.clientY, sx, sy, time: Date.now() };
      movedRef.current = false;
      panStartRef.current = { ...panRef.current };

      const nm = graphRef.current[topic]?.nodeMap || {};
      const { x: cx, y: cy } = toCanvas(sx, sy);

      // Priority 1: Check anchor dots (for edge drawing)
      const anchorHit = hitTestAnchor(sx, sy, nm);
      if (anchorHit) {
        e.preventDefault();
        touchState.current = "edge-draw";
        startTouch.current.anchorHit = anchorHit;
        onAnchorDown(anchorHit.nodeId, anchorHit.dir);
        return;
      }

      // Priority 2: Check node body
      const hitNode = hitTestNode(cx, cy, nm);
      if (hitNode) {
        e.preventDefault();
        touchState.current = "node-pending";
        startTouch.current.hitNode = hitNode;
        return;
      }

      // Priority 3: Empty canvas — start pan-pending
      touchState.current = "pan-pending";
      longPressTimer.current = setTimeout(() => {
        if (!movedRef.current && touchState.current === "pan-pending") {
          touchState.current = "long-press";
          const { x, y } = toCanvas(sx, sy);
          setTemplateMenu({ x, y, screenX: sx, screenY: sy });
          if (navigator.vibrate) navigator.vibrate(30);
        }
      }, 500);
    };

    /* ── TOUCHMOVE ──────────────────────────────────────────── */
    const onTouchMove = e => {
      e.preventDefault();

      // ── Pinch-to-zoom ──
      if (e.touches.length === 2 && touchState.current === "pinch" && pinchRef.current) {
        const d = dist(e.touches[0], e.touches[1]);
        const m = mid(e.touches[0], e.touches[1]);
        const rect = el.getBoundingClientRect();
        const mx = m.x - rect.left, my = m.y - rect.top;
        const p = pinchRef.current;
        const ratio = d / p.startDist;
        const nz = clamp(p.startZoom * ratio, 0.25, 3);
        // Focal-point zoom: keep the midpoint of the two fingers fixed
        const nx = mx - (p.startMid.x - p.startPan.x) * (nz / p.startZoom);
        const ny = my - (p.startMid.y - p.startPan.y) * (nz / p.startZoom);
        setPan({ x: nx, y: ny });
        setZoom(nz);
        return;
      }

      if (e.touches.length !== 1 || !startTouch.current) return;
      const t = e.touches[0];
      const dx = t.clientX - startTouch.current.x;
      const dy = t.clientY - startTouch.current.y;

      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        movedRef.current = true;
        clearTimeout(longPressTimer.current);
      }

      // ── Pan-pending → Pan ──
      if (touchState.current === "pan-pending" && movedRef.current) {
        touchState.current = "pan";
      }

      if (touchState.current === "pan") {
        setPan({
          x: panStartRef.current.x + dx,
          y: panStartRef.current.y + dy,
        });
      }

      // ── Node-pending → Node-drag ──
      if (touchState.current === "node-pending" && movedRef.current) {
        touchState.current = "node-drag";
        const nodeId = startTouch.current.hitNode;
        const n = graphRef.current[topic]?.nodeMap?.[nodeId];
        if (n) {
          drag.current = {
            type: "node",
            id: nodeId,
            ox: startTouch.current.x - n.x * zoomRef.current - panRef.current.x,
            oy: startTouch.current.y - n.y * zoomRef.current - panRef.current.y,
            origX: n.x,
            origY: n.y,
          };
          setIsDragging(true);
          setSel(prev => prev.includes(nodeId) ? prev : [nodeId]);
        }
      }

      if (touchState.current === "node-drag" && drag.current?.type === "node") {
        const { id, ox, oy } = drag.current;
        const curPan = panRef.current, curZoom = zoomRef.current;
        const nx = (t.clientX - ox - curPan.x) / curZoom;
        const ny = (t.clientY - oy - curPan.y) / curZoom;
        mut(nm => { nm[id] = Object.assign({}, nm[id], { x: nx, y: ny }); });
        // Merge-proximity detection
        const nm = graphRef.current[topic]?.nodeMap || {};
        let mt = null;
        for (const [nid, n] of Object.entries(nm)) {
          if (nid === id) continue;
          if (Math.hypot(nx + nodeW(nm[id] || {}) / 2 - (n.x + nodeW(n) / 2), ny + nodeH(nm[id] || {}) / 2 - (n.y + nodeH(n) / 2)) < MERGE_R) {
            mt = nid; break;
          }
        }
        setMergeTarget(mt);
      }

      // ── Edge drawing ──
      if (touchState.current === "edge-draw") {
        const rect = el.getBoundingClientRect();
        const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
        const { x: cx, y: cy } = toCanvas(sx, sy);
        const curPan = panRef.current, curZoom = zoomRef.current;
        const nm = graphRef.current[topic]?.nodeMap || {};
        const fromId = startTouch.current.anchorHit.nodeId;
        let snap = null;
        for (const [nid, n] of Object.entries(nm)) {
          if (nid === fromId) continue;
          const a = nearest(n, cx, cy);
          const ax = a.x * curZoom + curPan.x, ay = a.y * curZoom + curPan.y;
          if (Math.hypot(ax - sx, ay - sy) < SR) {
            snap = { nodeId: nid, anch: a, sx: ax, sy: ay };
            break;
          }
        }
        setDrawing(prev => prev ? Object.assign({}, prev, {
          x2: snap ? snap.sx : sx, y2: snap ? snap.sy : sy, snap,
        }) : prev);
      }
    };

    /* ── TOUCHEND ───────────────────────────────────────────── */
    const onTouchEnd = e => {
      clearTimeout(longPressTimer.current);

      // Pinch ended
      if (touchState.current === "pinch") {
        if (e.touches.length === 0) {
          touchState.current = null;
          pinchRef.current = null;
        }
        return;
      }

      // Edge drawing end
      if (touchState.current === "edge-draw") {
        touchState.current = null;
        startTouch.current = null;
        onFinishEdge();
        return;
      }

      if (e.touches.length > 0) return; // still have fingers down

      // Node drag end
      if (touchState.current === "node-drag") {
        setIsDragging(false);
        setMergeTarget(null);
        drag.current = null;
        touchState.current = null;
        startTouch.current = null;
        return;
      }

      // Tap detection (no significant movement)
      if (!movedRef.current && touchState.current !== "long-press") {
        const now = Date.now();
        const lt = lastTapRef.current;
        const st = startTouch.current;
        if (!st) { touchState.current = null; return; }
        const tapDist = Math.hypot(st.x - lt.x, st.y - lt.y);

        if (now - lt.time < 350 && tapDist < 30) {
          // ── Double tap ──
          lastTapRef.current = { time: 0, x: 0, y: 0 };
          if (touchState.current === "node-pending" && st.hitNode) {
            onNodeDoubleTap(st.hitNode);
          } else if (touchState.current === "pan-pending") {
            onCanvasDoubleTap(st.sx, st.sy);
          }
        } else {
          // ── Single tap ──
          lastTapRef.current = { time: now, x: st.x, y: st.y };
          if (touchState.current === "pan-pending") {
            setSel([]);
            setHov(null);
            setContextCapture(null);
            setTemplateMenu(null);
          } else if (touchState.current === "node-pending" && st.hitNode) {
            setSel([st.hitNode]);
          }
        }
      }

      touchState.current = null;
      startTouch.current = null;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchEnd, { passive: false });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      clearTimeout(longPressTimer.current);
    };
  }, [
    cvRef, drag, panRef, zoomRef, setPan, setZoom,
    graphRef, topic, toCanvas, mut,
    setSel, setHov, setIsDragging, setMergeTarget,
    setDrawing, setTemplateMenu, setContextCapture,
    onCanvasDoubleTap, onNodeDoubleTap, onAnchorDown, onFinishEdge,
  ]);
}
