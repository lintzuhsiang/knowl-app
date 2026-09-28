/**
 * Sub-LLM call helper.
 *
 * Used by Tier 1.5 LLM-powered discovery tools (suggest_bridges,
 * expand_concept, etc.) to make a narrow, single-prompt LLM call from
 * within the main agent loop. Returns either parsed JSON or raw text.
 *
 * Design notes:
 * - Always non-streaming from the caller's perspective (we accumulate the
 *   stream into a final string).
 * - Hard timeout via AbortSignal — sub-calls shouldn't hold up the parent
 *   agent loop indefinitely.
 * - Errors surface as { error: ... } structured results so the tool can
 *   gracefully degrade rather than crash the agent.
 */

import { streamChat } from '../llm/index.js';

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Call the LLM with a focused prompt. Returns the full accumulated text.
 *
 * @param {object} opts
 * @param {string} opts.system        narrow system prompt
 * @param {string} opts.prompt        user-role prompt
 * @param {number} [opts.maxTokens]   default 700
 * @param {number} [opts.timeoutMs]   default 30s
 * @param {AbortSignal} [opts.parentSignal]  parent abort (chains)
 */
export async function callSubLLM({
  system,
  prompt,
  maxTokens = 700,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  parentSignal,
}) {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  let text = '';
  let errored = null;

  try {
    for await (const chunk of streamChat({
      messages: [{ role: 'user', content: prompt }],
      system,
      max: maxTokens,
      signal: ctrl.signal,
    })) {
      if (chunk.type === 'token') text += chunk.text;
      else if (chunk.type === 'error') { errored = chunk; break; }
    }
  } catch (e) {
    if (!ctrl.signal.aborted) errored = { message: String(e.message || e) };
  } finally {
    clearTimeout(timeout);
    if (parentSignal) parentSignal.removeEventListener?.('abort', onParentAbort);
  }

  if (errored) throw new Error(errored.message || errored.body || 'sub-LLM error');
  if (ctrl.signal.aborted) throw new Error('sub-LLM timed out');
  return text;
}

/**
 * Strip markdown fences + parse JSON. Returns null on parse failure.
 */
export function parseSubJSON(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

/**
 * Convenience: callSubLLM + parseSubJSON in one go.
 * Returns { ok: true, data } or { ok: false, error, raw }.
 */
export async function callSubLLMJSON(opts) {
  try {
    const raw = await callSubLLM(opts);
    const data = parseSubJSON(raw);
    if (data == null) return { ok: false, error: 'sub-LLM returned non-JSON', raw };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
