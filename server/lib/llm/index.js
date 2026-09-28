/**
 * Provider-agnostic LLM facade. Phase 1 wires Gemini; swap providers here.
 */
import * as gemini from './gemini.js';

const PROVIDER = process.env.LLM_PROVIDER || 'gemini';

function geminiOpts(opts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  return {
    ...opts,
    apiKey,
    model: opts.model || process.env.GEMINI_MODEL || 'gemini-2.5-pro',
  };
}

export function streamChat(opts) {
  if (PROVIDER === 'gemini') return gemini.streamChat(geminiOpts(opts));
  throw new Error(`Unknown LLM provider: ${PROVIDER}`);
}

/** Phase 4 — streaming with tool calling */
export function streamWithTools(opts) {
  if (PROVIDER === 'gemini') return gemini.streamWithTools(geminiOpts(opts));
  throw new Error(`Unknown LLM provider: ${PROVIDER}`);
}
