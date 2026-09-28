/**
 * Agent tool registry.
 *
 * Phase 4 M4-α: 10 tools — Tier 1 read-only (8) + Tier 1.5 algorithmic
 * discovery (2). LLM-powered discovery tools (suggest_bridges, expand_concept,
 * infer_implicit_concepts, find_conceptual_gaps, infer_node_overlap) deferred
 * to M4-α.5 — they require sub-LLM call infrastructure not yet built.
 *
 * Each tool:
 *   - name, description, input_schema   (sent to LLM as function declaration)
 *   - permission                         ('read' | 'discover' | 'propose')
 *   - run(input, ctx) → result          (ctx has workspaceId, canvasKey, db helpers)
 *
 * All read tools are scope-locked to the current canvas (ctx.canvasKey) unless
 * the tool explicitly accepts a `scope` arg. NO cross-canvas tools in M4-α.
 */

import {
  getGraph, getMemoryStats, listChatMessages, listGraphs,
  createSuggestion,
} from '../../db.js';
import { callSubLLMJSON } from './subllm.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadCanvasNodes(ctx) {
  // canvasKey could be drill key — but the DB stores each canvas keyed by
  // its full topic string. We read directly via getGraph which expects topic.
  const canvas = getGraph(ctx.workspaceId, ctx.canvasKey);
  if (!canvas) return { nodeMap: {}, edges: [] };
  return canvas;
}

function summarize(body, maxLen = 120) {
  if (!body) return '';
  return body
    .replace(/^#+\s*\S.*\n?/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// ─── Tier 1 — Read tools ─────────────────────────────────────────────────────

const search_nodes = {
  name: 'search_nodes',
  description: 'Keyword-search nodes in the CURRENT canvas. Returns matches with title + summary. Use this for "what did I write about X" questions.',
  permission: 'read',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'keywords to search for (case-insensitive)' },
      limit: { type: 'integer', description: 'max results (default 10)' },
    },
    required: ['query'],
  },
  run({ query, limit = 10 }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const q = String(query || '').toLowerCase();
    if (!q) return { matches: [], total: 0 };
    const all = Object.values(nodeMap);
    const matches = all
      .map(n => {
        const title = (n.title || '').toLowerCase();
        const body  = (n.body  || '').toLowerCase();
        const inTitle = title.includes(q);
        const inBody  = body.includes(q);
        if (!inTitle && !inBody) return null;
        return {
          id: n.id,
          title: n.title,
          summary: summarize(n.body),
          match_in: inTitle ? 'title' : 'body',
        };
      })
      .filter(Boolean)
      .slice(0, limit);
    return { matches, total: matches.length };
  },
};

const read_node = {
  name: 'read_node',
  description: 'Read the FULL body of a specific node by id. ALWAYS use this before claiming what a node says — never reason from title alone.',
  permission: 'read',
  input_schema: {
    type: 'object',
    properties: { node_id: { type: 'string' } },
    required: ['node_id'],
  },
  run({ node_id }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const n = nodeMap[node_id];
    if (!n) return { error: `node ${node_id} not found in current canvas` };
    return {
      id: n.id,
      title: n.title,
      body: n.body || '',
      summary: n.summary || summarize(n.body),
      confidence: n.confidence || null,
      conflict: n.conflict || null,
      parent_id: n.parentId || null,
      tag: n.tag || null,
    };
  },
};

const list_nodes = {
  name: 'list_nodes',
  description: 'List all nodes in the current canvas with title + 1-line summary. Use this to get a top-down view.',
  permission: 'read',
  input_schema: {
    type: 'object',
    properties: {
      top_level_only: { type: 'boolean', description: 'omit nodes with parentId (default false)' },
    },
  },
  run({ top_level_only = false }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const nodes = Object.values(nodeMap)
      .filter(n => !top_level_only || !n.parentId)
      .map(n => ({
        id: n.id,
        title: n.title,
        summary: summarize(n.body, 100),
        has_parent: !!n.parentId,
      }));
    return { nodes, total: nodes.length };
  },
};

const traverse = {
  name: 'traverse',
  description: 'Get a node\'s 1-hop or 2-hop neighbors via edges. Use this to understand connection structure around a node.',
  permission: 'read',
  input_schema: {
    type: 'object',
    properties: {
      node_id: { type: 'string' },
      hops: { type: 'integer', description: '1 or 2 (default 1)' },
    },
    required: ['node_id'],
  },
  run({ node_id, hops = 1 }, ctx) {
    const { nodeMap, edges } = loadCanvasNodes(ctx);
    const root = nodeMap[node_id];
    if (!root) return { error: `node ${node_id} not found` };
    const seen = new Set([node_id]);
    const layer1 = [];
    for (const e of edges || []) {
      if (e.from === node_id && !seen.has(e.to))   { layer1.push({ id: e.to,   via: e.label, direction: 'out' }); seen.add(e.to); }
      if (e.to   === node_id && !seen.has(e.from)) { layer1.push({ id: e.from, via: e.label, direction: 'in' });  seen.add(e.from); }
    }
    const result = { root: { id: node_id, title: root.title }, layer1: layer1.map(x => ({
      ...x, title: nodeMap[x.id]?.title || '(missing)',
    })) };
    if (hops >= 2) {
      const layer2 = [];
      for (const n1 of layer1) {
        for (const e of edges || []) {
          let other = null;
          if (e.from === n1.id && !seen.has(e.to))   other = { id: e.to,   via: e.label, direction: 'out', through: n1.id };
          if (e.to   === n1.id && !seen.has(e.from)) other = { id: e.from, via: e.label, direction: 'in',  through: n1.id };
          if (other) {
            seen.add(other.id);
            layer2.push({ ...other, title: nodeMap[other.id]?.title || '(missing)' });
          }
        }
      }
      result.layer2 = layer2;
    }
    return result;
  },
};

const list_topics = {
  name: 'list_topics',
  description: 'List all root topics in the user\'s workspace. Returns label + node count per topic. Use this when the user asks about something not in the current canvas — you can suggest they switch.',
  permission: 'read',
  input_schema: { type: 'object', properties: {} },
  run(_input, ctx) {
    const all = listGraphs(ctx.workspaceId);
    const topics = all
      .filter(g => !g.topic.includes('::drill::'))
      .map(g => ({ topic: g.topic, label: g.label, updated_at: g.updated_at }));
    return { topics, current_canvas: ctx.canvasKey };
  },
};

const get_user_focus = {
  name: 'get_user_focus',
  description: 'Get the user\'s current context — which canvas they\'re looking at, drill depth, how recently they were active. Use this on greeting / opener turns to decide whether to fire proactive discovery.',
  permission: 'read',
  input_schema: { type: 'object', properties: {} },
  run(_input, ctx) {
    const isDrilled = ctx.canvasKey.includes('::drill::');
    const drillDepth = isDrilled ? ctx.canvasKey.split('::drill::').length - 1 : 0;
    // Recent chat activity: last message ts
    const recent = listChatMessages(ctx.workspaceId, ctx.canvasKey, { limit: 1 });
    const msAgo = recent.length ? (Date.now() - recent[0].ts) : null;
    return {
      canvas_key: ctx.canvasKey,
      is_drilled: isDrilled,
      drill_depth: drillDepth,
      last_chat_ms_ago: msAgo,
      // Discovery hint for the agent — only fire proactive discovery when
      // user clearly returning after a gap. Avoid spamming on every "hi".
      returning_from_gap: msAgo == null || msAgo > 6 * 3600 * 1000,
    };
  },
};

const get_memory_stats = {
  name: 'get_memory_stats',
  description: 'Get memory metadata (viewed_at, viewed_count, edited_at, recall_score) for nodes in the current canvas. Use this to spot stale or frequently-revisited nodes.',
  permission: 'read',
  input_schema: {
    type: 'object',
    properties: {
      node_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional filter — only return stats for these ids',
      },
    },
  },
  run({ node_ids }, ctx) {
    const stats = getMemoryStats(ctx.workspaceId, ctx.canvasKey);
    const filtered = node_ids?.length
      ? stats.filter(s => node_ids.includes(s.id))
      : stats;
    const now = Date.now();
    return {
      stats: filtered.map(s => ({
        ...s,
        days_since_view: s.viewed_at ? Math.floor((now - s.viewed_at) / 86400000) : null,
        days_since_edit: s.edited_at ? Math.floor((now - s.edited_at) / 86400000) : null,
      })),
    };
  },
};

const find_orphans = {
  name: 'find_orphans',
  description: 'Find nodes in the current canvas with NO edges and NO parent — disconnected ideas the user hasn\'t integrated.',
  permission: 'read',
  input_schema: { type: 'object', properties: {} },
  run(_input, ctx) {
    const { nodeMap, edges } = loadCanvasNodes(ctx);
    const referenced = new Set([
      ...(edges || []).map(e => e.from),
      ...(edges || []).map(e => e.to),
    ]);
    const orphans = Object.values(nodeMap).filter(n =>
      !referenced.has(n.id) && !n.parentId
    );
    return {
      orphans: orphans.map(n => ({
        id: n.id, title: n.title, summary: summarize(n.body),
      })),
      total: orphans.length,
    };
  },
};

// ─── Tier 1.5 — Algorithmic discovery tools ──────────────────────────────────

const find_dormant_threads = {
  name: 'find_dormant_threads',
  description: 'Find subtrees that haven\'t been edited recently but contain unresolved conflicts or dangling wikilinks — half-explored threads worth revisiting.',
  permission: 'discover',
  input_schema: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: 'min days since last edit (default 14)' },
    },
  },
  run({ days = 14 }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const stats = getMemoryStats(ctx.workspaceId, ctx.canvasKey);
    const statsMap = new Map(stats.map(s => [s.id, s]));
    const now = Date.now();
    const threshold = days * 86400000;

    const dormant = [];
    for (const n of Object.values(nodeMap)) {
      const s = statsMap.get(n.id);
      const editedAt = s?.edited_at || 0;
      const stale = editedAt > 0 && (now - editedAt) > threshold;
      if (!stale) continue;

      // Has unresolved conflict OR dangling wikilink?
      const hasConflict = n.conflict?.status === 'unresolved';
      const wikilinks = (n.body || '').match(/\[\[([^\]]+)\]\]/g) || [];
      const nodeTitleSet = new Set(
        Object.values(nodeMap).map(x => x.title.toLowerCase())
      );
      const hasDangling = wikilinks.some(w => {
        const target = w.slice(2, -2).toLowerCase();
        return !nodeTitleSet.has(target);
      });
      if (!hasConflict && !hasDangling) continue;

      dormant.push({
        id: n.id,
        title: n.title,
        days_since_edit: Math.floor((now - editedAt) / 86400000),
        has_conflict: hasConflict,
        dangling_wikilinks: hasDangling
          ? wikilinks.map(w => w.slice(2, -2))
              .filter(w => !nodeTitleSet.has(w.toLowerCase()))
          : [],
      });
    }
    return { dormant, total: dormant.length };
  },
};

const find_unexplored_neighbors = {
  name: 'find_unexplored_neighbors',
  description: '2-hop neighbors of a node that the user hasn\'t viewed (low viewed_count) — material in their own graph they\'ve never come back to. Excellent for proactive discovery.',
  permission: 'discover',
  input_schema: {
    type: 'object',
    properties: {
      node_id: { type: 'string' },
      max_views: { type: 'integer', description: 'neighbors with viewed_count <= this are considered unexplored (default 1)' },
    },
    required: ['node_id'],
  },
  run({ node_id, max_views = 1 }, ctx) {
    const { nodeMap, edges } = loadCanvasNodes(ctx);
    if (!nodeMap[node_id]) return { error: `node ${node_id} not found` };
    const stats = getMemoryStats(ctx.workspaceId, ctx.canvasKey);
    const statsMap = new Map(stats.map(s => [s.id, s]));
    const seen = new Set([node_id]);
    const collect = (id) => {
      const out = [];
      for (const e of edges || []) {
        let other = null;
        if (e.from === id) other = e.to;
        else if (e.to === id) other = e.from;
        if (other && !seen.has(other)) { seen.add(other); out.push(other); }
      }
      return out;
    };
    const l1 = collect(node_id);
    const l2 = l1.flatMap(collect);
    const candidates = [...l1, ...l2];

    const unexplored = candidates
      .map(id => ({
        id, title: nodeMap[id]?.title || '(missing)',
        viewed_count: statsMap.get(id)?.viewed_count || 0,
        hop: l1.includes(id) ? 1 : 2,
      }))
      .filter(c => c.viewed_count <= max_views)
      .sort((a, b) => a.viewed_count - b.viewed_count);

    return { unexplored, total: unexplored.length };
  },
};

// ─── Tier 1.5 (LLM-powered) — Latent-structure discovery ─────────────────────
//
// Each tool makes a NARROW sub-LLM call with a focused prompt. The agent
// orchestrates them; the sub-LLM does the creative inference. Cost: ~500
// tokens per call. Use sparingly — agent's system prompt enforces throttle.

const suggest_bridges = {
  name: 'suggest_bridges',
  description: 'For a given node, use a sub-LLM to find OTHER nodes in the current canvas that have semantic overlap but no graph edge. Surfaces non-obvious cross-subtree connections.',
  permission: 'discover',
  input_schema: {
    type: 'object',
    properties: {
      node_id: { type: 'string' },
      count: { type: 'integer', description: 'max bridges to return (default 3)' },
    },
    required: ['node_id'],
  },
  async run({ node_id, count = 3 }, ctx) {
    const { nodeMap, edges } = loadCanvasNodes(ctx);
    const center = nodeMap[node_id];
    if (!center) return { error: `node ${node_id} not found` };

    // Build candidate set: nodes that aren't already connected to center
    const linkedSet = new Set();
    for (const e of edges || []) {
      if (e.from === node_id) linkedSet.add(e.to);
      if (e.to === node_id) linkedSet.add(e.from);
    }
    const candidates = Object.values(nodeMap).filter(n =>
      n.id !== node_id && !linkedSet.has(n.id)
    );
    if (candidates.length === 0) return { bridges: [], reason: 'no unlinked nodes' };

    const candidateList = candidates
      .map(n => `- id="${n.id}" title="${n.title}": ${summarize(n.body, 140)}`)
      .join('\n');

    const result = await callSubLLMJSON({
      system: 'You find non-obvious semantic connections between knowledge nodes. Be conservative — only suggest bridges with real conceptual overlap.',
      prompt: `Central node:
id="${center.id}" title="${center.title}"
body: ${center.body || '(empty)'}

Other nodes in canvas (not currently linked to central):
${candidateList}

Identify up to ${count} candidates that have STRONG semantic overlap with the central node but no current edge. For each, propose a specific edge label (depends_on / enables / contradicts / is_a / evolved_to / similar_to). Skip if no good candidates.

Return ONLY JSON:
{"bridges":[{"target_id":"...","label":"specific verb","reason":"1 sentence why these connect"}]}`,
      parentSignal: ctx.signal,
      maxTokens: 600,
    });

    if (!result.ok) return { error: result.error, bridges: [] };
    const bridges = (result.data.bridges || []).filter(b =>
      nodeMap[b.target_id] && b.target_id !== node_id
    ).slice(0, count);
    return { bridges, central: { id: center.id, title: center.title } };
  },
};

const expand_concept = {
  name: 'expand_concept',
  description: 'For a given node, use a sub-LLM to propose natural NEXT-STEP concepts that would extend the user\'s thinking. Returns new concepts that don\'t yet exist as nodes.',
  permission: 'discover',
  input_schema: {
    type: 'object',
    properties: {
      node_id: { type: 'string' },
      count: { type: 'integer', description: 'max next-step concepts (default 3)' },
    },
    required: ['node_id'],
  },
  async run({ node_id, count = 3 }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const center = nodeMap[node_id];
    if (!center) return { error: `node ${node_id} not found` };
    const existingTitles = new Set(Object.values(nodeMap).map(n => n.title.toLowerCase()));

    const result = await callSubLLMJSON({
      system: 'You suggest natural next-step concepts that extend a knowledge node. Stay close to the source material — no tangents.',
      prompt: `Source node:
title="${center.title}"
body: ${center.body || '(empty)'}

Existing nodes in canvas (DO NOT propose any of these): ${[...existingTitles].slice(0, 50).join(', ')}

Propose up to ${count} natural next-step concepts the user is likely to want to capture next. For each:
- short title (3-8 words)
- 1-2 sentence reason
- proposed body sketch (1-2 sentences)

Return ONLY JSON:
{"concepts":[{"title":"...","body_sketch":"...","reason":"..."}]}`,
      parentSignal: ctx.signal,
      maxTokens: 700,
    });

    if (!result.ok) return { error: result.error, concepts: [] };
    const concepts = (result.data.concepts || []).filter(c =>
      c.title && !existingTitles.has(c.title.toLowerCase())
    ).slice(0, count);
    return { concepts, source: { id: center.id, title: center.title } };
  },
};

const infer_implicit_concepts = {
  name: 'infer_implicit_concepts',
  description: 'For a given node, use a sub-LLM to extract concepts MENTIONED in the body but not present as their own nodes. Surfaces hidden node candidates.',
  permission: 'discover',
  input_schema: {
    type: 'object',
    properties: { node_id: { type: 'string' } },
    required: ['node_id'],
  },
  async run({ node_id }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const n = nodeMap[node_id];
    if (!n) return { error: `node ${node_id} not found` };
    const existingTitles = new Set(Object.values(nodeMap).map(x => x.title.toLowerCase()));

    const result = await callSubLLMJSON({
      system: 'You extract noteworthy concepts mentioned in text but not yet first-class nodes.',
      prompt: `Node body:
title="${n.title}"
body: ${n.body || ''}

Existing nodes (DO NOT re-list these): ${[...existingTitles].slice(0, 50).join(', ')}

List concepts that are mentioned/implied in the body but aren't on the canvas as their own nodes. Skip trivial mentions — only flag concepts substantive enough to warrant their own node.

Return ONLY JSON:
{"implicit":[{"concept":"name","mentioned_as":"the phrase from the body that mentions it"}]}`,
      parentSignal: ctx.signal,
      maxTokens: 500,
    });

    if (!result.ok) return { error: result.error, implicit: [] };
    const implicit = (result.data.implicit || []).filter(x =>
      x.concept && !existingTitles.has(x.concept.toLowerCase())
    );
    return { implicit, source: { id: n.id, title: n.title } };
  },
};

const find_conceptual_gaps = {
  name: 'find_conceptual_gaps',
  description: 'For a parent node with existing children, use a sub-LLM to judge what sibling concepts are conventionally expected but missing.',
  permission: 'discover',
  input_schema: {
    type: 'object',
    properties: { parent_id: { type: 'string' } },
    required: ['parent_id'],
  },
  async run({ parent_id }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const parent = nodeMap[parent_id];
    if (!parent) return { error: `node ${parent_id} not found` };
    const children = Object.values(nodeMap).filter(n => n.parentId === parent_id);

    const result = await callSubLLMJSON({
      system: 'You identify conventional sibling concepts that are missing from a topic hierarchy.',
      prompt: `Parent topic: "${parent.title}"
Parent body: ${parent.body || '(empty)'}

Existing children: ${children.map(c => `"${c.title}"`).join(', ') || '(none)'}

What sibling concepts are conventionally expected under this parent but missing? Be conservative — only flag widely-known canonical concepts, not exotic edge cases.

Return ONLY JSON:
{"gaps":[{"concept":"name","reason":"why this is a canonical sibling"}]}`,
      parentSignal: ctx.signal,
      maxTokens: 500,
    });

    if (!result.ok) return { error: result.error, gaps: [] };
    return { gaps: result.data.gaps || [], parent: { id: parent_id, title: parent.title } };
  },
};

const infer_node_overlap = {
  name: 'infer_node_overlap',
  description: 'Compare TWO nodes by semantic overlap. Returns overlap percentage + analysis. Use to rank merge candidates.',
  permission: 'discover',
  input_schema: {
    type: 'object',
    properties: {
      id_a: { type: 'string' },
      id_b: { type: 'string' },
    },
    required: ['id_a', 'id_b'],
  },
  async run({ id_a, id_b }, ctx) {
    const { nodeMap } = loadCanvasNodes(ctx);
    const a = nodeMap[id_a]; const b = nodeMap[id_b];
    if (!a || !b) return { error: `node ${a ? id_b : id_a} not found` };

    const result = await callSubLLMJSON({
      system: 'You quantify semantic overlap between two knowledge nodes. Be precise; "overlap" means literally the same idea, not just related.',
      prompt: `Node A: "${a.title}"
${a.body || ''}

Node B: "${b.title}"
${b.body || ''}

Quantify the overlap. Return:
- overlap_pct: 0-100 (100 = identical idea, 0 = unrelated)
- relation: one of "duplicate" / "subset" / "overlap" / "related" / "unrelated" / "contradictory"
- analysis: 1-2 sentences

Return ONLY JSON:
{"overlap_pct":N,"relation":"...","analysis":"..."}`,
      parentSignal: ctx.signal,
      maxTokens: 400,
    });

    if (!result.ok) return { error: result.error };
    return { ...result.data, a: { id: id_a, title: a.title }, b: { id: id_b, title: b.title } };
  },
};

// ─── Tier 3 — Control / meta tools ───────────────────────────────────────────

const confirm_with_user = {
  name: 'confirm_with_user',
  description: 'Ask the user a clarifying question with predefined options. BLOCKS the agent until the user clicks. Use when intent is ambiguous and guessing would waste effort.',
  permission: 'control',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'short, specific question (1 sentence)' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '2-4 options the user can pick from',
      },
    },
    required: ['question', 'options'],
  },
  // run is special-cased in the agent loop — see loop.js handling.
  // This stub is here so the schema reaches the LLM.
  async run() {
    return { error: 'confirm_with_user must be handled by the agent loop, not invoked directly' };
  },
};

const hand_off_to_mode = {
  name: 'hand_off_to_mode',
  description: 'Suggest the user enter a scripted mode (/warmup, /quiz, /rehearse, /audit). Returns a structured result the frontend renders as a clickable button. Does NOT auto-switch.',
  permission: 'control',
  input_schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['warmup', 'quiz', 'rehearse', 'audit'] },
      scope: { type: 'string', description: 'optional scope hint (e.g. "redis", node title)' },
      reason: { type: 'string', description: 'one sentence: why this mode is appropriate now' },
    },
    required: ['mode', 'reason'],
  },
  async run(input) {
    return {
      hand_off: true,
      mode: input.mode,
      scope: input.scope || '',
      reason: input.reason,
      message: `Suggested handing off to /${input.mode}${input.scope ? ` ${input.scope}` : ''}`,
    };
  },
};

// ─── Tier 2 — Propose tools (write to node_suggestions; user accepts) ────────
//
// Every propose tool:
//   1. Validates input minimally
//   2. Writes ONE row to node_suggestions with type + payload
//   3. Returns { suggestion_id, status: 'proposed', message }
//
// Agent never directly mutates graph state — that's enforced by the absence of
// any mutation tool. propose_* is the only write surface. User accepts via
// SuggestionCard UI which triggers frontend applySuggestion().

const propose_create_node = {
  name: 'propose_create_node',
  description: 'Propose creating a NEW node in the current canvas. User will see a card and accept/dismiss. Use this when discovery finds a missing concept the user should capture.',
  permission: 'propose',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'short node title (3-8 words)' },
      body:  { type: 'string', description: 'markdown body, 1-3 paragraphs' },
      parent_id: { type: 'string', description: 'optional existing node id to set as parentId for hierarchy' },
      links_to:  { type: 'array', items: { type: 'string' }, description: 'optional list of existing node ids the new node should link TO' },
      reason: { type: 'string', description: 'one sentence: why this node should exist' },
    },
    required: ['title', 'body', 'reason'],
  },
  run(input, ctx) {
    const sug = createSuggestion(ctx.workspaceId, ctx.canvasKey, 'create', input);
    return { suggestion: sug, message: `Proposed creating "${input.title}" — user will see a card to accept/dismiss.` };
  },
};

const propose_update_node = {
  name: 'propose_update_node',
  description: 'Propose editing an existing node — fields can be title, body, confidence, tag. Use sparingly; small targeted patches only.',
  permission: 'propose',
  input_schema: {
    type: 'object',
    properties: {
      node_id: { type: 'string' },
      patch: {
        type: 'object',
        properties: {
          title:      { type: 'string' },
          body:       { type: 'string' },
          confidence: { type: 'string', enum: ['solid', 'fuzzy', 'question'] },
          tag:        { type: 'string' },
        },
      },
      reason: { type: 'string', description: 'one sentence: why this edit' },
    },
    required: ['node_id', 'patch', 'reason'],
  },
  run(input, ctx) {
    const sug = createSuggestion(ctx.workspaceId, ctx.canvasKey, 'update', input);
    return { suggestion: sug, message: `Proposed update to ${input.node_id} — user will see a card.` };
  },
};

const propose_delete_node = {
  name: 'propose_delete_node',
  description: 'Propose deleting a node (and its incident edges). Use VERY sparingly — usually merge is better than delete.',
  permission: 'propose',
  input_schema: {
    type: 'object',
    properties: {
      node_id: { type: 'string' },
      reason:  { type: 'string', description: 'why deletion (not merge) is appropriate' },
    },
    required: ['node_id', 'reason'],
  },
  run(input, ctx) {
    const sug = createSuggestion(ctx.workspaceId, ctx.canvasKey, 'delete', input);
    return { suggestion: sug, message: `Proposed deleting ${input.node_id} — user will see a card.` };
  },
};

const propose_link_nodes = {
  name: 'propose_link_nodes',
  description: 'Propose adding an edge between two existing nodes. Use SPECIFIC labels (depends_on, enables, contradicts, is_a, evolved_to) — avoid generic "relates to".',
  permission: 'propose',
  input_schema: {
    type: 'object',
    properties: {
      from:  { type: 'string', description: 'source node id' },
      to:    { type: 'string', description: 'target node id' },
      label: { type: 'string', description: 'specific verb' },
      dash:  { type: 'boolean', description: 'dashed line (weak/conjectural connection)' },
      reason: { type: 'string', description: 'one sentence: why these should connect' },
    },
    required: ['from', 'to', 'label', 'reason'],
  },
  run(input, ctx) {
    const sug = createSuggestion(ctx.workspaceId, ctx.canvasKey, 'edge', input);
    return { suggestion: sug, message: `Proposed edge ${input.from} —[${input.label}]→ ${input.to} — user will see a card.` };
  },
};

const propose_unlink = {
  name: 'propose_unlink',
  description: 'Propose removing an edge between two nodes.',
  permission: 'propose',
  input_schema: {
    type: 'object',
    properties: {
      edge_id: { type: 'string' },
      reason:  { type: 'string' },
    },
    required: ['edge_id', 'reason'],
  },
  run(input, ctx) {
    const sug = createSuggestion(ctx.workspaceId, ctx.canvasKey, 'unlink', input);
    return { suggestion: sug, message: `Proposed unlinking edge ${input.edge_id} — user will see a card.` };
  },
};

const propose_merge_nodes = {
  name: 'propose_merge_nodes',
  description: 'Propose merging 2+ duplicate nodes into one. Provide merged_title + merged_body. Edges are auto-rerouted on apply.',
  permission: 'propose',
  input_schema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'node ids to merge (first one is kept, rest merged into it)' },
      merged_title: { type: 'string' },
      merged_body:  { type: 'string' },
      reason: { type: 'string', description: 'why these are the same idea' },
    },
    required: ['ids', 'merged_title', 'merged_body', 'reason'],
  },
  run(input, ctx) {
    const sug = createSuggestion(ctx.workspaceId, ctx.canvasKey, 'merge', input);
    return { suggestion: sug, message: `Proposed merging ${input.ids.length} nodes into "${input.merged_title}" — user will see a card.` };
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

export const TOOLS = {
  // Tier 1 — read
  search_nodes,
  read_node,
  list_nodes,
  traverse,
  list_topics,
  get_user_focus,
  get_memory_stats,
  find_orphans,
  // Tier 1.5a — algorithmic discovery
  find_dormant_threads,
  find_unexplored_neighbors,
  // Tier 1.5b — LLM-powered discovery (sub-LLM calls, more expensive)
  suggest_bridges,
  expand_concept,
  infer_implicit_concepts,
  find_conceptual_gaps,
  infer_node_overlap,
  // Tier 2 — propose (mutations go through suggestions table)
  propose_create_node,
  propose_update_node,
  propose_delete_node,
  propose_link_nodes,
  propose_unlink,
  propose_merge_nodes,
  // Tier 3 — control (meta-flow, special-cased by loop)
  confirm_with_user,
  hand_off_to_mode,
};

export const TOOL_SCHEMAS = Object.values(TOOLS).map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

export function isReadOnly(name) {
  const t = TOOLS[name];
  return t && (t.permission === 'read' || t.permission === 'discover');
}

export function isPropose(name) {
  const t = TOOLS[name];
  return t && t.permission === 'propose';
}

export function isControl(name) {
  const t = TOOLS[name];
  return t && t.permission === 'control';
}

export async function executeTool(name, input, ctx) {
  const t = TOOLS[name];
  if (!t) throw new Error(`unknown tool: ${name}`);
  return await t.run(input || {}, ctx);
}
