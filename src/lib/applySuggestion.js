/**
 * Apply a suggestion to the graph (one-click apply for Feature 2 + Phase 4 propose tools).
 *
 *   applySuggestion(suggestion, ctx) → { ok, summary, error? }
 *
 * ctx must provide:
 *   mutCanvas(fn)   atomic mutation over { nodeMap, edges }
 *   pushUndo()      snapshot before applying (caller wraps with this)
 *   findEmptySpot   helper to position new nodes
 *
 * Apply does NOT call pushUndo itself — caller is responsible (lets caller
 * decide undo grouping, e.g. when accepting multiple suggestions at once).
 *
 * Return value `{ ok: true, summary: "..." }` so caller can show a toast
 * "Applied: <summary> — undo?".
 */

import { uid } from "./constants";
import { findEmptySpot } from "./graphHelpers";

export function applySuggestion(suggestion, ctx) {
  if (!suggestion || !suggestion.type) {
    return { ok: false, error: 'invalid suggestion' };
  }
  const { type, payload } = suggestion;
  try {
    switch (type) {
      case 'merge':    return applyMerge(payload, ctx);
      case 'edge':     return applyAddEdge(payload, ctx);
      case 'conflict': return applyConflict(payload, ctx);
      case 'create':   return applyCreate(payload, ctx);
      case 'update':   return applyUpdate(payload, ctx);
      case 'delete':   return applyDelete(payload, ctx);
      case 'unlink':   return applyUnlink(payload, ctx);
      default:
        return { ok: false, error: `unknown suggestion type: ${type}` };
    }
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ─── Per-type appliers ──────────────────────────────────────────────────────

function applyMerge(p, { mutCanvas }) {
  const ids = p?.ids || [];
  if (ids.length < 2) return { ok: false, error: 'merge needs ≥2 ids' };
  const [keeper, ...losers] = ids;
  const loserSet = new Set(losers);
  let actuallyMerged = 0;

  mutCanvas(({ nodeMap, edges }) => {
    if (!nodeMap[keeper]) return; // keeper doesn't exist; abort

    // Update keeper with merged content
    nodeMap[keeper] = {
      ...nodeMap[keeper],
      title: p.merged_title || nodeMap[keeper].title,
      body:  p.merged_body  || nodeMap[keeper].body,
      summary: null,
    };

    // Re-route edges from/to losers → keeper, then dedupe + drop self-loops
    const rerouted = edges
      .map(e => ({
        ...e,
        from: loserSet.has(e.from) ? keeper : e.from,
        to:   loserSet.has(e.to)   ? keeper : e.to,
      }))
      .filter(e => e.from !== e.to);

    const seen = new Set();
    const dedup = [];
    for (const e of rerouted) {
      const k = `${e.from}|${e.to}|${e.label || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(e);
    }

    // Delete losers
    for (const id of losers) {
      if (nodeMap[id]) { delete nodeMap[id]; actuallyMerged++; }
    }

    return { nodeMap, edges: dedup };
  });

  if (actuallyMerged === 0) {
    return { ok: false, error: 'merge targets no longer exist' };
  }
  return {
    ok: true,
    summary: `Merged ${actuallyMerged + 1} nodes into "${p.merged_title || 'merged node'}"`,
  };
}

function applyAddEdge(p, { mutCanvas }) {
  if (!p?.from || !p?.to) return { ok: false, error: 'edge needs from + to' };
  let added = false;
  mutCanvas(({ nodeMap, edges }) => {
    if (!nodeMap[p.from] || !nodeMap[p.to]) return;
    // Skip if edge already exists (same from/to/label)
    const exists = edges.some(e => e.from === p.from && e.to === p.to && (e.label || '') === (p.label || ''));
    if (exists) return;
    edges.push({ id: uid(), from: p.from, to: p.to, label: p.label || 'relates to', dash: !!p.dash });
    added = true;
    return { nodeMap, edges };
  });
  if (!added) return { ok: false, error: 'edge already exists or endpoints missing' };
  return { ok: true, summary: `Linked: ${p.from} —[${p.label}]→ ${p.to}` };
}

function applyConflict(p, { mutCanvas }) {
  if (!p?.id_a || !p?.id_b) return { ok: false, error: 'conflict needs id_a + id_b' };
  let marked = 0;
  mutCanvas(({ nodeMap, edges }) => {
    const tag = { inp: p.tension || '', label: p.tension || 'tension', status: 'unresolved' };
    for (const id of [p.id_a, p.id_b]) {
      if (nodeMap[id]) {
        nodeMap[id] = { ...nodeMap[id], conflict: tag };
        marked++;
      }
    }
    return { nodeMap, edges };
  });
  if (marked === 0) return { ok: false, error: 'conflict targets missing' };
  return { ok: true, summary: `Marked conflict between ${p.id_a} and ${p.id_b}` };
}

function applyCreate(p, { mutCanvas }) {
  if (!p?.title) return { ok: false, error: 'create needs title' };
  const newId = uid();
  let placed = false;
  mutCanvas(({ nodeMap, edges }) => {
    const pos = findEmptySpot(nodeMap);
    nodeMap[newId] = {
      id: newId,
      x: pos.x, y: pos.y, h: 120, w: null,
      title: p.title,
      body: p.body || `# ${p.title}\n`,
      summary: null, confidence: null, conflict: null,
      tag: 'new-domain', relatedTo: null,
      parentId: p.parent_id && nodeMap[p.parent_id] ? p.parent_id : null,
      collapsed: false, entryContext: null, nodeType: 'text',
    };
    // Optional outgoing links to existing nodes
    if (Array.isArray(p.links_to)) {
      for (const targetId of p.links_to) {
        if (nodeMap[targetId]) {
          edges.push({ id: uid(), from: newId, to: targetId, label: 'relates to', dash: false });
        }
      }
    }
    placed = true;
    return { nodeMap, edges };
  });
  if (!placed) return { ok: false, error: 'failed to place new node' };
  return { ok: true, summary: `Created "${p.title}"`, newNodeId: newId };
}

function applyUpdate(p, { mutCanvas }) {
  if (!p?.node_id || !p?.patch) return { ok: false, error: 'update needs node_id + patch' };
  let updated = false;
  mutCanvas(({ nodeMap, edges }) => {
    if (!nodeMap[p.node_id]) return;
    const ALLOWED = ['title', 'body', 'confidence', 'tag'];
    const patch = {};
    for (const k of ALLOWED) if (p.patch[k] !== undefined) patch[k] = p.patch[k];
    if (patch.body !== undefined) patch.summary = null; // invalidate cached summary
    nodeMap[p.node_id] = { ...nodeMap[p.node_id], ...patch };
    updated = true;
    return { nodeMap, edges };
  });
  if (!updated) return { ok: false, error: `node ${p.node_id} not found` };
  return { ok: true, summary: `Updated "${p.node_id}"` };
}

function applyDelete(p, { mutCanvas }) {
  if (!p?.node_id) return { ok: false, error: 'delete needs node_id' };
  let deleted = false;
  mutCanvas(({ nodeMap, edges }) => {
    if (!nodeMap[p.node_id]) return;
    delete nodeMap[p.node_id];
    const filtered = edges.filter(e => e.from !== p.node_id && e.to !== p.node_id);
    deleted = true;
    return { nodeMap, edges: filtered };
  });
  if (!deleted) return { ok: false, error: `node ${p.node_id} not found` };
  return { ok: true, summary: `Deleted "${p.node_id}"` };
}

function applyUnlink(p, { mutCanvas }) {
  if (!p?.edge_id) return { ok: false, error: 'unlink needs edge_id' };
  let removed = false;
  mutCanvas(({ nodeMap, edges }) => {
    const before = edges.length;
    const next = edges.filter(e => e.id !== p.edge_id);
    removed = next.length !== before;
    return { nodeMap, edges: next };
  });
  if (!removed) return { ok: false, error: `edge ${p.edge_id} not found` };
  return { ok: true, summary: `Removed edge ${p.edge_id}` };
}
