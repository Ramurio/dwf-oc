import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import observer from './model-observer/index.mjs';
import { requestEvidence, responseEvidence } from './model-observer/index.mjs';

test('native observer records model and reasoning without credential headers', async () => {
  const request = new Request('https://example.com/v1/responses', {
    method: 'POST', headers: { authorization: 'SECRET' },
    body: JSON.stringify({ model: 'gpt-test', reasoning: { effort: 'high' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Задание' }] }] }),
  });
  const evidence = await requestEvidence(request, { providerID: 'openai' }, 'ses_test', 'call_test');
  assert.equal(evidence.prompt, 'Задание');
  assert.equal(evidence.reasoning, 'high');
  assert.deepEqual(evidence.model, { provider: 'openai', modelId: 'gpt-test' });
  assert(!JSON.stringify(evidence).includes('SECRET'));
  assert.equal((await request.json()).model, 'gpt-test');
});

test('native observer leaves the original SSE response readable and preserves exact final text', async () => {
  const exact = '  План\n\u2028\u2029  ';
  const stream = [
    { type: 'response.output_text.delta', delta: exact },
    { type: 'response.completed', response: { status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: exact }] }] } },
  ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  const response = new Response(stream);
  const events = [];
  await responseEvidence(response.clone(), event => events.push(event), { callId: 'call_test', model: {} });
  assert.equal(await response.text(), stream);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, exact);
  assert.equal(events[0].stopReason, 'stop');
});

test('native observer sees WebSocket requests and exact completed answers without changing frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-ws-observer-'));
  const hooks = new Map();
  try {
    await observer.setup({ options: { directory, token: 'test-token' },
      session: { hook: async (name, callback) => hooks.set(name, callback) } });
    assert(hooks.has('experimental.ws.send'), 'Нужно наблюдать нативный WebSocket transport');
    const event = { kind: 'primary', model: { providerID: 'openai' }, sessionID: 'ses_ws',
      frame: JSON.stringify({ type: 'response.create', model: 'gpt-6.1-sol', service_tier: 'ultrafast',
        reasoning: { effort: 'high' }, input: [{ role: 'user', content: 'Поручение' }] }) };
    const original = event.frame;
    await hooks.get('experimental.ws.send')(event);
    assert.equal(event.frame, original);
    const final = { ...event, frame: JSON.stringify({ type: 'response.completed', response: {
      status: 'completed', service_tier: 'ultrafast',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '  План\n' }] }],
    } }) };
    await hooks.get('experimental.ws.receive')(final);
    const events = (await readFile(join(directory, 'provider.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].reasoning, 'high');
    assert.equal(events[0].serviceTier, 'ultrafast');
    assert.equal(events[1].text, '  План\n');
    assert.equal(events[1].serviceTier, 'ultrafast');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
