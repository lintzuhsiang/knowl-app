/**
 * Warmup mode — light conversational recall.
 *
 * AI plays a guide who has perfect memory of the user's notes. It picks
 * stale-but-recently-touched material, asks one question at a time, and
 * fills in hints when the user blanks. NO scoring, NO role-play.
 *
 * Selection signals (weighted):
 *   • Recently edited + low view count    (fresh, not yet revisited)
 *   • Old viewed_at + high viewed_count   (stale, used to know)
 *   • confidence ∈ {fuzzy, question}      (self-flagged shaky)
 *   • recall_score < 0.5                  (failed Quiz recently)
 *   • unresolved conflict                 (latent tension worth addressing)
 *   • scope hint match (title/body)       (user nudged a topic)
 */

import { formatContextPack } from "../graphHelpers";

const WARMUP_RULES = `You are a recall guide helping the user re-enter their own notes after time away.

Behavioral rules (NEVER break):
1. Open with ONE specific node from the current view — name it by title. Never start with a generic "want to start?".
2. Ask ONE question at a time. Wait for the user before continuing.
3. If the user is vague or blanks, fill in 1 detail from the node body to jog their memory, then re-ask gently.
4. If the user recalls correctly, briefly confirm and pivot to a CONNECTED node (follow the graph edges in the context).
5. Never lecture. Never dump info. Keep replies under 3 sentences.
6. After 4-6 exchanges, offer to wrap up — e.g. "Want me to surface anything you struggled with?" or "Done warming up?"

You are NOT a tutor (no scoring, no judgment). You are NOT an interviewer (no role-play).
You are a friend with a perfect memory of these notes, helping the user remember theirs.`;

/**
 * Pick warmup material. Returns ordered list of node summaries with score.
 * `scopeHint` is the raw args from `/warmup <hint>` (free text).
 */
export function pickWarmupNodes(contextPack, memoryStats, scopeHint = "", limit = 5) {
  if (!contextPack) return [];
  const stats = new Map((memoryStats || []).map(s => [s.id, s]));
  const now = Date.now();
  const DAY = 86400000;

  const score = (n) => {
    const s = stats.get(n.id) || {};
    const viewed = s.viewed_at || 0;
    const edited = s.edited_at || 0;
    const count  = s.viewed_count || 0;
    const recall = s.recall_score; // 0..1 or null

    const daysSinceView = viewed > 0 ? (now - viewed) / DAY : 999;
    const daysSinceEdit = edited > 0 ? (now - edited) / DAY : 999;

    let pts = 0;
    // Fresh — recently edited, not yet revisited
    if (daysSinceEdit < 7 && count < 3) pts += 3;
    // Stale — used to know, not seen in a while
    if (daysSinceView > 7 && count > 0) pts += 2;
    // User flagged shaky
    if (n.confidence === "fuzzy" || n.confidence === "question") pts += 2;
    // Failed recent quiz
    if (recall != null && recall < 0.5) pts += 2;
    // Unresolved conflict
    if (n.conflict?.status === "unresolved") pts += 1;
    // Scope hint match
    if (scopeHint) {
      const h = scopeHint.toLowerCase();
      if (n.title.toLowerCase().includes(h)) pts += 6;
      else if ((n.body || "").toLowerCase().includes(h)) pts += 3;
    }
    return pts;
  };

  return contextPack.nodes
    .map(n => ({ id: n.id, title: n.title, score: score(n) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Build the system prompt for warmup mode. */
export function buildWarmupSystemPrompt(contextPack, memoryStats, picks, scopeHint = "") {
  const pickList = picks.length
    ? picks.map((p, i) => `${i + 1}. "${p.title}" (id: ${p.id}, signal: ${p.score})`).join("\n")
    : "(no strong signals — start with the most foundational node in the view)";

  const contextStr = formatContextPack(contextPack);

  return `${WARMUP_RULES}

${contextStr}

SUGGESTED MATERIAL TO REVISIT (ordered by relevance signal):
${pickList}${scopeHint ? `\n\nUser nudged the scope toward: "${scopeHint}"` : ""}

Begin by opening on the HIGHEST-scored node. Reference it by title in your first sentence.`;
}

/**
 * Kickoff payload for entering /warmup. The synthetic user turn is NOT
 * persisted (ChatPanel passes persist.userMessage = undefined for kickoff).
 */
export const KICKOFF_USER_MESSAGE = "Begin the warmup session now.";
