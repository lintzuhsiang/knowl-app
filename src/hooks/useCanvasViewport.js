import { useState, useRef, useCallback, useEffect } from "react";
import { clamp } from "../lib/constants";

/**
 * Owns canvas viewport state: pan, zoom, and the wheel-listener that
 * implements pinch-zoom + two-finger pan + Ctrl+scroll zoom.
 *
 *   pan, zoom               state (read for rendering)
 *   setPan, setZoom         setters
 *   panRef, zoomRef         refs always tracking latest values
 *                           (drag handlers and toCanvas read these to
 *                           avoid re-creating callbacks on every change)
 *   cSizeRef                ref to current canvas size {w, h} — written by
 *                           a ResizeObserver in App.jsx; we just hold it
 *                           here so other hooks/handlers can read it
 *   onWheel                 wheel handler (already attached internally)
 *   toCanvas(sx, sy)        screen → canvas coordinate transform
 *   resetViewport()         pan = {0,0}, zoom = 1 (used on drill / topic switch)
 *
 * The wheel listener is attached non-passively to `cvRef.current` so we can
 * preventDefault. Re-attaches when `attachTrigger` changes (used to wait for
 * auth gate to resolve and the canvas DOM element to mount).
 *
 * @param cvRef          ref to canvas DOM element
 * @param attachTrigger  re-run the attach effect when this changes
 *                       (typically pass `authNeeded`)
 */
export default function useCanvasViewport({ cvRef, attachTrigger }) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  const panRef = useRef(pan); panRef.current = pan;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const cSizeRef = useRef({ w: 800, h: 480 });

  const onWheel = useCallback((e) => {
    e.preventDefault();
    if (!cvRef.current) return;
    const rect = cvRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const curZoom = zoomRef.current;
    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom (trackpad) or Ctrl+scroll (mouse). Normalize delta so both feel natural.
      const delta = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const nz = clamp(curZoom * (1 - delta * 0.003), 0.25, 3);
      setPan(p => ({ x: mx - (mx - p.x) * (nz / curZoom), y: my - (my - p.y) * (nz / curZoom) }));
      setZoom(nz);
    } else {
      // Two-finger pan (trackpad) or scroll (mouse).
      const dx = e.deltaMode === 1 ? e.deltaX * 18 : e.deltaMode === 2 ? e.deltaX * 400 : e.deltaX;
      const dy = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      setPan(p => ({ x: p.x - dx, y: p.y - dy }));
    }
  }, [cvRef]);

  // Attach wheel listener. `attachTrigger` re-runs so we wait for the
  // canvas to actually mount (e.g. after auth gate resolves).
  useEffect(() => {
    const el = cvRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel, attachTrigger, cvRef]);

  const toCanvas = useCallback(
    (sx, sy) => ({
      x: (sx - panRef.current.x) / zoomRef.current,
      y: (sy - panRef.current.y) / zoomRef.current,
    }),
    []
  );

  const resetViewport = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  return {
    pan, setPan, zoom, setZoom,
    panRef, zoomRef, cSizeRef,
    onWheel, toCanvas, resetViewport,
  };
}
