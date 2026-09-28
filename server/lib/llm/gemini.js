/**
 * Gemini streaming chat client.
 *
 * Yields { type: 'token', text } chunks, then { type: 'done' } or { type: 'error', ... }.
 *
 * `streamWithTools` extends this to handle function calling: the response
 * may include functionCall parts that yield as { type: 'tool_call', ... }.
 */

const STREAM_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

/**
 * Convert canonical agent messages into Gemini `contents` array.
 * Agent messages can be:
 *   { role: 'user'|'assistant', content: '...' }            — text
 *   { role: 'assistant', tool_calls: [{id,name,args}] }     — agent invoking tools
 *   { role: 'tool', tool_call_id, name, content }           — tool result
 */
function toGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // Gemini wants functionResponse parts as a single user-role message
      out.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.name,
            response: typeof m.content === 'string'
              ? safeParseJSON(m.content) ?? { content: m.content }
              : m.content,
          },
        }],
      });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        parts.push({ functionCall: { name: tc.name, args: tc.input || tc.args || {} } });
      }
    }
    if (parts.length === 0) parts.push({ text: '' });
    out.push({ role, parts });
  }
  return out;
}

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export async function* streamChat({ messages, system, max = 1024, model, apiKey, signal }) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: max },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };

  let res;
  try {
    res = await fetch(`${STREAM_URL(model)}&key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    yield { type: 'error', message: String(err) };
    return;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    yield { type: 'error', status: res.status, body: text.slice(0, 500) };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Gemini SSE: events separated by blank line, each `data: {json}`
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evt of events) {
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          if (json.usageMetadata?.totalTokenCount) {
            totalTokens = json.usageMetadata.totalTokenCount;
          }
          // Iterate all parts (not just [0]) — gemini-2.5-pro may emit multiple
          // parts per chunk. Skip thinking parts (marked with thought: true).
          const parts = json.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.thought) continue; // skip internal thinking tokens
            if (part.text) yield { type: 'token', text: part.text };
          }
        } catch {
          // ignore malformed/partial chunk
        }
      }
    }
    if (totalTokens) yield { type: 'usage', totalTokens };
    yield { type: 'done' };
  } catch (err) {
    yield { type: 'error', message: String(err) };
  }
}

/**
 * Streaming chat with function-calling support.
 *
 * Yields:
 *   { type: 'token', text }              accumulating natural-language text
 *   { type: 'tool_call', id, name, args }  AI invoked a function
 *   { type: 'usage', totalTokens }       on completion (Gemini sends usage)
 *   { type: 'done' } | { type: 'error' }
 *
 * `tools` is an array of {name, description, input_schema} (canonical format
 * matching our tool registry — converted to Gemini functionDeclarations
 * internally).
 */
export async function* streamWithTools({
  messages, system, tools, max = 1024, model, apiKey, signal,
}) {
  const contents = toGeminiContents(messages);
  const functionDeclarations = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema || { type: 'object', properties: {} },
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: max },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(functionDeclarations.length
      ? { tools: [{ functionDeclarations }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
      : {}),
  };

  let res;
  try {
    res = await fetch(`${STREAM_URL(model)}&key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    yield { type: 'error', message: String(err) };
    return;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    yield { type: 'error', status: res.status, body: text.slice(0, 500) };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalTokens = 0;
  // Gemini may split a single functionCall across chunks; we emit when complete.
  let toolCallSeq = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evt of events) {
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        // Token usage
        if (json.usageMetadata?.totalTokenCount) {
          totalTokens = json.usageMetadata.totalTokenCount;
        }

        const parts = json.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            yield { type: 'token', text: part.text };
          }
          if (part.functionCall) {
            const id = `call_${Date.now()}_${toolCallSeq++}`;
            yield {
              type: 'tool_call',
              id,
              name: part.functionCall.name,
              args: part.functionCall.args || {},
            };
          }
        }
      }
    }
    if (totalTokens) yield { type: 'usage', totalTokens };
    yield { type: 'done' };
  } catch (err) {
    if (err.name !== 'AbortError') yield { type: 'error', message: String(err) };
  }
}
