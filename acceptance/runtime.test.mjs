import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, transcript, waitFor, writeJson } from './harness.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { getWorkflow } from '../run-store.mjs';

const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const verdict = (outcome = 'approve') => JSON.stringify({ outcome, summary: `Observed ${outcome}` });

async function fixture(t, definition, reply, directory = false, overrides = {}) {
  const sandbox = await createSandbox();
  const provider = await createControlledHttpProvider({ directory: sandbox.control, token: sandbox.token, reply });
  t.after(async () => {
    await provider.close();
    await sandbox.cleanup();
  });
  const isolated = join(sandbox.root, 'isolated');
  await mkdir(isolated);
  Object.assign(sandbox.env, {
    OPENCODE_TEST_HOME: isolated, OPENCODE_CONFIG_DIR: join(isolated, 'config'),
    XDG_CONFIG_HOME: join(isolated, 'config'), XDG_DATA_HOME: join(isolated, 'data'),
    XDG_CACHE_HOME: join(isolated, 'cache'), XDG_STATE_HOME: join(isolated, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_FFF: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    DWF_PLANNER_MODEL: JSON.stringify({ provider: 'dwf-acceptance', modelId: 'planner' }),
    DWF_PLANNER_REASONING: 'high', OPENCODE_CONFIG: join(sandbox.root, 'provider.json'),
  });
  delete sandbox.env.OPENCODE_CONFIG_CONTENT;
  Object.assign(sandbox.env, overrides);
  const config = nativeProviderConfig(provider.baseURL);
  const alternate = structuredClone(config.providers['dwf-acceptance'].models.planner);
  alternate.capabilities.reasoning.effort.push('low');
  alternate.variants.push({ id: 'low', body: { reasoning_effort: 'low' } });
  config.providers['dwf-acceptance'].models.alternate = alternate;
  await writeJson(sandbox.env.OPENCODE_CONFIG, config);
  if (!directory) {
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'],
      ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'base']]) {
      execFileSync('git', args, { cwd: sandbox.workspace, env: sandbox.env, stdio: 'pipe' });
    }
  }
  await writeFile(join(sandbox.root, 'AGENTS.md'), 'Inherited runtime test instructions');
  const file = join(sandbox.root, 'workflow.json');
  await writeJson(file, definition);
  const run = await cliJson(sandbox.spawn(cli, ['start', '--file', file]), 20000);
  const events = () => transcript(join(sandbox.control, 'provider.jsonl'));
  return { ...sandbox, runId: run.runId, events,
    command: args => cliJson(sandbox.spawn(cli, args), 20000),
    release: () => writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, all: true }),
    finish: () => waitFor(async () => {
      const state = getWorkflow(sandbox.state, run.runId);
      return state.status !== 'running' && state;
    }, 30000, 'workflow completion'),
  };
}

test('public CLI freezes per-node model, reasoning, tools, skills and memory', { timeout: 60000 }, async t => {
  let reviews = 0;
  const definition = { task: 'Check participant isolation', entry: 'remember',
    roles: { worker: { tools: ['read'], skills: ['code-work'] }, verifier: { tools: [], skills: [] } },
    nodes: { remember: { role: 'worker', instructions: 'participant=remember' },
      fresh: { role: 'worker', instructions: 'participant=fresh', memory: false, tools: [], skills: [],
        model: { provider: 'dwf-acceptance', modelId: 'alternate' }, reasoning: 'low' },
      verify: { role: 'verifier' } },
    transitions: { remember: { done: 'fresh' }, fresh: { done: 'verify' }, verify: { changes: 'remember', approve: null } } };
  const sandbox = await fixture(t, definition, ({ prompt, tools }) => {
    const names = tools.map(tool => tool.function.name).sort();
    if (prompt.includes('participant=remember')) {
      assert.deepEqual(names, ['read', 'skill']);
      return verdict('done');
    }
    assert.deepEqual(names, []);
    return prompt.includes('participant=fresh') ? verdict('done') : verdict(++reviews === 1 ? 'changes' : 'approve');
  });
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  const calls = (await sandbox.events()).filter(item => item.type === 'received');
  const remembered = calls.filter(item => item.prompt.includes('participant=remember'));
  const fresh = calls.filter(item => item.prompt.includes('participant=fresh'));
  assert.equal(remembered.length, 2);
  assert.equal(fresh.length, 2);
  assert.equal(remembered[0].providerSessionId, remembered[1].providerSessionId);
  assert.notEqual(fresh[0].providerSessionId, fresh[1].providerSessionId);
  assert(remembered.every(call => call.reasoning === 'high' && call.model.modelId === 'planner'));
  assert(fresh.every(call => call.reasoning === 'low' && call.model.modelId === 'alternate'));
  assert.deepEqual(result.participants.fresh.model, { providerID: 'dwf-acceptance', id: 'alternate', variant: 'low' });
});

test('public CLI completes a read-only graph without creating a Git repository', { timeout: 60000 }, async t => {
  const definition = { task: 'Read project documents', workspace: 'directory', entry: 'read',
    roles: { reviewer: { tools: ['read'], skills: [] }, orchestrator: { tools: [], skills: [] } },
    nodes: { read: { role: 'reviewer' }, summarize: { role: 'orchestrator' } },
    transitions: { read: { approve: 'summarize', changes: null }, summarize: { done: null } } };
  const sandbox = await fixture(t, definition, ({ prompt }) => {
    assert(prompt.includes('Inherited runtime test instructions'));
    return verdict(prompt.includes('Завершённые этапы workflow') ? 'done' : 'approve');
  }, true);
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.workspace.path, await realpath(sandbox.workspace));
  assert.equal((await readdir(sandbox.workspace)).includes('.git'), false);
  assert.equal(await readFile(join(sandbox.workspace, 'untouched.txt'), 'utf8'), 'Файлы проекта планнер не изменяет.\n');
});

test('public CLI rejects stale approval from an earlier mandatory reviewer', { timeout: 60000 }, async t => {
  const definition = { task: 'Check every approval', entry: 'firstReview', merge: true,
    roles: { reviewer: { tools: [], skills: [] }, verifier: { tools: [], skills: [] }, worker: { tools: ['shell'], skills: [] } },
    nodes: { firstReview: { role: 'reviewer' }, work: { role: 'worker', instructions: 'change-file' },
      lastReview: { role: 'reviewer' }, verify: { role: 'verifier' } },
    transitions: { firstReview: { approve: 'work', changes: 'work' }, work: { done: 'lastReview' },
      lastReview: { approve: 'verify', changes: 'work' }, verify: { approve: null, changes: 'work' } } };
  const sandbox = await fixture(t, definition, ({ prompt, toolResults }) => {
    if (!prompt.includes('change-file')) return verdict();
    if (!toolResults.length) return { toolCalls: [{ name: 'shell', arguments: { command: 'printf changed > result.txt' } }] };
    return verdict('done');
  });
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /firstReview/);
  assert.equal((await readdir(sandbox.workspace)).includes('result.txt'), false);
});

test('steering reaches the selected participant in the same session before completion', { timeout: 60000 }, async t => {
  const definition = { task: 'Produce a result', entry: 'work',
    nodes: { work: { role: 'worker', tools: [], skills: [] }, finish: { role: 'orchestrator', tools: [], skills: [] } },
    transitions: { work: { done: 'finish' }, finish: { done: null } } };
  const sandbox = await fixture(t, definition, () => verdict('done'));
  const message = join(sandbox.root, 'steering.txt');
  await writeFile(message, 'Include the updated requirement');
  const first = await waitFor(async () => (await sandbox.events()).find(event => event.type === 'received'),
    10000, 'first model request');
  const queued = await sandbox.command(['steer', sandbox.runId, 'work', '--message-file', message]);
  assert.equal(queued.command.status, 'pending');
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(result.visits.map(visit => visit.node), ['work', 'work', 'finish']);
  assert.equal(result.visits[0].sessionId, result.visits[1].sessionId);
  const calls = (await sandbox.events()).filter(event => event.type === 'received');
  assert.equal(calls[1].providerSessionId, first.providerSessionId);
  assert(calls[1].prompt.includes('Include the updated requirement'));
  assert(!calls[2].prompt.includes('Уточнение пользователя для этого участника'));
  assert.equal(result.controls[0].status, 'applied');
});

test('stop interrupts a held session, persists cancellation and leaves other runs active', { timeout: 60000 }, async t => {
  const definition = { task: 'Wait for controlled completion', entry: 'work',
    nodes: { work: { role: 'worker', tools: [], skills: [] } }, transitions: { work: { done: null } } };
  const sandbox = await fixture(t, definition, () => verdict('done'));
  const file = join(sandbox.root, 'second.json');
  await writeJson(file, { ...definition, task: 'Independent second run' });
  const second = await sandbox.command(['start', '--file', file]);
  await waitFor(async () => (await sandbox.events()).filter(event => event.type === 'received').length === 2,
    10000, 'both model requests');
  const stopped = await sandbox.command(['stop', sandbox.runId]);
  assert.equal(stopped.status, 'cancelled');
  assert.equal((await sandbox.command(['stop', sandbox.runId])).status, 'cancelled');
  assert.equal(getWorkflow(sandbox.state, second.runId).status, 'running');
  await sandbox.release();
  const finished = await waitFor(() => {
    const state = getWorkflow(sandbox.state, second.runId);
    return state.status !== 'running' && state;
  }, 15000, 'independent completion');
  assert.equal(finished.status, 'succeeded', finished.error);
  assert.equal(getWorkflow(sandbox.state, sandbox.runId).status, 'cancelled');
});

test('stop waits for a SIGTERM-resistant native shell and its child before confirming cancellation', { timeout: 60000 }, async t => {
  const definition = { task: 'Controlled resistant shell stop', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: ['shell'], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, ({ toolResults }) => {
    if (toolResults.length) return verdict();
    return { toolCalls: [{ name: 'shell', arguments: {
      command: `trap '' TERM; echo $$ > '${sandbox.root}/shell.pid'; while :; do echo tick >> '${sandbox.root}/heartbeat'; sleep 0.05; done`,
      background: true,
    } }] };
  }, true);
  await waitFor(async () => (await sandbox.events()).some(event => event.type === 'received'), 10000, 'first request');
  const first = (await sandbox.events()).find(event => event.type === 'received');
  await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [first.callId] });
  await waitFor(async () => (await sandbox.events()).filter(event => event.type === 'received').length >= 2,
    10000, 'background shell');
  const pid = Number(await readFile(join(sandbox.root, 'shell.pid'), 'utf8'));
  process.kill(pid, 0);
  assert.equal((await sandbox.command(['stop', sandbox.runId])).status, 'cancelled');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const heartbeat = await readFile(join(sandbox.root, 'heartbeat'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await readFile(join(sandbox.root, 'heartbeat'), 'utf8'), heartbeat);
  assert.equal((await sandbox.command(['stop', sandbox.runId])).status, 'cancelled');
});

test('explicit participant settings ignore an unused global model and reasoning', { timeout: 60000 }, async t => {
  const definition = { task: 'Use the explicit model', workspace: 'directory', entry: 'review',
    nodes: { review: { role: 'reviewer', tools: [], skills: [], reasoning: null,
      model: { provider: 'dwf-acceptance', modelId: 'alternate' } } },
    transitions: { review: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, () => verdict(), true, {
    DWF_PLANNER_MODEL: JSON.stringify({ provider: 'missing', modelId: 'unused' }),
    DWF_PLANNER_REASONING: 'unused-invalid',
  });
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  const calls = (await sandbox.events()).filter(event => event.type === 'received');
  assert(calls.every(call => call.model.modelId === 'alternate' && call.reasoning === undefined));
});
