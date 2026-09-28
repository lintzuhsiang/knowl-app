import { Router } from 'express';
import { streamChat } from '../lib/llm/index.js';
import { appendChatMessage, updateChatMessage } from '../db.js';

const router = Router();

/**
 * POST /api/ai/chat
 * Body: {
 *   messages: [{role, content}],
 *   system?: string,
 *   max?: number,
 *   model?: string,
 *   persist?: {
 *     canvasKey: string,           // where to attach the conversation
 *     userMessage?: { content, meta? },  // append before streaming starts
 *     assistantMeta?: object       // attached to the placeholder message
 *   }
 * }
 *
 * Response: SSE stream:
 *   event: meta    data: { assistantMessageId }   (sent once if persist enabled)
 *   event: token   data: { text }
 *   event: done    data: {}
 *   event: error   data: { message } | { status, body }
 *
 * Persistence behavior: when `persist` is given, the user message is appended
 * up-front and an empty assistant placeholder is created with streaming=1.
 * On stream completion (or client disconnect), the assistant content is
 * finalized and streaming flipped to 0. Crash-safe: on server restart, any
 * stuck streaming=1 rows are reaped (see db.js reapStreamingMessages).
 */
router.post('/chat', async (req, res) => {
  const { messages = [], system, max = 1024, model, persist } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
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

  // ── Persistence setup ──
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
        meta: persist.assistantMeta,
        streaming: true,
      });
      assistantMessageId = placeholder.id;
      send('meta', { assistantMessageId });
    } catch (e) {
      // Don't block the stream on persistence failure — log and continue
      console.error('[ai/chat] persistence setup failed:', e.message);
    }
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  let accumulated = '';
  let totalTokens = 0;
  let finalizedReason = null; // 'done' | 'error' | 'abort'

  const finalize = (reason, errMessage) => {
    if (finalizedReason) return;
    finalizedReason = reason;
    if (assistantMessageId) {
      try {
        // Token count goes in meta.tokens so getUserTokenUsage can aggregate
        const baseMeta = persist?.assistantMeta || {};
        const meta = errMessage
          ? { ...baseMeta, tokens: totalTokens, error: errMessage, interrupted: reason !== 'done' }
          : reason !== 'done'
            ? { ...baseMeta, tokens: totalTokens, interrupted: true }
            : { ...baseMeta, tokens: totalTokens };
        updateChatMessage(req.workspaceId, assistantMessageId, {
          content: accumulated,
          streaming: false,
          meta,
        });
      } catch (e) {
        console.error('[ai/chat] finalize persistence failed:', e.message);
      }
    }
  };

  req.on('close', () => finalize('abort'));

  try {
    for await (const chunk of streamChat({
      messages, system, max, model, signal: abort.signal,
    })) {
      if (abort.signal.aborted) break;
      if (chunk.type === 'token') accumulated += chunk.text;
      if (chunk.type === 'usage') totalTokens = chunk.totalTokens;
      send(chunk.type, chunk);
      if (chunk.type === 'error') { finalize('error', chunk.message || chunk.body); break; }
      if (chunk.type === 'done')  { finalize('done'); break; }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      send('error', { message: String(err) });
      finalize('error', String(err));
    }
  } finally {
    clearInterval(heartbeat);
    finalize(abort.signal.aborted ? 'abort' : 'done');
    res.end();
  }
});

export default router;
