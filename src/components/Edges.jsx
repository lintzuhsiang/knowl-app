import { nodeW, nodeH, nearest, bezier } from "../lib/utils";

export default function Edges({ nodes, edges, accent, sel, hov, drawing, W, H }) {
  const vis = e => sel.includes(e.from) || sel.includes(e.to) || hov === e.from || hov === e.to;
  return (
    <svg style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }} width={W} height={H}>
      <defs>
        <marker id="ar"  markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill={accent} opacity="0.7" /></marker>
        <marker id="arg" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#888"  opacity="0.5" /></marker>
      </defs>
      {edges.filter(e => nodes[e.from] && nodes[e.to]).map(e => {
        const nf = nodes[e.from], nt = nodes[e.to];
        const a1 = nearest(nf, nt.x + nodeW(nt) / 2, nt.y + nodeH(nt) / 2);
        const a2 = nearest(nt, nf.x + nodeW(nf) / 2, nf.y + nodeH(nf) / 2);
        const isPending = !!e.pending;
        return (
          <path key={e.id} d={bezier(a1, a2)}
            stroke={isPending ? "#888" : accent}
            strokeWidth={isPending ? 1.2 : 1.5}
            fill="none"
            strokeDasharray={e.dash ? "6,4" : "none"}
            markerEnd={isPending ? "url(#arg)" : "url(#ar)"}
            opacity={isPending ? 0.45 : vis(e) ? 0.65 : 0.07}
            style={{ transition: "opacity 0.2s" }} />
        );
      })}
      {drawing && (
        <path d={"M" + drawing.x1 + "," + drawing.y1 + " L" + drawing.x2 + "," + drawing.y2}
          stroke="#888" strokeWidth={1.5} fill="none" strokeDasharray="5,4" opacity="0.6" markerEnd="url(#arg)" />
      )}
      {drawing?.snap && <circle cx={drawing.x2} cy={drawing.y2} r={9} fill="none" stroke={accent} strokeWidth={2} opacity="0.85" />}
    </svg>
  );
}
