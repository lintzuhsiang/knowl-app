import { useState, useRef, useCallback, useMemo } from "react";

const MW = 160, MH = 100, PAD = 40;

export default function Minimap({ nodes, edges, pan, zoom, canvasSize, accent, onPan, nodeW, nodeH }) {
  const [open, setOpen] = useState(true);
  const dragging = useRef(false);
  const ref = useRef(null);

  const { rects, edgeLines, vpRect, scale } = useMemo(() => {
    const arr = Object.values(nodes || {});
    if (!arr.length) return { rects: [], edgeLines: [], vpRect: null, scale: 1 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const measured = arr.map(n => {
      const w = nodeW(n), h = nodeH(n);
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w); maxY = Math.max(maxY, n.y + h);
      return { ...n, _w: w, _h: h };
    });
    minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
    const ww = maxX - minX || 1, wh = maxY - minY || 1;
    const s = Math.min(MW / ww, MH / wh);
    const rects = measured.map(n => {
      const color = n.conflict ? "#ef4444" : { diagram: "#7c3aed", table: "#0891b2", image: "#e11d48", link: "#2563eb", audio: "#059669" }[n.nodeType] || accent;
      return { id: n.id, x: (n.x - minX) * s, y: (n.y - minY) * s, w: Math.max(n._w * s, 2), h: Math.max(n._h * s, 2), color };
    });
    const cMap = {};
    measured.forEach(n => { cMap[n.id] = { cx: (n.x + n._w / 2 - minX) * s, cy: (n.y + n._h / 2 - minY) * s }; });
    const edgeLines = (edges || []).filter(e => cMap[e.from] && cMap[e.to]).map(e => ({ id: e.id, ...cMap[e.from], cx2: cMap[e.to].cx, cy2: cMap[e.to].cy }));
    const vx = (-pan.x / zoom - minX) * s, vy = (-pan.y / zoom - minY) * s;
    const vw = (canvasSize.w / zoom) * s, vh = (canvasSize.h / zoom) * s;
    return { rects, edgeLines, vpRect: { x: vx, y: vy, w: vw, h: vh }, scale: s, ox: minX, oy: minY };
  }, [nodes, edges, pan, zoom, canvasSize, accent, nodeW, nodeH]);

  const worldFromEvent = useCallback((e) => {
    if (!ref.current) return null;
    const r = ref.current.getBoundingClientRect();
    const arr = Object.values(nodes || {});
    if (!arr.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    arr.forEach(n => { const w = nodeW(n), h = nodeH(n); minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + w); maxY = Math.max(maxY, n.y + h); });
    minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
    const ww = maxX - minX || 1, wh = maxY - minY || 1;
    const s = Math.min(MW / ww, MH / wh);
    const mx = (e.clientX - r.left) / s + minX;
    const my = (e.clientY - r.top) / s + minY;
    return { x: mx, y: my };
  }, [nodes, nodeW, nodeH]);

  const panTo = useCallback((e) => {
    const pt = worldFromEvent(e);
    if (!pt) return;
    onPan({ x: -pt.x * zoom + canvasSize.w / 2, y: -pt.y * zoom + canvasSize.h / 2 });
  }, [worldFromEvent, onPan, zoom, canvasSize]);

  const onDown = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    dragging.current = true;
    panTo(e);
    const onMove = (ev) => { if (dragging.current) panTo(ev); };
    const onUp = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [panTo]);

  const onTouchDown = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    dragging.current = true;
    if (e.touches.length > 0) panTo(e.touches[0]);
    const onMove = (ev) => { if (dragging.current && ev.touches.length > 0) panTo(ev.touches[0]); };
    const onUp = () => { dragging.current = false; window.removeEventListener("touchmove", onMove); window.removeEventListener("touchend", onUp); };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
  }, [panTo]);

  if (!open) return (
    <button onClick={() => setOpen(true)} style={{ position: "absolute", bottom: 16, right: 16, zIndex: 40, width: 28, height: 28, borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter',system-ui,sans-serif", fontSize: 12, color: "var(--color-text-tertiary)" }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><rect x="10" y="10" width="11" height="11" rx="1" /></svg>
    </button>
  );

  return (
    <div style={{ position: "absolute", bottom: 16, right: 16, zIndex: 40, width: MW, height: MH, borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-secondary)", overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.08)", fontFamily: "'Inter',system-ui,sans-serif" }}>
      <button onClick={() => setOpen(false)} style={{ position: "absolute", top: 3, right: 3, zIndex: 2, width: 16, height: 16, borderRadius: 4, border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, lineHeight: 1, color: "var(--color-text-tertiary)", padding: 0 }}>x</button>
      <svg ref={ref} width={MW} height={MH} style={{ display: "block", cursor: "crosshair", touchAction: "none" }} onMouseDown={onDown} onTouchStart={onTouchDown}>
        {edgeLines.map(e => <line key={e.id} x1={e.cx} y1={e.cy} x2={e.cx2} y2={e.cy2} stroke="var(--color-border-tertiary)" strokeWidth={0.5} />)}
        {rects.map(r => <rect key={r.id} x={r.x} y={r.y} width={r.w} height={r.h} rx={1} fill={r.color} opacity={0.55} />)}
        {vpRect && <rect x={vpRect.x} y={vpRect.y} width={vpRect.w} height={vpRect.h} fill={accent + "0a"} stroke={accent} strokeWidth={1} rx={1.5} />}
      </svg>
    </div>
  );
}
