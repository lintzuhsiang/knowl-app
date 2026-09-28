/**
 * Audit (Feature 2) — one-shot canvas analysis.
 *
 * Scans the current canvas's nodes/edges and asks the LLM to identify:
 *   • MERGE candidates — near-duplicate nodes
 *   • CONFLICTS — contradictory pairs
 *   • MISSING_EDGES — pairs that should be connected
 *
 * Results are written as rows in node_suggestions (status='pending'). The
 * UI renders pending suggestions inline and lets the user accept/dismiss.
 * Acceptance does NOT auto-apply graph changes in v1 — it just resolves
 * the suggestion. The user makes the actual edit manually after seeing it.
 */

import { formatContextPack } from "../graphHelpers";

const AUDIT_RULES = `You are auditing a personal knowledge graph for these specific issues:

1. MERGE — two nodes that represent the SAME idea phrased differently. Only flag if truly redundant, not if merely thematically adjacent.
2. CONFLICT — two nodes that contradict each other or have unresolved tension. Only flag if there's an actual logical disagreement.
3. MISSING_EDGE — two nodes that have a clear structural relationship but no edge connecting them. Only flag specific verbs (depends_on, enables, contradicts, is_a, evolved_to), not vague "relates to".

Be CONSERVATIVE. It is better to flag nothing than to flag noise. A user who sees garbage suggestions stops trusting the system.`;

export function buildAuditPrompt(contextPack) {
  if (!contextPack || contextPack.nodeCount < 2) return null;
  const ctx = formatContextPack(contextPack, { bodyTruncate: 220 });
  return `${AUDIT_RULES}

${ctx}

Return ONLY valid JSON (no markdown fences):
{
  "merges": [
    {"ids": ["nodeId1", "nodeId2"], "merged_title": "...", "merged_body": "1-2 paragraphs combining both", "reason": "1 sentence why these are the same idea"}
  ],
  "conflicts": [
    {"id_a": "nodeId1", "id_b": "nodeId2", "tension": "1 sentence describing the contradiction"}
  ],
  "missing_edges": [
    {"from": "nodeId1", "to": "nodeId2", "label": "specific verb", "reason": "1 sentence why"}
  ]
}

If the graph looks clean, return {"merges":[],"conflicts":[],"missing_edges":[]}.`;
}

export function parseAuditResponse(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      merges: Array.isArray(parsed.merges) ? parsed.merges : [],
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
      missing_edges: Array.isArray(parsed.missing_edges) ? parsed.missing_edges : [],
    };
  } catch {
    return null;
  }
}

/**
 * Map parsed audit result → suggestion DB records (type + payload).
 * Filters out malformed entries that lack required node IDs.
 */
export function auditToSuggestions(parsed, knownNodeIds) {
  if (!parsed) return [];
  const valid = knownNodeIds instanceof Set ? knownNodeIds : new Set(knownNodeIds || []);
  const hasAll = (...ids) => ids.every(id => valid.has(id));
  const records = [];

  for (const m of parsed.merges || []) {
    if (Array.isArray(m.ids) && m.ids.length >= 2 && hasAll(...m.ids)) {
      records.push({ type: "merge", payload: m });
    }
  }
  for (const c of parsed.conflicts || []) {
    if (c.id_a && c.id_b && hasAll(c.id_a, c.id_b) && c.id_a !== c.id_b) {
      records.push({ type: "conflict", payload: c });
    }
  }
  for (const e of parsed.missing_edges || []) {
    if (e.from && e.to && hasAll(e.from, e.to) && e.from !== e.to) {
      records.push({ type: "edge", payload: e });
    }
  }
  return records;
}
