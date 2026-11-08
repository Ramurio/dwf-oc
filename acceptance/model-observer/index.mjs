// Native OpenCode hooks observe the ordinary provider transport without replacing it.
import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as zlib from 'node:zlib';

const hash = text => createHash('sha256').update(text).digest('hex');
const contentText = content => typeof content === 'string' ? content : (content ?? [])
  .filter(part => ['text', 'input_text', 'output_text'].includes(part.type))
  .map(part => part.text ?? '').join('');

export async function requestEvidence(request, model, sessionID, callId) {
  let bytes = new Uint8Array(await request.clone().arrayBuffer());
  const encoding = request.headers.get('content-encoding');
  if (encoding === 'zstd') bytes = zlib.zstdDecompressSync(bytes);
  if (encoding === 'gzip') bytes = zlib.gunzipSync(bytes);
  const body = JSON.parse(new TextDecoder().decode(bytes));
  const messages = body.input ?? body.messages ?? [];
  const prompt = typeof messages === 'string' ? messages : messages
    .filter(message => message.role === 'user').map(message => contentText(message.content)).join('\n');
  return { type: 'received', callId, providerSessionId: sessionID, prompt, promptHash: hash(prompt),
    messagesHash: hash(JSON.stringify(messages)), model: { provider: model.providerID, modelId: body.model },
    reasoning: body.reasoning?.effort ?? body.reasoning_effort, serviceTier: body.service_tier,
    limits: Object.fromEntries(['max_tokens', 'max_completion_tokens', 'max_output_tokens']
      .filter(key => typeof body[key] === 'number').map(key => [key, body[key]])) };
}

function responseEvents(record, call) {
  let text = '';
  let finished = false;
  let firstTextAt;
  let lastTextAt;
  return {
    get finished() { return finished; },
    consume(event) {
      if (event.type === 'response.output_text.delta') {
        text += event.delta;
        firstTextAt ??= performance.now();
        lastTextAt = performance.now();
      }
      const choice = event.choices?.[0];
      if (choice?.delta?.content) text += choice.delta.content;
      let reason = choice?.finish_reason;
      if (['response.completed', 'response.done', 'response.incomplete', 'response.failed'].includes(event.type)) {
        const result = event.response;
        if (result?.output) text = result.output.map(item => contentText(item.content)).join('');
        reason = result?.status === 'completed' ? 'stop'
          : result?.status === 'incomplete' ? 'length' : 'error';
      }
      if (reason) {
        finished = true;
        record({ type: 'completed', callId: call.callId, model: call.model, stopReason: reason, text,
          serviceTier: event.response?.service_tier, streamMs: lastTextAt - firstTextAt,
          outputTokens: event.response?.usage?.output_tokens,
          reasoningTokens: event.response?.usage?.output_tokens_details?.reasoning_tokens });
      }
    },
  };
}

export async function responseEvidence(response, record, call) {
  if (!response.ok || !response.body) {
    record({ type: 'provider-error', callId: call.callId, status: response.status });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = responseEvents(record, call);
  let buffer = '';
  const consume = line => {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') events.consume(JSON.parse(line.slice(6)));
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
      if (chunk.done) break;
    }
    if (buffer) consume(buffer);
    if (!events.finished) record({ type: 'observer-error', callId: call.callId, reason: 'no-terminal-event' });
  } finally { reader.releaseLock(); }
}

export default {
  id: 'dwf.acceptance.model-observer',
  async setup(context) {
    const directory = context.options.directory ?? process.env.DWF_ACCEPTANCE_CONTROL_DIR;
    const token = context.options.token ?? process.env.DWF_ACCEPTANCE_TOKEN;
    if (!directory || !token) throw new Error('Model observer requires its test-owned evidence directory.');
    const calls = new WeakMap();
    const sockets = new Map();
    const record = event => appendFileSync(join(directory, 'provider.jsonl'),
      JSON.stringify({ ...event, token }) + '\n', { mode: 0o600 });
    await context.session.hook('http.request', async event => {
      if (event.kind !== 'primary') return;
      const call = await requestEvidence(event.request, event.model, event.sessionID, randomUUID());
      calls.set(event.request, call);
      record(call);
    });
    await context.session.hook('http.response', event => {
      const call = calls.get(event.request);
      if (!call) return;
      responseEvidence(event.response.clone(), record, call)
        .catch(() => record({ type: 'observer-error', callId: call.callId, reason: 'response-read-failed' }));
    });
    await context.session.hook('experimental.ws.send', async event => {
      if (event.kind !== 'primary') return;
      const body = JSON.parse(event.frame);
      if (body.type !== 'response.create') return;
      const request = new Request('http://observer.invalid/responses', { method: 'POST', body: event.frame });
      const call = await requestEvidence(request, event.model, event.sessionID, randomUUID());
      record(call);
      sockets.set(event.sessionID, responseEvents(record, call));
    });
    await context.session.hook('experimental.ws.receive', event => {
      const events = sockets.get(event.sessionID);
      if (!events) return;
      events.consume(JSON.parse(event.frame));
      if (events.finished) sockets.delete(event.sessionID);
    });
  },
};
