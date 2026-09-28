/**
 * Rehearse mode — role-play conversation practice.
 *
 * AI plays a designated role (interviewer / examiner / colleague / skeptic /
 * custom) and pushes the user to verbalize. No scoring during the session;
 * at the end the AI gives qualitative presentation feedback (clarity, STAR
 * completeness for BQ, hand-waving on system design, etc.).
 *
 * Session ends via [STATE:DONE] tag after ~8-10 exchanges or when user
 * types /exit. The DONE message includes the presentation feedback inline.
 */

import { formatContextPack } from "../graphHelpers";

export const ROLES = {
  interviewer: {
    label: "Tech Interviewer",
    description: "Behavioral / general tech screen",
    prompt:
      "You are a senior tech interviewer running a behavioral / general tech screen. " +
      "You ask probing follow-ups, expect STAR-structured stories (Situation/Task/Action/Result), " +
      "and push on impact and quantification. You don't accept hand-wavy claims.",
  },
  examiner: {
    label: "System Design Examiner",
    description: "System design interview",
    prompt:
      "You are a senior system design interviewer. You ask the candidate to walk through " +
      "design decisions, then push on scaling, consistency, failure modes, and trade-offs. " +
      "You do not accept hand-wavy answers — drill into specifics.",
  },
  colleague: {
    label: "Curious Colleague",
    description: "Friendly peer asking detailed questions",
    prompt:
      "You are a curious senior colleague at the candidate's company. You ask in-depth " +
      "questions about their work in a collaborative way, but you push on technical choices " +
      "and want to understand the reasoning.",
  },
  skeptic: {
    label: "Skeptical Senior",
    description: "Hostile cross-examination — every claim challenged",
    prompt:
      "You are a skeptical senior reviewer. You challenge every claim, push back on assumptions, " +
      "and ask 'why not X?' constantly. You're not rude, but you're hard to please.",
  },
};

const REHEARSE_RULES = `Behavioral rules (NEVER break):
1. STAY IN CHARACTER. You are the role described above, not an AI assistant.
2. Ask ONE substantive question or follow-up at a time. Wait for the candidate.
3. After their answer, push deeper — do not give them a tutorial.
4. Use the knowledge graph as the candidate's prepared material — they should know this content.
5. After 8-10 exchanges, end the session by appending presentation feedback:
   - 2-3 sentences on what was STRONG (delivery, structure, examples)
   - 2-3 sentences on what was WEAK (filler, missing STAR pieces, hand-waving)
   - On the very last line write exactly: [STATE:DONE]
   In every prior turn end with [STATE:CONTINUE] on the last line.

Until you append [STATE:DONE], do NOT break character or give meta-feedback.`;

/**
 * Parse the args after `/rehearse`:
 *   "/rehearse interviewer"           → preset
 *   "/rehearse custom: hostile PM"    → custom prompt
 *   "/rehearse anything else here"    → freeform role description
 *   "/rehearse"                       → null (caller must error)
 */
export function parseRoleArgs(args) {
  const trimmed = (args || "").trim();
  if (!trimmed) return { roleKey: null, rolePrompt: null, label: null };

  const lower = trimmed.toLowerCase();
  for (const [key, meta] of Object.entries(ROLES)) {
    if (lower === key || lower.startsWith(key + " ")) {
      return { roleKey: key, rolePrompt: meta.prompt, label: meta.label };
    }
  }

  const customMatch = trimmed.match(/^custom:\s*(.+)/i);
  if (customMatch) {
    const desc = customMatch[1].trim();
    return { roleKey: "custom", rolePrompt: desc, label: `Custom: ${desc.slice(0, 32)}` };
  }

  return { roleKey: "freeform", rolePrompt: trimmed, label: trimmed.slice(0, 32) };
}

export function buildRehearseSystemPrompt(contextPack, roleArgs) {
  const role = roleArgs.rolePrompt || ROLES.interviewer.prompt;
  const ctx = contextPack ? formatContextPack(contextPack, { bodyTruncate: 200 }) : "(no prepared material)";
  return `${role}

${REHEARSE_RULES}

CANDIDATE'S PREPARED MATERIAL (their knowledge graph — they should know this):
${ctx}

Begin by introducing yourself in character (one short line) and asking the OPENING question. Stay in character throughout.
End your message with [STATE:CONTINUE].`;
}

const STATE_RE = /\[STATE:(CONTINUE|DONE)\]/i;

export function parseRehearseState(text) {
  if (!text) return { done: false, displayText: text };
  const m = text.match(STATE_RE);
  if (!m) return { done: false, displayText: text };
  return {
    done: m[1].toUpperCase() === "DONE",
    displayText: text.replace(STATE_RE, "").trimEnd(),
  };
}

export function stripRehearseTags(text) {
  if (!text) return text;
  return text.replace(/\[STATE:(CONTINUE|DONE)\]/gi, "").trimEnd();
}

export const KICKOFF_USER_MESSAGE = "Start the session. Introduce yourself in character and ask the opening question.";
