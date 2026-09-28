/**
 * Backend LLM client. All requests hit /api/ai/chat — the Gemini key never
 * leaves the server. The streaming endpoint emits SSE events:
 *   event: token  data: { text }
 *   event: done   data: {}
 *   event: error  data: { message } | { status, body }
 */

const AUTH_KEY      = 'knowl_auth_token';
const WORKSPACE_KEY = 'knowl_workspace_id';

// Same API base resolution as graphSync.js — see comments there.
const API_BASE = (
  (typeof window !== 'undefined' && window.KNOWL_API_BASE) ||
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) ||
  ''
);

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(AUTH_KEY);
  if (token) headers['x-auth-token'] = token;
  const ws = localStorage.getItem(WORKSPACE_KEY);
  if (ws) headers['x-workspace-id'] = ws;
  return headers;
}

/**
 * Translate a non-OK Response into a structured Error.
 * Recognized server error codes (see server/middleware/rate-limit.js + token-budget.js):
 *   - RATE_LIMITED            → err.code = 'RATE_LIMITED', err.retryAfter (seconds)
 *   - TOKEN_BUDGET_EXCEEDED   → err.code = 'TOKEN_BUDGET_EXCEEDED', err.used, err.limit, err.resetsAt
 * Other 4xx/5xx → generic Error with .status + .message.
 *
 * Callers (apiStream / agentStream / authFetch) can pattern-match on err.code
 * to render specific UX instead of a generic toast.
 */
async function parseNonOkResponse(res, contextLabel = 'request failed') {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  const err = new Error(
    body?.error
      ? `${contextLabel}: ${body.error}`
      : `${contextLabel}: HTTP ${res.status}`
  );
  err.status = res.status;
  if (body?.code) {
    err.code = body.code;
    if (body.code === 'RATE_LIMITED') {
      err.retryAfter = body.retry_after_seconds || parseInt(res.headers.get('Retry-After') || '0', 10);
    } else if (body.code === 'TOKEN_BUDGET_EXCEEDED') {
      err.used = body.used;
      err.limit = body.limit;
      err.resetsAt = body.resets_at;
    }
  }
  return err;
}

/**
 * Streaming chat. Calls `onToken(chunk, full)` for each delta and `onDone(full)`
 * when finished. Returns the accumulated string. Supports AbortController via
 * `signal`.
 *
 * `persist` opts in to crash-safe chat persistence: the user message is
 * appended up-front and the assistant placeholder is created with streaming=1.
 * On completion or disconnect, the assistant content is finalized. When
 * provided, `onMeta({ assistantMessageId })` fires once before the first token.
 */
export async function apiStream(msgs, sys, max = 1024, opts = {}) {
  const { onToken, onDone, onError, onMeta, signal, model, persist } = opts;
  let full = '';

  let res;
  try {
    res = await fetch(`${API_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ messages: msgs, system: sys, max, model, persist }),
      signal,
    });
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err);
    throw err;
  }

  if (!res.ok || !res.body) {
    const err = await parseNonOkResponse(res, 'AI request failed');
    onError?.(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evt of events) {
        if (!evt || evt.startsWith(':')) continue; // skip comments/heartbeats
        const lines = evt.split('\n');
        const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const data  = lines.find(l => l.startsWith('data:'))?.slice(5).trim();
        if (!data) continue;

        if (event === 'token') {
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          const text = payload.text || '';
          if (text) {
            full += text;
            onToken?.(text, full);
          }
        } else if (event === 'meta') {
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }
          onMeta?.(payload);
        } else if (event === 'error') {
          let payload = {};
          try { payload = JSON.parse(data); } catch { /* ignore */ }
          const err = new Error(payload.message || payload.body || `stream error (${payload.status || ''})`);
          err.__handled = true;
          onError?.(err);
          throw err;
        }
        // 'done' is a no-op — loop exits on stream EOF
      }
    }
    onDone?.(full);
    return full;
  } catch (err) {
    if (err.name === 'AbortError') return full;
    if (!err.__handled) onError?.(err);
    throw err;
  }
}

/**
 * Backwards-compatible non-streaming wrapper. Accumulates the SSE stream and
 * returns a Gemini-shaped response so existing callers (getText / parseJ) work.
 */
export const api = async (msgs, sys, max = 500) => {
  try {
    const text = await apiStream(msgs, sys, max);
    return { candidates: [{ content: { parts: [{ text }] } }] };
  } catch {
    return { candidates: [] };
  }
};

export const getText = (d) =>
  d.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

export const parseJ = (t) => {
  try { return JSON.parse(t.replace(/```json|```/g, '').trim()); }
  catch { return null; }
};

/**
 * Phase 4 — Agent streaming. Extends apiStream with tool-call events.
 *
 * Callbacks:
 *   onToken(chunk, full)            text streamed from agent
 *   onMeta({ traceId })             once at start
 *   onToolCall({ id, name, input }) agent invoked a tool
 *   onToolResult({ id, name, result?, error?, duration_ms })
 *   onBudget({ reason, iterations }) budget hit
 *   onDone(full, { iterations, totalTokens })
 *   onError(err)
 *
 * `persist` (same shape as apiStream) writes user+assistant to chat_messages.
 */
export async function agentStream(msgs, contextPack, opts = {}) {
  const {
    onToken, onMeta, onToolCall, onToolResult,
    onConfirmRequest, onBudget, onDone, onError,
    signal, persist,
  } = opts;
  let full = '';
  let summary = { iterations: 0, totalTokens: 0 };

  let res;
  try {
    res = await fetch(`${API_BASE}/api/ai/agent`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ messages: msgs, contextPack, persist }),
      signal,
    });
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err);
    throw err;
  }

  if (!res.ok || !res.body) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* ignore */ }
    const err = new Error(`Agent request failed: ${res.status} ${bodyText.slice(0, 200)}`);
    onError?.(err);
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evt of events) {
        if (!evt || evt.startsWith(':')) continue;
        const lines = evt.split('\n');
        const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const data  = lines.find(l => l.startsWith('data:'))?.slice(5).trim();
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        switch (event) {
          case 'token': {
            const text = payload.text || '';
            if (text) { full += text; onToken?.(text, full); }
            break;
          }
          case 'meta':
            onMeta?.(payload);
            break;
          case 'tool_call':
            onToolCall?.(payload);
            break;
          case 'tool_result':
            onToolResult?.(payload);
            break;
          case 'confirm_request':
            onConfirmRequest?.(payload);
            break;
          case 'budget_exhausted':
            onBudget?.(payload);
            break;
          case 'cancelled':
            // treated like done
            break;
          case 'done':
            summary = { iterations: payload.iterations, totalTokens: payload.totalTokens };
            break;
          case 'error': {
            const err = new Error(payload.message || payload.body || 'agent error');
            err.__handled = true;
            onError?.(err);
            throw err;
          }
        }
      }
    }
    onDone?.(full, summary);
    return full;
  } catch (err) {
    if (err.name === 'AbortError') return full;
    if (!err.__handled) onError?.(err);
    throw err;
  }
}

/**
 * Resolve a pending confirm_with_user. `choice` is whichever option string
 * the user picked. If the server already timed-out / aborted the agent, the
 * endpoint returns 410 — caller can ignore.
 */
export async function resolveAgentConfirm(confirmId, choice) {
  try {
    const res = await fetch(`${API_BASE}/api/ai/agent/confirm`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ confirm_id: confirmId, choice }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
