/**
 * Quiz mode — closed-book test with decision-tree judgment.
 *
 * Flow (per turn):
 *   1. AI asks a question about picks[currentIdx]
 *   2. User answers
 *   3. AI streams: feedback + next Q + structured tags at end of response
 *      tags: [JUDGE:CORRECT|PARTIAL|WRONG|UNKNOWN|NONE] [STATE:CONTINUE|DONE]
 *   4. ChatPanel parses tags, strips them from display, updates recall_score
 *
 * recall_score uses EMA so a single wrong answer doesn't tank a node's score;
 * sustained struggle drags it down over multiple sessions.
 */

import { formatContextPack } from "../graphHelpers";

const QUIZ_RULES = `You are a strict but supportive examiner. Quiz the user closed-book on their own notes.

Behavioral rules (NEVER break):
1. Ask ONE clear factual or conceptual question about the node currently being tested.
2. Judge the previous answer against the node's body (not the title). Be honest but kind.
3. After judging, immediately ask the NEXT question — do not lecture, do not explain in detail.
4. Decision tree for judgment:
   - CORRECT: brief praise (1 sentence), advance.
   - PARTIAL: "you're on the right track, but..." note what was missed in one sentence, advance.
   - WRONG: do NOT say "wrong." Use "interesting — what if [counter-example or reframe]?" Then move on.
   - UNKNOWN (user says "I don't know" / "no idea" / similar): give ONE-word hint or analogy, then advance.
5. Never reveal the full answer — only acknowledge the result. The user should not be able to fully reconstruct the node from your feedback.
6. Keep total reply under 4 sentences.

At the end of EVERY response, append these two tags on the LAST LINE (and nothing after):
[JUDGE:CORRECT|PARTIAL|WRONG|UNKNOWN|NONE] [STATE:CONTINUE|DONE]

Rules for tags:
- The very first message (no answer yet) uses [JUDGE:NONE] [STATE:CONTINUE].
- For all subsequent turns, JUDGE refers to the user's answer you JUST received.
- Use [STATE:DONE] AFTER you judge the final question. Include a 2-sentence session summary highlighting which areas were weakest.`;

/**
 * Pick quiz material. Prioritizes nodes with substantive body that have
 * low or null recall_score. Skips trivial nodes.
 */
export function pickQuizNodes(contextPack, memoryStats, scopeHint = "", limit = 5) {
  if (!contextPack) return [];
  const stats = new Map((memoryStats || []).map(s => [s.id, s]));

  // Quizzable: body strips headings → still has at least 50 chars
  const quizzable = contextPack.nodes.filter(n => {
    const stripped = (n.body || "").replace(/^#+\s*\S.*\n?/g, "").trim();
    return stripped.length >= 50;
  });

  const score = (n) => {
    const s = stats.get(n.id) || {};
    const recall = s.recall_score;
    let pts = 1;
    if (recall == null) pts += 3;           // never tested
    else if (recall < 0.3) pts += 4;
    else if (recall < 0.5) pts += 3;
    else if (recall < 0.7) pts += 1;
    if (n.confidence === "fuzzy") pts += 2;
    if (n.confidence === "question") pts += 3;
    if (n.conflict?.status === "unresolved") pts += 1;
    if (scopeHint) {
      const h = scopeHint.toLowerCase();
      if (n.title.toLowerCase().includes(h)) pts += 6;
      else if ((n.body || "").toLowerCase().includes(h)) pts += 3;
    }
    return pts;
  };

  return quizzable
    .map(n => ({
      id: n.id,
      title: n.title,
      body: n.body,
      confidence: n.confidence,
      score: score(n),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function buildQuizSystemPrompt(contextPack, picks, scopeHint = "") {
  const targets = picks
    .map((p, i) => `Q${i + 1}. node_id="${p.id}" title="${p.title}"\nbody:\n${p.body}\n---`)
    .join("\n\n");

  const contextStr = formatContextPack(contextPack, { bodyTruncate: 60 });

  return `${QUIZ_RULES}

${contextStr}

QUESTIONS TO ASK IN ORDER (test Q1 → Q${picks.length}):
${targets}

Total: ${picks.length} questions.${scopeHint ? ` User scope hint: "${scopeHint}".` : ""}
After judging Q${picks.length}, end with [STATE:DONE] and give a 2-sentence session summary highlighting weak areas (cite node titles).`;
}

/** Tag pattern: matches `[JUDGE:X] [STATE:Y]` anywhere, captures both. */
const TAG_RE = /\[JUDGE:(CORRECT|PARTIAL|WRONG|UNKNOWN|NONE)\]\s*\[STATE:(CONTINUE|DONE)\]/i;

/**
 * Parse tag from AI response.
 * Returns { judgement, done, displayText } — displayText has tags stripped.
 */
export function parseJudgement(text) {
  if (!text) return { judgement: null, done: false, displayText: "" };
  const m = text.match(TAG_RE);
  if (!m) return { judgement: null, done: false, displayText: text };
  return {
    judgement: m[1].toUpperCase(),
    done: m[2].toUpperCase() === "DONE",
    displayText: text.replace(TAG_RE, "").trimEnd(),
  };
}

/** Strip ALL tag patterns from a string (use at render time for safety). */
export function stripQuizTags(text) {
  if (!text) return text;
  return text.replace(/\[JUDGE:[A-Z]+\]\s*\[STATE:(CONTINUE|DONE)\]/gi, "").trimEnd();
}

export const SCORE_MAP = {
  CORRECT: 1.0,
  PARTIAL: 0.5,
  WRONG:   0.0,
  UNKNOWN: 0.0,
  NONE:    null,
};

export const EMA_ALPHA = 0.4; // weight given to latest score
export function emaUpdate(oldScore, latestScore) {
  if (latestScore == null) return oldScore;
  if (oldScore == null) return latestScore;
  return (1 - EMA_ALPHA) * oldScore + EMA_ALPHA * latestScore;
}

export const KICKOFF_USER_MESSAGE = "Start the quiz. Ask question 1.";

/** Build the session summary that gets shown when STATE:DONE fires. */
export function summarizeQuizSession(picks, judgements) {
  const counts = { CORRECT: 0, PARTIAL: 0, WRONG: 0, UNKNOWN: 0 };
  const weakNodes = [];
  judgements.forEach((j, i) => {
    if (j && counts[j] !== undefined) counts[j]++;
    if (j === "WRONG" || j === "UNKNOWN") weakNodes.push(picks[i]?.title);
  });
  const total = picks.length;
  const completed = judgements.filter(j => j != null).length;
  return {
    counts,
    weakNodes: weakNodes.filter(Boolean),
    completed,
    total,
    accuracy: completed ? ((counts.CORRECT + counts.PARTIAL * 0.5) / completed) : null,
  };
}
