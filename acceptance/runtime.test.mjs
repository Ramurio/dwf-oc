import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { createSandbox, cliJson, transcript, waitFor, writeJson, taggedProcesses } from './harness.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { getWorkflow } from '../run-store.mjs';
import { captureStopSessions, outcomeFromMessages, readExecution, stopSessions } from '../opencode-runtime.mjs';
import { inspectTester } from './tester.mjs';

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

test('native reviewer reads the supplied full diff with its scoped permission', { timeout: 60000 }, async t => {
  const definition = { task: 'Review an actual file change', entry: 'work',
    nodes: { work: { role: 'worker', tools: ['shell'], skills: [], instructions: 'stage=work' },
      review: { role: 'reviewer', tools: ['read'], skills: [], instructions: 'stage=review' },
      verify: { role: 'verifier', tools: [], skills: [] } },
    transitions: { work: { done: 'review' }, review: { approve: 'verify', changes: null },
      verify: { approve: null, changes: null } } };
  let observedDiff = false;
  const sandbox = await fixture(t, definition, ({ prompt, toolResults }) => {
    if (prompt.includes('stage=work')) return toolResults.length ? verdict('done') : {
      toolCalls: [{ name: 'shell', arguments: { command: 'printf reviewed-change > result.txt' } }],
    };
    if (prompt.includes('stage=review')) {
      const review = JSON.parse(prompt.match(/Материалы ревью[^\n]*\n([^\n]+)/)[1]);
      assert.match(review.path, /^\.\.\/reviews\/[^/]+\.diff$/);
      if (!toolResults.length) return { toolCalls: [{ name: 'read', arguments: { path: review.path } }] };
      assert.match(toolResults.join('\n'), /\+reviewed-change/);
      observedDiff = true;
    }
    return verdict();
  });
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(observedDiff, true);
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
    DWF_PLANNER_MODEL: 'not JSON',
    DWF_PLANNER_REASONING: 'unused-invalid',
  });
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  const calls = (await sandbox.events()).filter(event => event.type === 'received');
  assert(calls.every(call => call.model.modelId === 'alternate' && call.reasoning === undefined));
});

test('a live background verifier cannot approve files before its command finishes', { timeout: 60000 }, async t => {
  const definition = { task: 'Check background completion', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: ['shell'], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, ({ toolResults }) => toolResults.length ? verdict() : {
    toolCalls: [{ name: 'shell', arguments: { command: 'sleep 2; printf CHANGED > untouched.txt', background: true } }],
  }, true);
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /изменил рабочее дерево/);
  assert.equal(await readFile(join(sandbox.workspace, 'untouched.txt'), 'utf8'), 'CHANGED');
});

test('a resumed background verifier supersedes its initial approval', { timeout: 60000 }, async t => {
  const definition = { task: 'Verify the background command result', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: ['shell'], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  let replies = 0;
  const sandbox = await fixture(t, definition, () => {
    replies++;
    if (replies === 1) return {
      toolCalls: [{ name: 'shell', arguments: { command: 'sleep 2; exit 1', background: true } }],
    };
    return verdict(replies === 2 ? 'approve' : 'changes');
  }, true);
  const calls = () => sandbox.events().then(events => events.filter(event => event.type === 'received'));
  const first = await waitFor(async () => (await calls())[0], 10000, 'initial verifier request');
  await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [first.callId] });
  const second = await waitFor(async () => (await calls())[1], 10000, 'early approval request');
  await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [first.callId, second.callId] });
  await waitFor(async () => (await calls())[2], 15000, 'background completion continuation');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(getWorkflow(sandbox.state, sandbox.runId).status, 'running');
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'failed');
  assert.equal(result.visits[0].verdict.outcome, 'changes');
});

test('native completion during an activity request cannot return an older approval', { timeout: 60000 }, async t => {
  const definition = { task: 'Observe a moving native completion', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: ['shell'], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  let replies = 0;
  const sandbox = await fixture(t, definition, () => {
    if (++replies === 1) return {
      toolCalls: [{ name: 'shell', arguments: { command: 'sleep 3; exit 1', background: true } }],
    };
    return verdict(replies === 2 ? 'approve' : 'changes');
  }, true);
  const endpoint = await Service.discover({ file: join(sandbox.state, 'opencode/state/opencode/service.json') });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const state = getWorkflow(sandbox.state, sandbox.runId);
  const visit = state.visits[0];
  const latest = async () => outcomeFromMessages((await client.message.list({
    sessionID: visit.sessionId, limit: 100, order: 'asc',
  })).data, visit.inputId);
  await sandbox.release();
  await waitFor(async () => (await latest())?.result.includes('approve'), 10000, 'early native approval');
  const controller = taggedProcesses(sandbox.token).find(item =>
    execFileSync('ps', ['-p', String(item.pid), '-o', 'command='], { encoding: 'utf8' }).includes('workflow-runtime.mjs'));
  assert(controller);
  process.kill(controller.pid, 'SIGKILL');
  const delayed = { message: client.message, shell: client.shell, session: {
    inbox: client.session.inbox,
    active: async () => {
      await waitFor(async () => (await latest())?.result.includes('changes'), 10000, 'late native changes');
      return client.session.active();
    },
  } };
  const request = { sessionId: visit.sessionId, inputId: visit.inputId,
    request: { session: { location: { directory: state.workspace.path } } } };
  const attempt = { id: 'activity-race', sessionId: visit.sessionId, inputId: visit.inputId,
    directory: sandbox.root, workspace: state.workspace.path };
  const [execution, tester] = await Promise.all([
    readExecution(delayed, request), inspectTester(delayed, attempt),
  ]);
  assert.equal(execution.outcome, undefined);
  assert.equal(tester.status, 'running');
  assert.match((await readExecution(client, request)).outcome.result, /changes/);
  assert.equal(JSON.parse((await inspectTester(client, attempt)).report).outcome, 'changes');
  const db = new DatabaseSync(join(sandbox.state, 'dwf.sqlite'));
  db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(sandbox.runId);
  db.close();
  await sandbox.command(['inspect', sandbox.runId]);
  const result = await sandbox.finish();
  assert.equal(result.status, 'failed');
  assert.equal(result.visits[0].verdict.outcome, 'changes');
});

test('public CLI retains literal code fences inside a fenced verdict', { timeout: 60000 }, async t => {
  const definition = { task: 'Return a literal code fence in the summary', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: [], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const result = { outcome: 'approve', summary: 'Checked code example ```js\nconst x = { ok: true };\n```' };
  const sandbox = await fixture(t, definition, () => `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``);
  await sandbox.release();
  const state = await sandbox.finish();
  assert.equal(state.status, 'succeeded', state.error);
  assert.deepEqual(state.visits[0].verdict, result);
});

test('stop catches a resistant shell created after the initial process snapshot', { timeout: 60000 }, async t => {
  const definition = { task: 'Stop a late shell', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: [], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, () => verdict(), true);
  const endpoint = await Service.discover({ file: join(sandbox.state, 'opencode/state/opencode/service.json') });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const state = getWorkflow(sandbox.state, sandbox.runId);
  await captureStopSessions(client, state);
  assert.equal(state.stopShells.length, 0);
  const sessionID = state.visits[0].sessionId;
  await client.shell.create({ location: { directory: state.workspace.path }, metadata: { sessionID },
    command: `trap '' TERM; echo $$ > '${sandbox.root}/late.pid'; while :; do sleep 0.1; done` });
  await waitFor(async () => readFile(join(sandbox.root, 'late.pid'), 'utf8').catch(() => false), 5000, 'late shell');
  const pid = Number(await readFile(join(sandbox.root, 'late.pid'), 'utf8'));
  await stopSessions(client, state);
  await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, 1000, 'native shell reaped');
});

test('fixed groups run concurrently and recover without repeating completed members', { timeout: 60000 }, async t => {
  const definition = { task: 'Collect two independent reviews', workspace: 'directory', entry: 'reviews',
    nodes: { left: { role: 'reviewer', tools: [], skills: [], instructions: 'member=left' },
      right: { role: 'reviewer', tools: [], skills: [], instructions: 'member=right' },
      summary: { role: 'orchestrator', tools: [], skills: [], instructions: 'member=summary' } },
    groups: { reviews: { members: ['left', 'right'] } },
    transitions: { reviews: { done: 'summary', changes: null, failed: null },
      left: { approve: 'summary', changes: null }, right: { approve: 'summary', changes: null }, summary: { done: null } } };
  const sandbox = await fixture(t, definition, ({ prompt }) => {
    if (prompt.includes('member=summary')) {
      assert(prompt.includes('"participant":"left"'));
      assert(prompt.includes('"participant":"right"'));
      return verdict('done');
    }
    return verdict();
  }, true);
  const calls = await waitFor(async () => {
    const calls = (await sandbox.events()).filter(event => event.type === 'received');
    return calls.length === 2 && calls;
  }, 10000, 'both concurrent members');
  const left = calls.find(call => call.prompt.includes('member=left'));
  await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [left.callId] });
  await waitFor(() => getWorkflow(sandbox.state, sandbox.runId).visits[0].children[0].verdict,
    10000, 'persisted first member');
  const controller = taggedProcesses(sandbox.token).find(item =>
    execFileSync('ps', ['-p', String(item.pid), '-o', 'command='], { encoding: 'utf8' }).includes('workflow-runtime.mjs'));
  assert(controller);
  process.kill(controller.pid, 'SIGKILL');
  const db = new DatabaseSync(join(sandbox.state, 'dwf.sqlite'));
  db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(sandbox.runId);
  db.close();
  await sandbox.command(['inspect', sandbox.runId]);
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(result.visits.map(visit => visit.node), ['reviews', 'summary']);
  const finalCalls = (await sandbox.events()).filter(event => event.type === 'received');
  assert.equal(finalCalls.filter(call => call.prompt.includes('member=left')).length, 1);
  assert.equal(finalCalls.filter(call => call.prompt.includes('member=summary')).length, 1);
  assert.equal(result.visits[0].verdict.results.length, 2);
});

test('map groups use runtime items, isolate writers and merge their complete result', { timeout: 60000 }, async t => {
  const definition = { task: 'Write each discovered item to its own file', entry: 'plan', merge: true,
    nodes: { plan: { role: 'orchestrator', tools: [], skills: [], instructions: 'member=plan' },
      write: { role: 'worker', tools: ['shell'], skills: [], instructions: 'member=write' },
      review: { role: 'reviewer', tools: [], skills: [], instructions: 'member=review' },
      verify: { role: 'verifier', tools: ['shell'], skills: [], instructions: 'member=verify' } },
    groups: { files: { member: 'write', itemsFrom: 'plan' } },
    transitions: { plan: { done: 'files' }, files: { done: 'review', changes: null, failed: null },
      write: { done: 'review' }, review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, ({ prompt, toolResults }) => {
    if (prompt.includes('member=plan')) return JSON.stringify({ outcome: 'done', summary: 'Found two items', items: [{ id: 'alpha' }, { id: 'beta' }] });
    if (prompt.includes('member=write')) {
      const name = JSON.parse(prompt.split('Элемент параллельной группы:\n').at(-1)).id;
      return toolResults.length ? verdict('done') : { toolCalls: [{ name: 'shell', arguments: { command: `printf '${name}' > ${name}.txt` } }] };
    }
    if (prompt.includes('member=verify') && !toolResults.length) {
      return { toolCalls: [{ name: 'shell', arguments: { command: 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta' } }] };
    }
    return verdict();
  });
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  const group = result.visits.find(visit => visit.node === 'files');
  assert.deepEqual(group.children.map(child => child.participant), ['files/alpha', 'files/beta']);
  assert.notEqual(group.children[0].workspace.path, group.children[1].workspace.path);
  assert.notEqual(group.children[0].sessionId, group.children[1].sessionId);
  assert.equal(await readFile(join(sandbox.workspace, 'alpha.txt'), 'utf8'), 'alpha');
  assert.equal(await readFile(join(sandbox.workspace, 'beta.txt'), 'utf8'), 'beta');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: sandbox.workspace, encoding: 'utf8' }), '');
});

test('writer group recovers after read-tree succeeds and its controller crashes', { timeout: 60000 }, async t => {
  const bin = await mkdtemp(join(tmpdir(), 'dwf-group-crash-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const marker = join(bin, 'crashed');
  const wrapper = join(bin, 'git');
  await writeFile(wrapper, `#!/bin/sh
/usr/bin/git "$@"
result=$?
if [ "$result" -eq 0 ] && [ "$1 $2 $3" = "read-tree --reset -u" ] && [ ! -e "$DWF_GROUP_CRASH_MARKER" ]; then
  : > "$DWF_GROUP_CRASH_MARKER"
  kill -KILL "$PPID"
fi
exit "$result"
`);
  await chmod(wrapper, 0o700);
  const definition = { task: 'Integrate parallel files after recovery', entry: 'seed', merge: true,
    nodes: { seed: { role: 'worker', tools: ['shell'], skills: [], instructions: 'member=seed' },
      left: { role: 'worker', tools: ['shell'], skills: [], instructions: 'member=left' },
      right: { role: 'worker', tools: ['shell'], skills: [], instructions: 'member=right' },
      review: { role: 'reviewer', tools: [], skills: [] }, verify: { role: 'verifier', tools: [], skills: [] } },
    groups: { files: { members: ['left', 'right'] } },
    transitions: { seed: { done: 'files' }, files: { done: 'review', changes: null, failed: null }, left: { done: 'review' },
      right: { done: 'review' }, review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, ({ prompt, toolResults }) => {
    const member = prompt.includes('member=seed') ? 'seed' :
      prompt.includes('member=left') ? 'left' : prompt.includes('member=right') ? 'right' : undefined;
    if (!member) return verdict();
    const command = member === 'seed' ? 'printf temporary > temporary.txt' :
      (member === 'left' ? 'rm temporary.txt; ' : '') + `printf ${member} > ${member}.txt`;
    return toolResults.length ? verdict('done') : {
      toolCalls: [{ name: 'shell', arguments: { command } }],
    };
  }, false, { PATH: bin + ':' + process.env.PATH, DWF_GROUP_CRASH_MARKER: marker });
  await sandbox.release();
  await waitFor(() => readFile(marker).catch(() => false), 10000, 'controller crash after read-tree');
  const db = new DatabaseSync(join(sandbox.state, 'dwf.sqlite'));
  db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(sandbox.runId);
  db.close();
  await sandbox.command(['inspect', sandbox.runId]);
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(await readFile(join(sandbox.workspace, 'left.txt'), 'utf8'), 'left');
  assert.equal(await readFile(join(sandbox.workspace, 'right.txt'), 'utf8'), 'right');
  await assert.rejects(readFile(join(sandbox.workspace, 'temporary.txt')), { code: 'ENOENT' });
  assert.equal(result.visits.filter(visit => visit.node === 'files').length, 1);
  for (const child of result.visits.find(visit => visit.node === 'files').children) {
    const calls = (await sandbox.events()).filter(event => event.type === 'received' &&
      event.providerSessionId === child.sessionId);
    assert.equal(calls.length, 2);
  }
});

test('group reports retain optional branch failures and stop cancels every active member', { timeout: 60000 }, async t => {
  const definition = { task: 'Collect independent optional feedback', workspace: 'directory', entry: 'reviews',
    nodes: { requiredReview: { role: 'reviewer', tools: [], skills: [], instructions: 'member=required' },
      advisory: { role: 'reviewer', required: false, tools: [], skills: [], instructions: 'member=advisory' },
      summary: { role: 'orchestrator', tools: [], skills: [] } },
    groups: { reviews: { members: ['requiredReview', 'advisory'], required: ['requiredReview'] } },
    transitions: { reviews: { done: 'summary', changes: null, failed: null },
      requiredReview: { approve: 'summary', changes: null }, advisory: { approve: 'summary', changes: null }, summary: { done: null } } };
  const sandbox = await fixture(t, definition, ({ prompt }) => {
    if (prompt.includes('member=advisory')) return 'invalid JSON';
    return verdict(prompt.includes('Завершённые этапы workflow') ? 'done' : 'approve');
  }, true);
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.visits[0].verdict.results[1].status, 'failed');
  await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [] });
  const second = await sandbox.command(['start', '--file', join(sandbox.root, 'workflow.json')]);
  assert.equal((await sandbox.command(['stop', second.runId])).status, 'cancelled');
  const stopped = getWorkflow(sandbox.state, second.runId);
  assert.equal(stopped.controls[0].status, 'applied');
});

test('a terminal group failure preserves every result and fails the workflow', { timeout: 60000 }, async t => {
  const definition = { task: 'Collect required work', entry: 'work',
    nodes: { first: { role: 'worker', tools: [], skills: [], instructions: 'member=first' },
      second: { role: 'worker', tools: [], skills: [], instructions: 'member=second' } },
    groups: { work: { members: ['first', 'second'] } },
    transitions: { work: { done: null, changes: null, failed: null }, first: { done: null }, second: { done: null } } };
  const sandbox = await fixture(t, definition, ({ prompt }) => prompt.includes('member=first') ? 'invalid JSON' : verdict('done'));
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'failed');
  assert.equal(result.result.outcome, 'failed');
  assert.equal(result.result.results.length, 2);
  assert.equal(result.result.results[0].status, 'failed');
  assert.equal(result.result.results[1].status, 'completed');
});

test('steering a mapped participant preserves its own context after the group settles', { timeout: 60000 }, async t => {
  const definition = { task: 'Revisit one parallel item', entry: 'jobs',
    nodes: { write: { role: 'worker', tools: [], skills: [], memory: false, instructions: 'member=write' },
      summary: { role: 'orchestrator', tools: [], skills: [], instructions: 'member=summary' } },
    groups: { jobs: { member: 'write', items: [{ id: 'alpha' }, { id: 'beta' }] } },
    transitions: { jobs: { done: 'summary', changes: null, failed: null }, write: { done: 'summary' }, summary: { done: null } } };
  const sandbox = await fixture(t, definition, () => verdict('done'));
  await waitFor(async () => (await sandbox.events()).filter(event => event.type === 'received').length === 2,
    10000, 'parallel requests before steering');
  const file = join(sandbox.root, 'refinement.txt');
  await writeFile(file, 'Clarify only alpha');
  await sandbox.command(['steer', sandbox.runId, 'jobs/alpha', '--message-file', file]);
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(result.visits.map(visit => visit.node), ['jobs', 'write', 'summary']);
  assert.equal(result.visits[0].children[0].sessionId, result.visits[1].sessionId);
  assert(result.visits[1].prompt.includes('Clarify only alpha'));
  assert.equal(result.controls[0].status, 'applied');
});
