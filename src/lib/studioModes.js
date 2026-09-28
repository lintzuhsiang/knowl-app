import { TASK_MODES } from "./constants";

export const STUDIO_MODES = {
  tutor:    { label: "Tutor",   icon: "?", description: "Socratic Q&A" },
  warmup:   { label: "Warm Up", icon: "~", description: "Review knowledge", subModes: TASK_MODES },
  gaps:     { label: "Gaps",    icon: "o", description: "Find missing concepts", oneShot: true },
  generate: { label: "Generate", icon: "+", description: "Paragraph to nodes", expandInput: true },
};

/**
 * Lightweight intent detection for StudioPanel's free-text input.
 *
 * Note: ChatPanel users should prefer slash commands (`/tutor`, `/warmup`,
 * `/quiz`) which are unambiguous and multilingual-safe. This regex stays
 * around for StudioPanel's keyword path, and gracefully matches both
 * English and Traditional Chinese cues.
 */
export function detectIntent(text) {
  const l = text.toLowerCase().trim();

  // generate — break a paragraph into nodes
  if (/(?:^|\s)(?:generate|create|make|build|break)\b.*(?:cards?|nodes?|graph|map|this)/i.test(l)
      || /(?:幫我整理|把這段|轉成圖|分解|拆解|生成).*(?:節點|圖|知識圖|筆記|卡片)/i.test(l)) {
    return "generate";
  }

  // tutor — socratic / quiz / interrogate me
  if (/(?:^|\s)(?:quiz|test|tutor|ask)\s+(?:me|questions?)/i.test(l)
      || /(?:考考|測驗|提問|問我|教教|蘇格拉底)/i.test(l)) {
    return "tutor";
  }

  // warmup — review / refresh
  if (/(?:^|\s)(?:warm\s*up|review|refresh|recap)\b/i.test(l)
      || /(?:複習|回顧|複看|溫習|熱機)/i.test(l)) {
    return "warmup";
  }

  // gaps — audit for missing/contradictory
  if (/(?:^|\s)(?:scan|find|check)\s+(?:for\s+)?(?:gaps?|missing|contradictions?)/i.test(l)
      || /(?:找出|偵測|檢查).*(?:漏洞|矛盾|缺口|遺漏)/i.test(l)) {
    return "gaps";
  }

  return "chat";
}

const TUTOR_RULES = `Decision tree (NEVER break):
- CORRECT: brief praise (1 sentence), then ask a HARDER follow-up that deepens understanding.
- PARTIALLY CORRECT: say "you're on the right track, but..." and ask them to refine the missing piece.
- WRONG: do NOT say "wrong." Instead say "interesting — what if [counter-example]?" Then re-pose.
- "I don't know": give the SMALLEST possible hint (one word or analogy), then re-ask.

You must reference a SPECIFIC node title from the map in your question. Vary question style:
sometimes ask for an analogy, sometimes "what happens if X fails?", sometimes "explain to a 5-year-old".`;

export function buildTutorStart(topicLabel, nodes) {
  const list = Object.values(nodes);
  const fmt = (arr) => arr.map(n =>
    `id:"${n.id}" title:"${n.title}"\n${(n.body || "").replace(/^#+ /gm, "").slice(0, 300)}`
  ).join("\n---\n");

  // Partition by confidence + graph isolation
  const strong  = list.filter(n => n.confidence === "solid");
  const weak    = list.filter(n => n.confidence === "fuzzy" || n.confidence === "question");
  // True orphan: not parent/child and not endpoint of any edge — caller passes via nodes only
  // (Cheap heuristic; full orphan detection needs edges. Good enough for now.)
  const isolated = list.filter(n => !n.parentId && !n.confidence);

  return `You are a Socratic tutor. Your job is NOT to explain — it is to ask ONE question that forces the student to discover the answer themselves.

Rules you must NEVER break:
1. Never give the answer directly, even if the student is wrong.
2. If wrong, acknowledge their reasoning then ask a follow-up that steers them.
3. Prioritize WEAK or ORPHAN nodes — these are the student's blind spots.
4. Reference a SPECIFIC node title.
5. Vary your question style (analogy / failure case / explain-to-a-child).

Topic: "${topicLabel}"

STRONG nodes (student knows well):
${fmt(strong) || "(none yet)"}

WEAK nodes (fuzzy or question confidence — prioritize):
${fmt(weak) || "(none — pick the most foundational concept)"}

UNINTEGRATED nodes (no parent, no confidence set — possible blind spots):
${fmt(isolated) || "(none)"}

Ask ONE Socratic question targeting a weak or unintegrated node.

Return ONLY valid JSON (no markdown):
{"message":"your question","highlight":["nodeId"],"ghostNode":null}`;
}

/**
 * System prompt for tutor follow-up turns.
 * Conversation history is passed separately via the messages array — this
 * builder is just the system prompt. It now embeds node BODIES (not just IDs)
 * so the AI can judge correctness, plus the decision tree.
 */
export function buildTutorFollowUp(topicLabel, nodes) {
  const ctx = Object.values(nodes).map(n =>
    `id:"${n.id}" title:"${n.title}"\n${(n.body || "").replace(/^#+ /gm, "").slice(0, 220)}`
  ).join("\n---\n");

  return `You are a Socratic tutor for "${topicLabel}".

${TUTOR_RULES}

Available nodes (use these to judge the student's last answer and pose the next question):
${ctx}

If the student mentions a concept not on the map, include it as a ghostNode in your response.

Return ONLY valid JSON:
{"message":"your response + next question","highlight":["nodeId"],"ghostNode":null}`;
}

export function buildWarmUpPrompt(topicLabel, nodes, taskMode, query) {
  const mode = TASK_MODES[taskMode];
  const ctx = Object.values(nodes).map(n => {
    const ec = n.entryContext;
    return "id:\"" + n.id + "\" title:\"" + n.title + "\"\n" + n.body.replace(/^#+ /gm, "").slice(0, 250) +
      (ec ? "\n[Why: " + (ec.trigger || "") + "] [Decision: " + (ec.decision || "") + "]" : "");
  }).join("\n---\n");
  const fuzzy = Object.values(nodes).filter(n => n.confidence === "fuzzy" || n.confidence === "question").map(n => n.title);
  const sys = "You are helping warm up on knowledge map for \"" + topicLabel + "\". " + mode.sys;
  const prompt = "Task mode: " + mode.label + "\nUser query: \"" + query + "\"\n\nKnowledge map:\n" + ctx +
    (fuzzy.length ? "\n\nMarked uncertain: " + fuzzy.join(", ") : "") +
    "\n\nReturn ONLY valid JSON:\n{\"summary\":\"2-3 paragraph conversational response\",\"nodeSequence\":[\"id1\",\"id2\"],\"openQuestion\":\"follow-up question or null\",\"entryPoint\":\"where to start, one sentence\"}";
  return { prompt, sys };
}

/**
 * Generate-from-text prompt. Now accepts `edges` so the AI knows the
 * existing graph topology and can attach new nodes properly (parentTempId)
 * or create edges to existing nodes instead of duplicating.
 */
export function buildGeneratePrompt(text, nodes, edges = []) {
  const existingNodes = Object.values(nodes)
    .map(n => `- "${n.id}": ${n.title}`)
    .join("\n");
  const existingEdges = (edges || [])
    .slice(0, 20)
    .map(e => `- "${e.from}" --[${e.label || "relates to"}]--> "${e.to}"`)
    .join("\n");

  return `You are a knowledge graph architect. Extract concepts from text and weave them into the EXISTING knowledge map.

Rules:
1. Generate 2-6 nodes maximum. No more.
2. REUSE existing nodes when possible — set parentTempId to an existing node's id (not a tempId) to attach into the hierarchy.
3. If a concept already exists in the map, do NOT duplicate it — instead create an edge FROM the new node TO the existing one.
4. Edge labels must be specific. Prefer "enables", "contradicts", "is a type of", "depends on", "evolved to" over generic "relates to".
5. Each node body: self-contained markdown summary, 50-150 words.

Existing nodes:
${existingNodes || "(empty)"}

Existing edges:
${existingEdges || "(none)"}

New text to integrate:
"""
${text.slice(0, 3000)}
"""

Return ONLY valid JSON:
{"nodes":[{"tempId":"n1","title":"...","body":"markdown content","nodeType":"text","confidence":null,"parentTempId":"existing-node-id-or-null"}],"edges":[{"from":"n1","to":"n2","label":"specific verb","dash":false}]}`;
}

export function parseTutorResponse(text) {
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch (e) { return { message: text, highlight: [], ghostNode: null }; }
}
