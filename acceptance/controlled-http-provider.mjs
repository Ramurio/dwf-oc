// Only the model endpoint is controlled. OpenCode, its service/storage and DWF stay real.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export const hash = text => createHash('sha256').update(text).digest('hex');
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '';

export function assertHigh(call) {
  assert.equal(call.reasoning, 'high', 'Фактический модельный запрос должен содержать reasoning high');
}

export async function createControlledHttpProvider({ directory, token, finishes = ['stop'], reply }) {
  const calls = new Map();
  let closing = false;
  const record = event => appendFileSync(join(directory, 'provider.jsonl'),
    JSON.stringify({ ...event, token }) + '\n', { mode: 0o600 });
  const releaseFor = async callId => {
    try {
      const value = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
      return value.token === token && (value.all === true || value.callId === callId || value.callIds?.includes(callId));
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      record({ type: 'unexpected-http', method: req.method, path: req.url });
      res.writeHead(404).end();
      return;
    }
    let call;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert(size <= 1024 * 1024, 'Контролируемый запрос превышает 1 MiB');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert(Array.isArray(body.messages), 'OpenAI-compatible request должен содержать messages');
      const prompt = textOf(body.messages.findLast(message => message.role === 'user')?.content);
      const userTexts = body.messages.filter(message => message.role === 'user').map(message => textOf(message.content));
      const systemTexts = body.messages.filter(message => ['system', 'developer'].includes(message.role))
        .map(message => textOf(message.content));
      const tools = body.tools ?? [];
      const toolResults = body.messages.filter(message => message.role === 'tool').map(message => textOf(message.content));
      const previousAnswers = [...calls.values()].filter(previous => previous.text &&
        body.messages.some(message => message.role === 'assistant' && textOf(message.content).includes(previous.text)))
        .map(previous => hash(previous.text));
      const providerSessionId = req.headers['x-opencode-session'] ?? req.headers['x-opencode-session-id'];
      const callId = randomUUID();
      const finishReason = finishes[Math.min(calls.size, finishes.length - 1)];
      call = { callId, res, closed: false, completed: false };
      calls.set(callId, call);
      // This is an HTTP witness, never the mock server's PID as executor identity.
      record({ type: 'received', callId, prompt, promptHash: hash(prompt), userTexts, systemTexts, tools, previousAnswers,
        messagesHash: hash(JSON.stringify(body.messages)), providerSessionId,
        model: { provider: 'dwf-acceptance', modelId: body.model, api: 'openai-compatible' },
        reasoning: body.reasoning_effort ?? body.reasoning?.effort,
        limits: Object.fromEntries(['max_tokens', 'max_completion_tokens', 'max_output_tokens']
          .filter(key => typeof body[key] === 'number').map(key => [key, body[key]])) });
      res.on('error', () => {});
      res.once('close', () => {
        call.closed = true;
        if (!call.completed) record({ type: 'transport-closed', callId, completed: false });
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
      const send = (delta = {}, finish_reason = null) => res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-' + callId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: 'planner', choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n');
      send({ role: 'assistant' });
      const deadline = Date.now() + 300000;
      while (!closing && !call.closed && !await releaseFor(callId)) {
        assert(Date.now() < deadline, 'Fixture deadline awaiting explicit release');
        res.write(': held model response\n\n');
        await pause(25);
      }
      if (closing || call.closed) return;
      // The answer is unknowable until the real request has arrived AND the test releases it.
      const nonce = randomUUID();
      const text = reply ? reply({ prompt, userTexts, systemTexts, tools, toolResults, previousAnswers }) :
        `  План исполнителя ${nonce}\nПоручение: ${hash(prompt)}\n\nСледующий шаг: проверить независимый запуск.\n  `;
      call.text = typeof text === 'string' ? text : undefined;
      record({ type: 'generated', callId, nonce, promptHash: hash(prompt), text });
      res.once('finish', () => {
        call.completed = true;
        record({ type: 'completed', callId, stopReason: finishReason, text,
          model: { provider: 'dwf-acceptance', modelId: body.model } });
      });
      if (typeof text === 'string') {
        send({ content: text });
        send({}, finishReason);
      } else {
        if (text.content) send({ content: text.content });
        send({ tool_calls: text.toolCalls.map((tool, index) => ({ index, id: 'call_' + randomUUID(),
          type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) });
        send({}, 'tool_calls');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      record({ type: 'fixture-error', callId: call?.callId, error: error.code ?? 'invalid-request-or-fixture', message: error.message });
      res.destroy();
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    status(callId) {
      const call = calls.get(callId);
      return call && { callId, closed: call.closed, completed: call.completed };
    },
    async close() {
      closing = true;
      for (const call of calls.values()) if (!call.res.writableFinished) call.res.destroy();
      server.closeAllConnections();
      await new Promise(accept => server.close(accept));
    },
  };
}

export function nativeProviderConfig(baseURL) {
  return {
    update: 'disable', snapshots: false, plugins: [], mcp: { servers: {} },
    providers: { 'dwf-acceptance': {
      name: 'Controlled local HTTP model', package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL, apiKey: 'controlled-local-only' },
      models: { planner: {
        name: 'Controlled planner', limit: { context: 128000, input: 120000, output: 8192 },
        capabilities: { tools: true, input: ['text'], output: ['text'], reasoning: { supported: true, effort: ['high'] } },
        // No reasoning in the base model. Ignoring DWF_PLANNER_REASONING must fail the wire assertion.
        variants: [{ id: 'high', body: { reasoning_effort: 'high' } }],
      } },
    } },
  };
}
