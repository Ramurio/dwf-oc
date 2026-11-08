import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createControlledHttpProvider, assertHigh, hash, nativeProviderConfig } from './controlled-http-provider.mjs';
import { createSandbox, originalStillWorking, transcript, waitFor, writeJson } from './harness.mjs';

async function setup(run) {
  const sandbox = await createSandbox();
  const model = await createControlledHttpProvider({ directory: sandbox.control, token: sandbox.token });
  const events = () => transcript(join(sandbox.control, 'provider.jsonl'));
  const task = 'План\u2028свежего запроса ' + sandbox.token;
  const controllers = [];
  const request = async () => {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(model.baseURL + '/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-opencode-session': 'ses_fixture_control', Authorization: 'DO_NOT_RECORD' },
      body: JSON.stringify({ model: 'planner', stream: true,
        messages: [{ role: 'system', content: 'Controlled system context' }, { role: 'user', content: task }],
        reasoning_effort: 'high', max_tokens: 8192 }),
    });
  };
  try { await run({ sandbox, model, events, task, controllers, request }); }
  finally {
    for (const controller of controllers) controller.abort();
    await model.close();
    await sandbox.cleanup();
  }
}

test('HTTP fixture holds the original stream, creates a fresh exact answer only after release, and records wire parameters', async () => {
  await setup(async ({ sandbox, model, events, task, request }) => {
    const response = await request();
    const ready = await waitFor(async () => (await events()).find(event => event.type === 'received'), 3000, 'HTTP request');
    assert.equal(ready.prompt, task);
    assert.deepEqual(ready.systemTexts, ['Controlled system context']);
    assert.equal(ready.promptHash, hash(task));
    assert.equal(ready.providerSessionId, 'ses_fixture_control');
    assert.deepEqual(ready.model, { provider: 'dwf-acceptance', modelId: 'planner', api: 'openai-compatible' });
    assertHigh(ready);
    assert.deepEqual(ready.limits, { max_tokens: 8192 });
    assert(!(await events()).some(event => ['generated', 'completed'].includes(event.type)));
    const world = { sandbox, controlledModel: model, ready, task, startClient: { exited: true }, released: false };
    await originalStillWorking(world);
    await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callId: ready.callId });
    world.released = true;
    const stream = await response.text();
    const text = stream.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice(6)).choices[0].delta.content ?? '').join('');
    const seen = await events();
    const generated = seen.find(event => event.type === 'generated');
    const completed = seen.find(event => event.type === 'completed');
    assert(generated.nonce && text.includes(generated.nonce) && text.includes(hash(task)));
    assert.equal(text, generated.text);
    assert.equal(completed.text, text);
    assert.equal(completed.stopReason, 'stop');
    assert(stream.includes('"finish_reason":"stop"') && stream.includes('data: [DONE]'));
    await originalStillWorking(world); // A normally closed completed stream is allowed.
    assert(!(await readFile(join(sandbox.control, 'provider.jsonl'), 'utf8')).includes('DO_NOT_RECORD'));
  });
});

test('premature close of the actual HTTP transport is a specific lifetime failure, not a mock-PID check', async () => {
  await setup(async ({ sandbox, model, events, task, controllers, request }) => {
    await request();
    const ready = (await events()).find(event => event.type === 'received');
    controllers[0].abort();
    await waitFor(() => model.status(ready.callId)?.closed, 3000, 'actual closed HTTP response');
    const world = { sandbox, controlledModel: model, ready, task, startClient: { exited: true }, released: false };
    await assert.rejects(originalStillWorking(world), /LIFETIME_FAILURE: исходный SSE transport закрылся/);
    assert.equal(world.lifetimeFailure.transport.closed, true);
    assert.equal(world.lifetimeFailure.startExited, true);
    assert.equal(world.lifetimeFailure.completed, false);
    assert(!(await events()).some(event => event.type === 'generated'));
  });
});

test('a second model call cannot hide a lifetime failure; high is only an explicit native variant', async () => {
  await setup(async ({ sandbox, model, events, task, request }) => {
    await request();
    const ready = (await events()).find(event => event.type === 'received');
    await request();
    const world = { sandbox, controlledModel: model, ready, task, startClient: { exited: true }, released: false };
    await assert.rejects(originalStillWorking(world), /LIFETIME_FAILURE: новый модельный вызов/);
    assert.throws(() => assertHigh({ ...ready, reasoning: undefined }), /reasoning high/);
    assert.throws(() => assertHigh({ ...ready, reasoning: 'low' }), /reasoning high/);
    const config = nativeProviderConfig(model.baseURL);
    const catalogModel = config.providers['dwf-acceptance'].models.planner;
    assert.equal(config.agents, undefined);
    assert.equal(config.model, undefined);
    assert.equal(catalogModel.body, undefined);
    assert.deepEqual(catalogModel.variants, [{ id: 'high', body: { reasoning_effort: 'high' } }]);
  });
});
