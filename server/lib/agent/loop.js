/**
 * Hand-rolled agent loop. Yields SSE-friendly events as an async generator.
 *
 * Events:
 *   { type: 'token',       text }
 *   { type: 'tool_call',   id, name, input }
 *   { type: 'tool_result', id, name, result?, error?, duration_ms }
 *   { type: 'usage',       totalTokens }
 *   { type: 'done',        iterations }
 *   { type: 'budget_exhausted', reason, iterations }
 *   { type: 'cancelled' }
 *   { type: 'error',       message }
 */

import { streamWithTools } from '../llm/index.js';
import { TOOLS, TOOL_SCHEMAS, isReadOnly, isPropose, isControl, executeTool } from './tools.js';
import {
  createAgentTrace, updateAgentTrace,
} from '../../db.js';

export const AGENT_BUDGET = {
  maxIterations: 10,
  maxTokens: 20000,
  maxOutputPerTurn: 1024,
  confirmTimeoutMs: 120000, // 2 minutes for user to respond to confirm_with_user
};

/**
 * Block the loop until the user POSTs to /api/ai/agent/confirm or timeout/abort.
 * Returns the user's choice string. Throws on timeout / abort.
 */
function waitForUserConfirm(confirmId, pendingConfirms, signal) {
  if (!pendingConfirms) throw new Error('pendingConfirms map not provided to agent ctx');
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pendingConfirms.delete(confirmId);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      clearTimeout(timer);
    };
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('confirm timeout')); }, AGENT_BUDGET.confirmTimeoutMs);
    if (signal) {
      if (signal.aborted) { cleanup(); reject(new Error('aborted')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    pendingConfirms.set(confirmId, {
      resolve: (choice) => { cleanup(); resolve(choice); },
      reject:  (e)      => { cleanup(); reject(e); },
    });
  });
}

function buildAgentSystemPrompt(ctx) {
  const cp = ctx.contextPack;
  const breadcrumb = cp?.breadcrumb?.map(b => b.title).join(' > ') || ctx.canvasKey;
  const parentBody = cp?.drillParent?.body
    ? `\nDrilled into "${cp.drillParent.title}". Parent body:\n${cp.drillParent.body.trim()}\n`
    : '';

  return `You are a curiosity prosthesis embedded in the user's personal knowledge graph.

Your PRIMARY job is to surface knowledge structure the user hasn't noticed yet —
latent connections, coverage gaps, unexplored adjacencies — not pure Q&A.

Tool categories:
- READ (auto, parallel, cheap): search_nodes, read_node, list_nodes, traverse,
  list_topics, get_user_focus, get_memory_stats, find_orphans
- DISCOVER (auto, parallel, cheap): find_dormant_threads, find_unexplored_neighbors
- DISCOVER-LLM (auto, parallel, MORE EXPENSIVE — each makes a sub-LLM call):
  suggest_bridges, expand_concept, infer_implicit_concepts,
  find_conceptual_gaps, infer_node_overlap
- PROPOSE (serial, MAX 1 per turn, requires user accept): propose_create_node,
  propose_update_node, propose_delete_node, propose_link_nodes, propose_unlink,
  propose_merge_nodes
- CONTROL: confirm_with_user (BLOCKS until user picks an option),
  hand_off_to_mode (suggests /warmup, /quiz, /rehearse, /audit)

Behavioral rules (NEVER break):
1. SCOPE: you only see the current canvas (${ctx.canvasKey}). NEVER assume
   cross-topic knowledge. If user asks about something outside, use list_topics
   to suggest they switch — don't try to fetch it.
2. Ground every claim in tool results. Quote specific phrases from read_node.
3. When comparing nodes, call read_node on EACH — never claim differences
   from titles alone.
4. Keep replies concise (2-5 sentences). Heavy thinking goes in tool calls.

PROACTIVE DISCOVERY (your differentiator):
5. Before doing anything else on a turn, call get_user_focus(). If
   \`returning_from_gap\` is true AND the user's message is a greeting /
   vague / has no specific question — fire 1-2 discovery tools and surface
   the highest-signal finding. ONE OR TWO findings only, NOT a dump.
6. If \`returning_from_gap\` is false (active session), DO NOT run proactive
   discovery — just answer the question. Discovery during active flow is noise.
7. When you do surface a discovery, format it as:
   "I noticed [specific observation about specific nodes]. Want to dig in?"
   Then STOP and wait. Don't dive deeper without the user opting in.

PROPOSE TOOL DISCIPLINE:
8. NEVER make a proposal speculatively. Always:
   a. Read the relevant nodes first (read_node)
   b. Explain in text WHY the proposal is justified
   c. Then call propose_*
9. ONE propose_* per turn. If you have multiple ideas, propose the strongest
   one this turn and offer the others as text suggestions for the next turn.
10. propose_delete_node is rarely correct. Prefer propose_merge_nodes or
    propose_update_node.
11. propose_link_nodes labels must be SPECIFIC verbs (depends_on, enables,
    contradicts, is_a, evolved_to). Reject "relates to" as too vague.
12. After calling a propose_* tool, briefly tell the user what you proposed
    and that they'll see a card to accept/dismiss.

DISCOVER-LLM DISCIPLINE:
13. DISCOVER-LLM tools (suggest_bridges, expand_concept, etc.) cost ~5x more
    than cheap reads. Only use when:
    - User is clearly in exploration mode (greeting / returning / "what should I look at")
    - You've already done cheap reads and need creative inference
    - You're about to call propose_* and need to validate the proposal
14. Don't fire DISCOVER-LLM speculatively. If a cheap tool would do, use it.

CONFIRM_WITH_USER:
15. Use confirm_with_user ONLY when intent is genuinely ambiguous and
    guessing would waste effort (e.g. merge vs link, which subtree to focus).
16. confirm_with_user BLOCKS the loop. Use sparingly — never for trivial
    yes/no the user can infer from your reply.

HAND_OFF_TO_MODE:
17. Suggest /quiz when user wants to test recall; /warmup for review; /rehearse
    for practice (interview prep etc.); /audit to scan for graph defects.
18. Hand-off is non-blocking — the user clicks a button to opt in.

TOOL USE:
19. You can call multiple READ/DISCOVER tools in parallel.
20. After receiving tool results, either reply to the user OR call more
    tools to refine. Don't loop beyond 3 tool rounds per turn unless
    clearly making progress.

[Current view]: ${breadcrumb}${parentBody}
[Nodes in current canvas]: ${cp?.nodeCount ?? 0}`;
}

/**
 * Main agent loop. Async generator yielding SSE events.
 *
 * @param messages          [{role, content, tool_calls?}, ...] — conversation history
 * @param ctx               { workspaceId, canvasKey, contextPack }
 * @param signal            AbortSignal for cancellation
 * @param tracing           { traceId? } — if provided, write trace updates as we go
 */
export async function* runAgent({ messages, ctx, signal, tracing = {} }) {
  // Create or reuse trace row
  let traceId = tracing.traceId;
  const startedAt = Date.now();
  const userMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  if (!traceId) {
    traceId = createAgentTrace(ctx.workspaceId, ctx.canvasKey, {
      userMessage,
      meta: { model: process.env.GEMINI_MODEL || 'gemini-2.5-pro' },
    });
  }
  yield { type: 'meta', traceId };

  const system = buildAgentSystemPrompt(ctx);
  const history = [...messages];
  const traceCalls = [];
  let iterations = 0;
  let totalTokens = 0;

  try {
    while (iterations < AGENT_BUDGET.maxIterations) {
      iterations++;

      // ── LLM call with tools ──
      const collected = { text: '', tool_calls: [] };
      const stream = streamWithTools({
        messages: history,
        system,
        tools: TOOL_SCHEMAS,
        max: AGENT_BUDGET.maxOutputPerTurn,
        signal,
      });

      for await (const chunk of stream) {
        if (signal.aborted) { yield { type: 'cancelled' }; updateAgentTrace(ctx.workspaceId, traceId, { status: 'cancelled', ended_at: Date.now(), iterations, tool_calls: traceCalls, total_tokens: totalTokens }); return; }
        if (chunk.type === 'token') {
          collected.text += chunk.text;
          yield { type: 'token', text: chunk.text };
        } else if (chunk.type === 'tool_call') {
          collected.tool_calls.push(chunk);
          yield { type: 'tool_call', id: chunk.id, name: chunk.name, input: chunk.args };
        } else if (chunk.type === 'usage') {
          totalTokens = chunk.totalTokens;
        } else if (chunk.type === 'error') {
          yield { type: 'error', message: chunk.message || chunk.body || 'LLM error' };
          updateAgentTrace(ctx.workspaceId, traceId, {
            status: 'error', ended_at: Date.now(),
            iterations, tool_calls: traceCalls, total_tokens: totalTokens,
          });
          return;
        }
      }

      // ── Append assistant turn to history ──
      const assistantTurn = { role: 'assistant', content: collected.text };
      if (collected.tool_calls.length) {
        assistantTurn.tool_calls = collected.tool_calls.map(c => ({
          id: c.id, name: c.name, input: c.args,
        }));
      }
      history.push(assistantTurn);

      // ── Terminate if no tool calls ──
      if (collected.tool_calls.length === 0) {
        yield { type: 'done', iterations, totalTokens };
        updateAgentTrace(ctx.workspaceId, traceId, {
          status: 'completed', ended_at: Date.now(),
          iterations, tool_calls: traceCalls, total_tokens: totalTokens,
        });
        return;
      }

      // ── Partition tool calls: read (parallel) / propose (serial, ≤1) / control (special) ──
      const readCalls    = collected.tool_calls.filter(c => isReadOnly(c.name));
      const proposeCalls = collected.tool_calls.filter(c => isPropose(c.name));
      const controlCalls = collected.tool_calls.filter(c => isControl(c.name));
      const unknownCalls = collected.tool_calls.filter(c =>
        !isReadOnly(c.name) && !isPropose(c.name) && !isControl(c.name)
      );

      // Behavioral rule §11: AT MOST ONE propose per turn.
      const allowedPropose = proposeCalls.slice(0, 1);
      const rejectedPropose = proposeCalls.slice(1);

      // Tool ctx includes signal so sub-LLM tools can chain abort
      const toolCtx = { ...ctx, signal };

      const runOne = async (call, runner) => {
        const t0 = Date.now();
        try {
          const result = await runner();
          return { id: call.id, name: call.name, input: call.args, result, duration_ms: Date.now() - t0, ts: Date.now() };
        } catch (e) {
          return { id: call.id, name: call.name, input: call.args, error: String(e.message || e), duration_ms: Date.now() - t0, ts: Date.now() };
        }
      };

      // Reads in parallel
      const readResults = await Promise.all(
        readCalls.map(c => runOne(c, () => executeTool(c.name, c.args, toolCtx)))
      );

      // Control tools serial (confirm_with_user blocks, hand_off_to_mode is instant)
      const controlResults = [];
      for (const call of controlCalls) {
        if (call.name === 'confirm_with_user') {
          // Special: emit confirm_request, await user POST /agent/confirm
          yield {
            type: 'confirm_request',
            id: call.id,
            question: call.args?.question || '',
            options: Array.isArray(call.args?.options) ? call.args.options : [],
          };
          const t0 = Date.now();
          try {
            const choice = await waitForUserConfirm(call.id, ctx.pendingConfirms, signal);
            controlResults.push({
              id: call.id, name: call.name, input: call.args,
              result: { choice }, duration_ms: Date.now() - t0, ts: Date.now(),
            });
          } catch (e) {
            controlResults.push({
              id: call.id, name: call.name, input: call.args,
              error: String(e.message || e), duration_ms: Date.now() - t0, ts: Date.now(),
            });
          }
        } else {
          controlResults.push(await runOne(call, () => executeTool(call.name, call.args, toolCtx)));
        }
      }

      // Propose serially (at most 1)
      const proposeResults = [];
      for (const c of allowedPropose) {
        proposeResults.push(await runOne(c, () => executeTool(c.name, c.args, toolCtx)));
      }

      const rejectedResults = rejectedPropose.map(c => ({
        id: c.id, name: c.name, input: c.args,
        error: 'Only ONE propose_* tool allowed per turn. Make one proposal, wait for user feedback, then propose again next turn.',
        duration_ms: 0, ts: Date.now(),
      }));

      const unknownResults = unknownCalls.map(c => ({
        id: c.id, name: c.name, input: c.args,
        error: `Unknown tool "${c.name}". Available tools: ${Object.keys(TOOLS).join(', ')}`,
        duration_ms: 0, ts: Date.now(),
      }));

      // controlResults + proposeResults + rejectedResults + unknownResults
      // (reads already yielded above)
      const results = [
        ...readResults,
        ...controlResults, ...proposeResults,
        ...rejectedResults, ...unknownResults,
      ];

      for (const r of results) {
        traceCalls.push(r);
        yield { type: 'tool_result', id: r.id, name: r.name, result: r.result, error: r.error, duration_ms: r.duration_ms };
        // Feed result back to LLM for next iteration
        history.push({
          role: 'tool',
          tool_call_id: r.id,
          name: r.name,
          content: r.error ? `Error: ${r.error}` : JSON.stringify(r.result),
        });
      }

      // ── Budget check ──
      if (totalTokens > AGENT_BUDGET.maxTokens) {
        yield { type: 'budget_exhausted', reason: 'tokens', iterations, totalTokens };
        updateAgentTrace(ctx.workspaceId, traceId, {
          status: 'budget_exhausted', ended_at: Date.now(),
          iterations, tool_calls: traceCalls, total_tokens: totalTokens,
        });
        return;
      }
    }

    // ── Iteration cap hit ──
    yield { type: 'budget_exhausted', reason: 'iterations', iterations, totalTokens };
    updateAgentTrace(ctx.workspaceId, traceId, {
      status: 'budget_exhausted', ended_at: Date.now(),
      iterations, tool_calls: traceCalls, total_tokens: totalTokens,
    });
  } catch (err) {
    if (signal.aborted) {
      yield { type: 'cancelled' };
      updateAgentTrace(ctx.workspaceId, traceId, {
        status: 'cancelled', ended_at: Date.now(),
        iterations, tool_calls: traceCalls, total_tokens: totalTokens,
      });
      return;
    }
    yield { type: 'error', message: String(err.message || err) };
    updateAgentTrace(ctx.workspaceId, traceId, {
      status: 'error', ended_at: Date.now(),
      iterations, tool_calls: traceCalls, total_tokens: totalTokens,
    });
  }
}
