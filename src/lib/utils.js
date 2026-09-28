import { NW } from "./constants";

export const nodeW = n => n.w || NW;
export const nodeH = n => Math.max(80, n.h || 120);

export function getAnchors(n) {
  const h = nodeH(n), w = nodeW(n);
  return [
    { dir: "top",    x: n.x + w / 2, y: n.y },
    { dir: "right",  x: n.x + w,     y: n.y + h / 2 },
    { dir: "bottom", x: n.x + w / 2, y: n.y + h },
    { dir: "left",   x: n.x,         y: n.y + h / 2 },
  ];
}

export function nearest(n, px, py) {
  return getAnchors(n).reduce((b, a) =>
    Math.hypot(a.x - px, a.y - py) < Math.hypot(b.x - px, b.y - py) ? a : b
  );
}

// Compute the cubic bezier control points for an edge between two anchors.
// Returns [p0, c1, c2, p3] in the same order used by the SVG "C" command.
export function bezierPoints(a1, a2) {
  const c = Math.min(Math.hypot(a2.x - a1.x, a2.y - a1.y) * 0.45, 110);
  const h = d => d === "right" || d === "left";
  const c1x = h(a1.dir) ? a1.x + (a1.dir === "right" ? c : -c) : a1.x;
  const c1y = h(a1.dir) ? a1.y : a1.y + (a1.dir === "bottom" ? c : -c);
  const c2x = h(a2.dir) ? a2.x + (a2.dir === "right" ? c : -c) : a2.x;
  const c2y = h(a2.dir) ? a2.y : a2.y + (a2.dir === "bottom" ? c : -c);
  return [{ x: a1.x, y: a1.y }, { x: c1x, y: c1y }, { x: c2x, y: c2y }, { x: a2.x, y: a2.y }];
}

export function bezier(a1, a2) {
  const [p0, c1, c2, p3] = bezierPoints(a1, a2);
  return "M" + p0.x + "," + p0.y + " C" + c1.x + "," + c1.y + " " + c2.x + "," + c2.y + " " + p3.x + "," + p3.y;
}

// Point on the cubic bezier at parameter t (0..1). Used for placing labels
// and anchor dots precisely on the rendered edge curve.
export function bezierPoint(a1, a2, t) {
  const [p0, c1, c2, p3] = bezierPoints(a1, a2);
  const mt = 1 - t;
  const b0 = mt * mt * mt;
  const b1 = 3 * mt * mt * t;
  const b2 = 3 * mt * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * c1.x + b2 * c2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * c1.y + b2 * c2.y + b3 * p3.y,
  };
}

// Midpoint of the edge curve between two nodes, using the nearest anchors
// on each node (the same logic used to draw the curve itself).
export function edgeMidpoint(nf, nt) {
  const a1 = nearest(nf, nt.x + nodeW(nt) / 2, nt.y + nodeH(nt) / 2);
  const a2 = nearest(nt, nf.x + nodeW(nf) / 2, nf.y + nodeH(nf) / 2);
  return bezierPoint(a1, a2, 0.5);
}

export function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
