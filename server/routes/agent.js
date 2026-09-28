import { Router } from 'express';
import { runAgent } from '../lib/agent/loop.js';
import { appendChatMessage, updateChatMessage, listAgentTraces, getAgentTrace } from '../db.js';

const router = Router();

/**
 * In-process map of confirm IDs awaiting user response.
 * Key: confirm_id (tool_call.id). Value: { resolve, reject } from a Promise.
 * Single-process app — fine for now. For multi-instance deploy, move to Redis.
 */
const pendingConfirms = new Map();

/**
 * POST /api/ai/agent
 *
 * Body: {
 *   messages:    [{role, content}, ...]  full conversation history
 *   contextPack: { canvasKey, canvasLabel, breadcrumb, drillParent, nodeCount, ... }
 *   persist?:    { canvasKey, userMessage: { content, meta? } }
 * }
 *
 * Response: SSE stream of agent events.
 *   event: meta          data: { traceId, assistantMessageId? }
 *   event: token         data: { text }
 *   event: tool_call     data: { id, name, input }
 *   event: tool_result   data: { id, name, result?, error?, duration_ms }
 *   event: done          data: { iterations, totalTokens }
 *   event: budget_exhausted data: { reason, iterations }
 *   event: cancelled     data: {}
 *   event: error         data: { message }
 */
router.post('/agent', async (req, res) => {
  const { messages = [], contextPack, persist } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }
  if (!contextPack?.canvasKey) {
    return res.status(400).json({ error: 'contextPack.canvasKey required' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Persistence setup (same pattern as /api/ai/chat)
  let assistantMessageId = null;
  if (persist?.canvasKey) {
    try {
      if (persist.userMessage) {
        appendChatMessage(req.workspaceId, persist.canvasKey, {
          role: 'user',
          content: persist.userMessage.content || '',
          meta: persist.userMessage.meta,
          streaming: false,
        });
      }
      const placeholder = appendChatMessage(req.workspaceId, persist.canvasKey, {
        role: 'assistant',
        content: '',
        meta: { agent: true, ...(persist.assistantMeta || {}) },
        streaming: true,
      });
      assistantMessageId = placeholder.id;
    } catch (e) {
      console.error('[ai/agent] persistence setup failed:', e.message);
    }
  }

  // Heartbeat to keep connection alive through proxies / silence
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  let accumulated = '';
  let finalizedReason = null;
  let traceId = null;

  const finalize = (reason, errMessage) => {
    if (finalizedReason) return;
    finalizedReason = reason;
    if (assistantMessageId) {
      try {
        updateChatMessage(req.workspaceId, assistantMessageId, {
          content: accumulated,
          streaming: false,
          meta: {
            agent: true,
            traceId,
            ...(persist?.assistantMeta || {}),
            ...(errMessage ? { error: errMessage } : {}),
            ...(reason !== 'done' ? { interrupted: true } : {}),
          },
        });
      } catch (e) {
        console.error('[ai/agent] finalize failed:', e.message);
      }
    }
  };
  req.on('close', () => finalize('abort'));

  const ctx = {
    workspaceId: req.workspaceId,
    canvasKey: contextPack.canvasKey,
    contextPack,
    pendingConfirms,
  };

  try {
    for await (const event of runAgent({ messages, ctx, signal: abort.signal })) {
      if (abort.signal.aborted) break;

      if (event.type === 'meta' && event.traceId) traceId = event.traceId;
      if (event.type === 'token') accumulated += event.text;

      send(event.type, event);

      // confirm_request is a yield-and-block — the loop awaits user response
      // via pendingConfirms after emitting this event. Frontend POSTs to
      // /agent/confirm to unblock. No special handling needed here.

      if (event.type === 'done') { finalize('done'); break; }
      if (event.type === 'error') { finalize('error', event.message); break; }
      if (event.type === 'cancelled') { finalize('abort'); break; }
      if (event.type === 'budget_exhausted') { finalize('budget'); break; }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      send('error', { message: String(err.message || err) });
      finalize('error', String(err));
    }
  } finally {
    clearInterval(heartbeat);
    finalize(abort.signal.aborted ? 'abort' : 'done');
    res.end();
  }
});

/**
 * POST /api/ai/agent/confirm
 * Body: { confirm_id, choice }
 *
 * Resolves a pending confirm_with_user call. The agent loop is awaiting
 * pendingConfirms.get(confirm_id).resolve(choice). If no such pending
 * confirm exists, the agent already moved on (timeout/abort) — return 410.
 */
router.post('/agent/confirm', (req, res) => {
  const { confirm_id, choice } = req.body || {};
  if (!confirm_id) return res.status(400).json({ error: 'confirm_id required' });
  const pending = pendingConfirms.get(confirm_id);
  if (!pending) return res.status(410).json({ error: 'no pending confirm (timed out or already resolved)' });
  try {
    pending.resolve(choice ?? null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/ai/agent/traces/:canvasKey — list recent agent runs */
router.get('/agent/traces/:canvasKey', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.canvasKey);
    res.json(listAgentTraces(req.workspaceId, key));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/ai/agent/traces/:canvasKey/:id — single trace with tool_calls */
router.get('/agent/traces/:canvasKey/:id', (req, res) => {
  try {
    const trace = getAgentTrace(req.workspaceId, req.params.id);
    if (!trace) return res.status(404).json({ error: 'not found' });
    res.json(trace);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
