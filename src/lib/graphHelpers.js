import { SEED, NW } from "./constants";
import { nodeW, nodeH } from "./utils";

/**
 * Merge server graph into local graph, preserving local-only fields.
 *
 * Why this exists: the server doesn't store inlineNotes (free-positioned
 * text blocks in sub-canvases). Without this, every server sync would
 * wipe the user's notes. This function keeps the server's nodeMap/edges
 * but preserves the local inlineNotes array for each canvas key.
 */
export function mergeServerGraph(local, serverData) {
  const merged = Object.assign({}, local);
  for (const [key, serverCanvas] of Object.entries(serverData)) {
    merged[key] = Object.assign({}, serverCanvas, {
      inlineNotes: local[key]?.inlineNotes || [],
    });
  }
  return merged;
}

/**
 * Build the initial graph state from the hardcoded SEED data.
 *
 * Converts the SEED format (which uses a `nodes` array) into the
 * runtime format (which uses a `nodeMap` object keyed by node id).
 * Each node and edge is shallow-cloned so mutations don't affect SEED.
 */
export function buildGraph() {
  const g = {};
  for (const [k, v] of Object.entries(SEED)) {
    const nm = {};
    v.nodes.forEach(n => { nm[n.id] = Object.assign({}, n); });
    g[k] = Object.assign({}, v, { nodeMap: nm, edges: v.edges.map(e => Object.assign({}, e)) });
  }
  return g;
}

/**
 * Find the first empty {x, y} position in a nodeMap where a new node
 * won't overlap any existing node. Scans in a grid pattern (left→right,
 * top→bottom) with padding between cells.
 *
 * Falls back to placing below the lowest existing node if the 2000×2000
 * scan area is fully occupied.
 */
export function findEmptySpot(nodeMap) {
  const PAD = 30, nodes = Object.values(nodeMap);
  const colStep = NW + PAD * 2, rowStep = 160;
  for (let row = 60; row < 2000; row += rowStep) {
    for (let col = 60; col < 2000; col += colStep) {
      if (!nodes.some(n =>
        col < n.x + nodeW(n) + PAD && col + NW > n.x - PAD &&
        row < n.y + nodeH(n) + PAD && row + nodeH(n) > n.y - PAD
      )) return { x: col, y: row };
    }
  }
  return { x: 60, y: nodes.reduce((m, n) => Math.max(m, n.y + nodeH(n)), 0) + 40 };
}

// ─── Structural Context Pack ─────────────────────────────────────────────────
// Replaces the flat "all-node-titles" injection with a hierarchy-aware view:
// breadcrumb → drill-parent body → in-canvas nodes (with parentId nesting +
// outgoing edges). Used by ChatPanel (Feature 1), background conflict
// detection (Feature 2), and Warmup/Test/Tutor modes (Feature 3).

/**
 * Build a structural context pack for a canvas view.
 *
 *   buildContextPack(graph, topic, drillPath) → pack | null
 *
 * `drillPath` is the App-level array `[{id, title}, ...]`. Pass `[]` for
 * the root canvas. The pack contains rendered titles + bodies but no
 * memory metadata — feed that in separately when needed (e.g. Warmup).
 */
export function buildContextPack(graph, topic, drillPath = []) {
  if (!graph) return null;
  const canvasKey = drillPath.length === 0
    ? topic
    : topic + "::drill::" + drillPath.map(d => d.id).join("::drill::");
  const canvas = graph[canvasKey];
  if (!canvas) return null;

  // For each drill level, fetch the parent node's full body from its
  // *containing* canvas — that's "the note this sub-canvas is about".
  const drillTrail = drillPath.map((entry, i) => {
    const parentCanvasKey = i === 0
      ? topic
      : topic + "::drill::" + drillPath.slice(0, i).map(d => d.id).join("::drill::");
    const parentNode = graph[parentCanvasKey]?.nodeMap?.[entry.id];
    return {
      id: entry.id,
      title: entry.title,
      body: parentNode?.body || null,
      summary: parentNode?.summary || null,
    };
  });

  const nodes   = Object.values(canvas.nodeMap || {});
  const nodesById = canvas.nodeMap || {};

  // Index edges by source for nested rendering
  const edgesByFrom = {};
  for (const e of canvas.edges || []) {
    if (!edgesByFrom[e.from]) edgesByFrom[e.from] = [];
    const target = nodesById[e.to];
    if (target) edgesByFrom[e.from].push({ to: e.to, toTitle: target.title, label: e.label });
  }

  // Hierarchy via parentId within this canvas
  const topLevel = nodes.filter(n => !n.parentId);
  const childrenByParent = {};
  for (const n of nodes) {
    if (!n.parentId) continue;
    (childrenByParent[n.parentId] ||= []).push(n);
  }

  const rootTopicLabel = graph[topic]?.label || topic;
  return {
    canvasKey,
    canvasLabel: canvas.label || topic,
    rootTopicLabel,
    breadcrumb: [
      { title: rootTopicLabel, isRoot: true },
      ...drillPath.map(d => ({ id: d.id, title: d.title })),
    ],
    drillTrail,
    drillParent: drillTrail[drillTrail.length - 1] || null,
    nodes,
    nodesById,
    topLevel,
    childrenByParent,
    edgesByFrom,
    nodeCount: nodes.length,
  };
}

function summarizeBody(body) {
  if (!body) return '';
  return body.replace(/^#+\s.*\n?/g, '').trim().replace(/\n+/g, ' ').slice(0, 110);
}

function renderNode(node, pack, indent, bodyTruncate) {
  const out = [];
  const conflict = node.conflict?.status === 'unresolved'
    ? ` [CONFLICT: ${node.conflict.label}]`
    : '';
  const summary = node.summary
    || (bodyTruncate > 0 ? node.body?.slice(0, bodyTruncate).replace(/\n/g, ' ') : summarizeBody(node.body));
  const tail = summary ? ` — ${summary}` : '';
  out.push(`${indent}- "${node.title}"${conflict}${tail}`);
  for (const e of pack.edgesByFrom[node.id] || []) {
    out.push(`${indent}    —[${e.label || 'relates to'}]→ "${e.toTitle}"`);
  }
  for (const child of pack.childrenByParent[node.id] || []) {
    out.push(renderNode(child, pack, indent + '  ', bodyTruncate));
  }
  return out.join('\n');
}

/**
 * Render a context pack as a prompt-friendly string.
 *
 *   formatContextPack(pack, { includeParentBody?, bodyTruncate? })
 *
 * `includeParentBody` (default true) includes the drill-parent's full body.
 * `bodyTruncate` (default 0 = use summary) caps per-node body length.
 */
export function formatContextPack(pack, opts = {}) {
  if (!pack) return '';
  const { includeParentBody = true, bodyTruncate = 0 } = opts;
  const lines = [];

  const path = pack.breadcrumb.map(b => b.title).join(' > ');
  lines.push(`CURRENT VIEW: ${path}`);

  if (pack.drillParent && includeParentBody && pack.drillParent.body) {
    lines.push('');
    lines.push(`This sub-canvas drilled into "${pack.drillParent.title}". Existing notes:`);
    lines.push(pack.drillParent.body.trim());
  }

  lines.push('');
  if (pack.nodeCount === 0) {
    lines.push('(no nodes captured in this view yet)');
  } else {
    lines.push(`NODES IN THIS VIEW (${pack.nodeCount}):`);
    for (const n of pack.topLevel) lines.push(renderNode(n, pack, '', bodyTruncate));
  }

  return lines.join('\n');
}

/**
 * Static node template definitions for the right-click "New from template" menu.
 * Each template specifies initial dimensions, body content, and auto-detected nodeType.
 */
export const NODE_TEMPLATES = [
  { label: "Pros / Cons", icon: "⚖", nodeType: "table", w: 300, h: 160, title: "Pros vs Cons", body: "| Pros | Cons |\n|---|---|\n| Pro 1 | Con 1 |\n| Pro 2 | Con 2 |" },
  { label: "Timeline", icon: "→", nodeType: "diagram", w: 340, h: 140, title: "Timeline", body: "[Step 1] --> [Step 2] --> [Step 3] --> [Step 4]" },
  { label: "Flowchart", icon: "△", nodeType: "diagram", w: 340, h: 180, title: "Flowchart", body: "[Start] --> [Process]\n[Process] --> [Decision]\n| Yes --> [Action A]\n| No --> [Action B]\n[Action A] --> [End]\n[Action B] --> [End]" },
  { label: "Comparison", icon: "≡", nodeType: "table", w: 340, h: 180, title: "Comparison", body: "| Feature | Option A | Option B |\n|---|---|---|\n| Speed | Fast | Medium |\n| Cost | High | Low |\n| Quality | Excellent | Good |" },
  { label: "Checklist", icon: "☑", nodeType: "text", w: 260, h: 140, title: "Checklist", body: "# Checklist\n- Item 1\n- Item 2\n- Item 3\n- Item 4" },
  { label: "Link card", icon: "🔗", nodeType: "link", w: 260, h: 120, title: "Link", body: "https://example.com\nDescription of the resource" },
  { label: "Image", icon: "🖼", nodeType: "image", w: 280, h: 180, title: "Image", body: "" },
  { label: "Voice memo", icon: "🎤", nodeType: "audio", w: 260, h: 140, title: "Voice Memo", body: "" },
];
