import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { createSandbox, cliJson, transcript, waitFor, within, writeJson, readJson, taggedProcesses, launch } from './harness.mjs';
import { installAdmissionFault } from './admission-faults.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { claimWorkflow, createWorkflow, getWorkflow, updateWorkflow } from '../run-store.mjs';
import { prepareGroup } from '../workflow-groups.mjs';
import { captureStopSessions, checkModel, outcomeFromMessages, readExecution, stopSessions } from '../opencode-runtime.mjs';
import { inspectTester } from './tester.mjs';
import { validateWorkflow, participantSettings, validateItems } from '../workflow-definition.mjs';
import { researchGraph, validateScientistVerdict } from '../research-workflow.mjs';
import roleToolsPlugin from '../opencode-tools.mjs';

const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const verdict = (outcome = 'approve') => JSON.stringify({ outcome, summary: `Observed ${outcome}` });

async function researchDefinition() {
  return JSON.parse(await readFile(new URL('../workflows/research-mid.json', import.meta.url), 'utf8'));
}

test('research-mid validates its structure and defaults to standard Sol in every role', async () => {
  const definition = await researchDefinition();
  assert.deepEqual(validateWorkflow(definition), definition);
  for (const node of Object.keys(definition.nodes)) {
    const settings = participantSettings(definition, node);
    assert.deepEqual(settings.model, { provider: 'openai', modelId: 'gpt-6.1-sol' });
    assert.equal(settings.reasoning, 'high');
  }
  for (const change of [
    value => { value.nodes.scientist.memory = false; },
    value => { value.nodes.committee.memory = true; },
    value => { value.transitions.researchers.done = 'committee'; },
    value => { value.groups.scouts.itemsFrom = 'committee'; },
  ]) {
    const value = structuredClone(definition);
    change(value);
    assert.throws(() => validateWorkflow(value), /Workflow:/);
  }
});

test('research-mid rejects missing assignments and a fourth round before admission', async () => {
  const graph = researchGraph(await researchDefinition());
  const reject = message => { throw new Error(message); };
  const oneAssignment = [{ id: 'one', instructions: 'One task' }];
  assert.throws(() => validateScientistVerdict(graph, [], { outcome: 'scout', items: oneAssignment },
    validateItems, reject), /двум скаутам/);
  const rounds = Array.from({ length: 3 }, () => ({ node: graph.researchers, verdict: { outcome: 'done' } }));
  assert.throws(() => validateScientistVerdict(graph, rounds, { outcome: 'research' },
    validateItems, reject), /недопустимый/);
  validateScientistVerdict(graph, rounds, { outcome: 'report' }, validateItems, reject);
});

function expireWorkflowLease(sandbox) {
  const db = new DatabaseSync(join(sandbox.state, 'dwf.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(sandbox.runId);
  } finally { db.close(); }
}

async function fixture(t, definition, reply, directory = false, overrides = {}, faultOptions) {
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
  const fault = faultOptions && installAdmissionFault(sandbox, faultOptions.boundary, faultOptions.index);
  const start = sandbox.spawn(cli, ['start', '--file', file]);
  let run;
  if (fault && fault.boundary !== 'observe') {
    const marker = await waitFor(() => readJson(fault.marker), 20000, `native admission fault: ${fault.boundary}`);
    run = { runId: marker.id };
    if (fault.boundary !== 'lost_response') {
      assert.deepEqual(await within(start.exit, 5000, 'start observes controller crash'), { code: 1, signal: null });
      await within(start.close, 5000, 'crashed start closes');
      assert(start.stderr.includes(run.runId), 'Failed start must retain the original runId');
    }
  } else run = await cliJson(start, 20000);
  const events = () => transcript(join(sandbox.control, 'provider.jsonl'));
  return { ...sandbox, runId: run.runId, events, start, fault,
    command: args => cliJson(sandbox.spawn(cli, args), 20000),
    release: () => writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, all: true }),
    finish: () => waitFor(async () => {
      const state = getWorkflow(sandbox.state, run.runId);
      return state.status !== 'running' && state;
    }, 30000, 'workflow completion'),
  };
}

test('different DWF state roots use the same native OpenCode profile and service', { timeout: 60000 }, async t => {
  const definition = { task: 'Use the shared native profile', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: [], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, () => verdict(), true);
  const first = getWorkflow(sandbox.state, sandbox.runId);
  const secondRoot = join(sandbox.root, 'another-state');
  await mkdir(secondRoot);
  sandbox.env.DWF_STATE_DIR = secondRoot;
  let started;
  try { started = await sandbox.command(['start', '--file', join(sandbox.root, 'workflow.json')]); }
  finally { sandbox.env.DWF_STATE_DIR = sandbox.state; }
  const second = getWorkflow(secondRoot, started.runId);
  assert.deepEqual(second.opencode, first.opencode);
  assert.equal(first.opencode.registration, join(sandbox.env.XDG_STATE_HOME, 'opencode/service.json'));
  assert.equal(first.opencode.configDirectory, sandbox.env.OPENCODE_CONFIG_DIR);
  assert.notEqual(first.visits[0].sessionId, second.visits[0].sessionId);
  await sandbox.release();
  assert.equal((await sandbox.finish()).status, 'succeeded');
  const final = await waitFor(() => {
    const state = getWorkflow(secondRoot, started.runId);
    return state.status !== 'running' && state;
  }, 30000, 'second workflow on the shared native service');
  assert.equal(final.status, 'succeeded', final.error);
});

test('model preflight distinguishes missing, disabled and unsupported reasoning without substitution', async () => {
  const selected = { provider: 'openai', modelId: 'gpt-6.1-sol-ultrafast' };
  let data = [];
  const client = { model: { list: async () => ({ data }) } };
  await assert.rejects(checkModel(client, '/project', selected, 'xhigh'), /openai\/gpt-6.1-sol-ultrafast.*opencode models/);
  data = [{ providerID: selected.provider, id: selected.modelId, enabled: false, variants: [] }];
  await assert.rejects(checkModel(client, '/project', selected, 'xhigh'), /отключена.*opencode auth list/);
  data[0].enabled = true;
  data[0].variants = [{ id: 'high' }];
  await assert.rejects(checkModel(client, '/project', selected, 'xhigh'), /reasoning xhigh.*high/);
  data[0].variants.push({ id: 'xhigh' });
  assert.deepEqual(await checkModel(client, '/project', selected, 'xhigh'),
    { providerID: selected.provider, id: selected.modelId, variant: 'xhigh' });
});

test('the shared profile keeps interactive tools and filters aliases only in DWF sessions', async () => {
  let hook;
  await roleToolsPlugin.setup({ session: { hook: async (name, callback) => {
    assert.equal(name, 'context');
    hook = callback;
  } } });
  const interactive = { agent: 'build', tools: { edit: {}, opencode_worktree_remove: {} } };
  hook(interactive);
  assert.deepEqual(Object.keys(interactive.tools), ['edit', 'opencode_worktree_remove']);
  const dwf = { agent: 'dwf-worker-0123456789abcdef', tools: { edit: {}, opencode_worktree_remove: {} } };
  hook(dwf);
  assert.deepEqual(Object.keys(dwf.tools), ['edit']);
});

test('a saved planner from the previous DWF profile resumes in its original OpenCode database',
  { timeout: 60000 }, async t => {
    const sandbox = await createSandbox();
    const provider = await createControlledHttpProvider({ directory: sandbox.control, token: sandbox.token,
      reply: () => 'Legacy planner resumed.' });
    t.after(async () => { await provider.close(); await sandbox.cleanup(); });
    const config = join(sandbox.root, 'provider.json');
    await writeJson(config, nativeProviderConfig(provider.baseURL));
    Object.assign(sandbox.env, { OPENCODE_CONFIG: config, OPENCODE_DISABLE_MODELS_FETCH: 'true' });
    const bootstrap = join(sandbox.root, 'legacy.mjs');
    await writeFile(bootstrap, `
      import { randomUUID } from 'node:crypto';
      import { connect, checkModel, sessionRequest } from ${JSON.stringify(new URL('../opencode-runtime.mjs', import.meta.url).href)};
      import { createRun } from ${JSON.stringify(new URL('../run-store.mjs', import.meta.url).href)};
      const root = process.env.DWF_STATE_DIR;
      const client = await connect(root, undefined, { profile: 'legacy' });
      const model = await checkModel(client, process.cwd(), { provider: 'dwf-acceptance', modelId: 'planner' }, 'high');
      const id = randomUUID();
      createRun(root, { id, sessionId: 'ses_' + randomUUID(), inputId: 'msg_' + randomUUID(),
        request: sessionRequest(process.cwd(), model, id, 'Resume this saved planner.') });
      console.log(JSON.stringify({ runId: id }));
    `);
    const { runId } = await cliJson(sandbox.spawn([process.execPath, bootstrap]), 20000);
    assert.equal((await cliJson(sandbox.spawn(cli, ['inspect', runId]), 20000)).status, 'running');
    await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, all: true });
    const final = await waitFor(async () => {
      const result = await cliJson(sandbox.spawn(cli, ['inspect', runId]), 20000);
      return result.status !== 'running' && result;
    }, 20000, 'legacy planner completion');
    assert.equal(final.status, 'succeeded', final.error);
    assert.equal(final.result, 'Legacy planner resumed.');
  });

for (const approve of [true, false]) {
  test(`research-mid returns the exact report on ${approve ? 'approval' : 'exhaustion of its shared round limit'}`,
    { timeout: 60000 }, async t => {
      const definition = await researchDefinition();
      definition.task = 'Compare the documented conditions of the methods.';
      definition.nodes.scientist.instructions = 'scientist-only-note';
      definition.nodes.committee.instructions = 'committee-only-note';
      for (const node of Object.values(definition.nodes)) {
        node.model = { provider: 'dwf-acceptance', modelId: 'planner' };
      }
      const items = ids => ids.map(id => ({ id, instructions: `Investigate ${id}` }));
      const sandbox = await fixture(t, definition, ({ prompt }) => {
        if (prompt.includes('Элемент параллельной группы:')) {
          const item = JSON.parse(prompt.split('Элемент параллельной группы:\n').at(-1));
          return JSON.stringify({ outcome: 'done', summary: `Evidence for ${item.id}` });
        }
        if (prompt.startsWith('Original research request\n')) return verdict(approve ? 'approve' : 'changes');
        const rounds = Number(prompt.match(/Completed research rounds: (\d+)/)[1]);
        if (prompt.includes('Allowed outcomes this turn: scout')) {
          return JSON.stringify({ outcome: 'scout', summary: 'Two source maps', items: items(['foundations', 'recent']) });
        }
        const batch = prompt.includes('Evidence for branch-a');
        if (batch && (rounds === 1 || rounds === 3)) {
          return JSON.stringify({ outcome: 'report', summary: `Exact report for round ${rounds}.` });
        }
        if (rounds === 1 && !prompt.includes('DWF needs a corrected JSON response')) {
          return JSON.stringify({ outcome: 'research', summary: 'Only two assignments',
            items: items(['branch-a', 'branch-b']) });
        }
        return JSON.stringify({ outcome: 'research', summary: 'Four questions',
          items: items(['branch-a', 'branch-b', 'branch-c', 'branch-d']) });
      }, true);
      await sandbox.release();
      const result = await sandbox.finish();
      assert.equal(result.status, 'succeeded', result.error);
      assert.deepEqual(result.model, result.participants.scientist.model);
      assert.deepEqual(result.visits.map(visit => visit.node), approve ?
        ['scientist', 'scouts', 'scientist', 'researchers', 'scientist', 'committee'] :
        ['scientist', 'scouts', 'scientist', 'researchers', 'scientist', 'committee',
          'scientist', 'researchers', 'scientist', 'researchers', 'scientist', 'committee']);
      const scientist = result.visits.filter(visit => visit.node === 'scientist');
      const reviews = result.visits.filter(visit => visit.node === 'committee');
      const groups = result.visits.filter(visit => visit.children);
      assert.equal(new Set(scientist.map(visit => visit.sessionId)).size, 1);
      assert.equal(new Set(reviews.map(visit => visit.sessionId)).size, reviews.length);
      assert.deepEqual(groups.map(visit => visit.children.length), approve ? [2, 4] : [2, 4, 4, 4]);
      for (const group of groups) {
        const prompt = result.visits[result.visits.indexOf(group) + 1].prompt;
        for (const child of group.children) {
          assert(prompt.includes(child.verdict.summary));
          assert(!child.prompt.includes('"items":'));
        }
      }
      const calls = (await sandbox.events()).filter(event => event.type === 'received');
      const corrections = calls.filter(event => event.prompt.startsWith('DWF needs a corrected JSON response'));
      assert.equal(corrections.length, approve ? 0 : 1);
      if (!approve) assert.equal(corrections[0].providerSessionId, scientist[0].sessionId);
      assert(calls.filter(event => scientist.some(visit => visit.sessionId === event.providerSessionId))
        .every(event => !JSON.stringify(event).includes('committee-only-note') &&
          !event.systemTexts.join('').includes('Review the submitted research report') &&
          !event.tools.some(tool => /read|shell|webfetch/.test(tool.function?.name))));
      for (const review of reviews) {
        const report = result.visits[result.visits.indexOf(review) - 1].verdict.summary;
        assert.equal(review.prompt, `Original research request\n${definition.task}\n\nSubmitted report\n${report}`);
      }
      const lastReport = scientist.at(-1).verdict.summary;
      assert.deepEqual(result.result, approve ? { outcome: 'approve', summary: lastReport } :
        { outcome: 'changes', summary: lastReport +
          '\n\n## Замечания комитета\n\nСтатус исследования — требуется доработка.\n\nObserved changes' });
    });
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

test('a completed run becomes a named preset with fresh sessions in another project', { timeout: 60000 }, async t => {
  const definition = { task: 'Original preset task', workspace: 'directory', entry: 'reviews',
    roles: { reviewer: { tools: [], skills: [] }, verifier: { tools: [], skills: [] },
      orchestrator: { tools: [], skills: [] } },
    nodes: { first: { role: 'reviewer' }, second: { role: 'reviewer', memory: false,
      model: { provider: 'dwf-acceptance', modelId: 'alternate' }, reasoning: 'low' },
      verify: { role: 'verifier' }, summary: { role: 'orchestrator' } },
    groups: { reviews: { members: ['first', 'second'] } },
    transitions: { reviews: { done: 'verify', changes: null, failed: null },
      first: { approve: 'verify', changes: null }, second: { approve: 'verify', changes: null },
      verify: { approve: 'summary', changes: null }, summary: { done: null } } };
  const sandbox = await fixture(t, definition, ({ prompt }) =>
    verdict(prompt.includes('Завершённые этапы workflow') ? 'done' : 'approve'), true);
  await sandbox.release();
  const original = await sandbox.finish();
  assert.equal(original.status, 'succeeded', original.error);
  const name = 'Двойное ревью';
  assert.deepEqual(await sandbox.command(['preset', 'save', name, '--from-run', sandbox.runId]), { preset: name });
  await rm(join(sandbox.root, 'workflow.json'));
  const project = join(sandbox.root, 'another-project');
  await mkdir(project);
  const task = 'A different task for the saved setup';
  const taskFile = join(sandbox.root, 'new-task.txt');
  await writeFile(taskFile, task);
  sandbox.env.DWF_PLANNER_MODEL = JSON.stringify({ provider: 'missing', modelId: 'missing' });
  sandbox.env.DWF_PLANNER_REASONING = 'missing';
  const replay = await cliJson(launch(cli, ['start', '--preset', name, '--task-file', taskFile], {
    cwd: project, env: sandbox.env,
  }), 20000);
  const result = await waitFor(() => {
    const state = getWorkflow(sandbox.state, replay.runId);
    return state.status !== 'running' && state;
  }, 30000, 'saved preset completion');
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.workspace.path, await realpath(project));
  assert.equal(result.definition.task, task);
  assert.deepEqual(result.definition.groups, definition.groups);
  assert.deepEqual(result.participants, original.participants);
  const previousSessions = new Set(Object.values(original.sessions));
  assert(Object.values(result.sessions).every(id => !previousSessions.has(id)));
  assert(result.visits.flatMap(visit => visit.children ?? [visit])
    .every(visit => !visit.prompt.includes(definition.task)));
  assert.equal((await sandbox.events()).filter(item => item.type === 'received').length, 8);
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
  assert.equal(result.error, 'Рабочее дерево изменилось во время проверки. Требуется новая проверка.');
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
  const endpoint = await Service.discover({ file: getWorkflow(sandbox.state, sandbox.runId).opencode.registration });
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
  expireWorkflowLease(sandbox);
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

test('public CLI preserves a plain verdict after a closed code block', { timeout: 60000 }, async t => {
  const definition = { task: 'Return a plain verdict after a code example', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: [], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const result = { outcome: 'approve', summary: 'Checked literal ``` text' };
  const sandbox = await fixture(t, definition, () => '```\nAn example.\n```\n' + JSON.stringify(result));
  await sandbox.release();
  const state = await sandbox.finish();
  assert.equal(state.status, 'succeeded', state.error);
  assert.deepEqual(state.visits[0].verdict, result);
});

test('public CLI rejects a repeated verdict inside an incomplete trailing object', { timeout: 60000 }, async t => {
  const definition = { task: 'Reject an incomplete duplicate verdict', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: [], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const json = '{"outcome":"approve","summary":"Checked"}';
  const sandbox = await fixture(t, definition, () => json + '\n{' + json);
  await sandbox.release();
  const state = await sandbox.finish();
  assert.equal(state.status, 'failed');
  assert.match(state.error, /неверный JSON/);
});

test('stop catches a resistant shell created after the initial process snapshot', { timeout: 60000 }, async t => {
  const definition = { task: 'Stop a late shell', workspace: 'directory', entry: 'verify',
    nodes: { verify: { role: 'verifier', tools: [], skills: [] } },
    transitions: { verify: { approve: null, changes: null } } };
  const sandbox = await fixture(t, definition, () => verdict(), true);
  const endpoint = await Service.discover({ file: getWorkflow(sandbox.state, sandbox.runId).opencode.registration });
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

test('native orchestrator receives a blocker, dispatches a correction and completes after checks', { timeout: 60000 }, async t => {
  const definition = { task: 'Resolve the implementation question through the workflow graph', entry: 'manager',
    nodes: { manager: { role: 'orchestrator', tools: [], skills: [], instructions: 'NATIVE_MANAGER' },
      work: { role: 'worker', tools: [], skills: [], instructions: 'NATIVE_WORK' },
      review: { role: 'reviewer', tools: [], skills: [], instructions: 'NATIVE_REVIEW' },
      verify: { role: 'verifier', tools: [], skills: [], instructions: 'NATIVE_VERIFY' } },
    transitions: { manager: { implement: 'work', recheck: 'review', done: null },
      work: { done: 'review', blocked: 'manager' }, review: { approve: 'verify', changes: 'work' },
      verify: { approve: 'manager', changes: 'work' } } };
  let decisions = 0;
  let attempts = 0;
  const sandbox = await fixture(t, definition, ({ prompt }) => {
    if (prompt.startsWith('NATIVE_MANAGER')) {
      decisions++;
      if (decisions === 2) assert.match(prompt, /Need an interface decision/);
      return JSON.stringify({ outcome: decisions < 3 ? 'implement' : 'done', summary: 'Keep the current interface' });
    }
    if (prompt.startsWith('NATIVE_WORK')) {
      if (attempts++) assert.match(prompt, /Keep the current interface/);
      return JSON.stringify({ outcome: attempts === 1 ? 'blocked' : 'done', summary: 'Need an interface decision' });
    }
    return verdict('approve');
  });
  await sandbox.release();
  const result = await sandbox.finish();
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(result.visits.map(visit => visit.node), ['manager', 'work', 'manager', 'work', 'review', 'verify', 'manager']);
  assert.equal(result.visits[1].verdict.outcome, 'blocked');
  assert.equal(result.visits[1].sessionId, result.visits[3].sessionId);
  assert.equal(result.visits[0].sessionId, result.visits[6].sessionId);
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
  expireWorkflowLease(sandbox);
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
  # Keep the controller transaction locked after the test observes the marker.
  sleep 1
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
  expireWorkflowLease(sandbox);
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

test('accepted map targets survive discarded preparation and native controller recovery', { timeout: 60000 }, async t => {
  const items = [{ id: 'alpha', detail: 'first' }, { id: 'beta', detail: 'second' }];
  const definition = { task: 'Recover queued mapped clarifications', workspace: 'directory', entry: 'jobs',
    nodes: { analyze: { role: 'orchestrator', tools: [], skills: [], memory: false },
      summary: { role: 'orchestrator', tools: [], skills: [] } },
    groups: { jobs: { member: 'analyze', items } },
    transitions: { jobs: { done: 'summary', changes: null, failed: null },
      analyze: { done: 'summary' }, summary: { done: null } } };
  const sandbox = await fixture(t, definition, () => verdict('done'), true);
  await sandbox.release();
  const bootstrap = await sandbox.finish();
  assert.equal(bootstrap.status, 'succeeded', bootstrap.error);
  await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [] });

  // Seed the persisted pre-admission boundary using the real prepared group and native configuration.
  const state = { ...bootstrap, id: randomUUID(), status: 'running', sessions: {}, visits: [] };
  delete state.result;
  delete state.finalizing;
  state.visits.push(prepareGroup(sandbox.state, state, 'jobs'));
  await mkdir(join(sandbox.state, 'workflows', state.id));
  createWorkflow(sandbox.state, state);
  assert.equal(claimWorkflow(sandbox.state, state.id, 'prepare-test'), true);
  const message = join(sandbox.root, 'clarification.txt');
  for (const [target, text] of [['summary', 'Visit the external node first'],
    ...items.map(item => [`jobs/${item.id}`, `Clarify ${item.id}`])]) {
    await writeFile(message, text);
    const queued = await sandbox.command(['steer', state.id, target, '--message-file', message]);
    assert.equal(queued.command.status, 'pending');
  }
  updateWorkflow(sandbox.state, state, 'prepare-test', true);
  await sandbox.command(['inspect', state.id]);
  await waitFor(async () => (await sandbox.events()).some(event => event.type === 'received' &&
    event.prompt.includes('Visit the external node first')), 10000, 'first queued native request');
  const saved = getWorkflow(sandbox.state, state.id);
  assert.deepEqual(saved.controls.slice(1).map(command => command.target.item), items);
  assert.deepEqual(saved.visits.map(visit => visit.node), ['summary']);
  const controller = taggedProcesses(sandbox.token).find(item =>
    execFileSync('ps', ['-p', String(item.pid), '-o', 'command='], { encoding: 'utf8' }).includes(state.id));
  assert(controller);
  process.kill(controller.pid, 'SIGKILL');
  expireWorkflowLease({ state: sandbox.state, runId: state.id });
  const resumed = await sandbox.command(['inspect', state.id]);
  assert(resumed.controls.every(command => !Object.hasOwn(command, 'target')));
  await sandbox.release();
  const result = await waitFor(() => {
    const current = getWorkflow(sandbox.state, state.id);
    return current.status !== 'running' && current;
  }, 30000, 'recovered queued clarifications');
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(result.visits.map(visit => visit.node), ['summary', 'analyze', 'analyze', 'summary']);
  assert.deepEqual(result.visits.filter(visit => visit.node === 'analyze').map(visit => visit.item), items);
  assert.deepEqual(result.controls.map(command => command.status), ['applied', 'applied', 'applied']);
  const calls = (await sandbox.events()).filter(event => event.type === 'received' &&
    result.visits.some(visit => visit.sessionId === event.providerSessionId));
  assert.equal(calls.length, 4);
  for (const item of items) {
    const call = calls.find(event => event.prompt.includes(`Clarify ${item.id}`));
    assert(call.prompt.includes(JSON.stringify(item)));
  }
});

function admissionDefinition(kind) {
  const node = { role: 'orchestrator', tools: [], skills: [] };
  return { task: 'Preserve admission bytes: Юникод\nsecond line  ', workspace: 'directory',
    entry: kind === 'single' ? 'left' : 'jobs',
    nodes: { left: node, ...(kind === 'fixed' ? { right: node } : {}), summary: node },
    ...(kind === 'single' ? {} : { groups: { jobs: kind === 'fixed' ? { members: ['left', 'right'] } :
      { member: 'left', items: [{ id: 'alpha', detail: 'Первый' }, { id: 'beta', detail: 'Second' }] } } }),
    transitions: { left: { done: 'summary' }, ...(kind === 'fixed' ? { right: { done: 'summary' } } : {}),
      ...(kind === 'single' ? {} : { jobs: { done: 'summary', changes: null, failed: null } }), summary: { done: null } } };
}

async function assertAdmissionHistory(sandbox, result) {
  const inputs = result.visits.flatMap(visit => visit.children ?? [visit]);
  const calls = await transcript(sandbox.fault.calls);
  const events = (await sandbox.events()).filter(event => event.type === 'received');
  const endpoint = await Service.discover({ file: result.opencode.registration });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  for (const sessionID of new Set(inputs.map(input => input.sessionId))) {
    const messages = (await client.message.list({ sessionID, limit: 100, order: 'asc' })).data;
    const users = messages.filter(message => message.type === 'user');
    const saved = inputs.filter(input => input.sessionId === sessionID);
    assert.deepEqual(users.map(message => message.id), saved.map(input => input.inputId));
    for (const [index, input] of saved.entries()) {
      const text = users[index].text;
      assert.deepEqual(Buffer.from(text), Buffer.from(input.prompt), 'Native history must preserve the saved request bytes');
      const attempts = calls.filter(call => call.inputId === input.inputId);
      assert(attempts.length);
      for (const attempt of attempts) {
        assert.equal(attempt.sessionId, input.sessionId);
        assert.deepEqual(Buffer.from(attempt.request.text), Buffer.from(input.prompt));
      }
      assert.equal(events.filter(event => event.providerSessionId === sessionID && event.prompt === input.prompt).length, 1,
        'One logical input must execute exactly once despite repeated transport calls');
    }
  }
  assert.equal(calls.filter(call => !inputs.some(input => input.inputId === call.inputId)).length, 0);
  for (const visit of [...result.visits, ...inputs]) {
    assert(!Object.hasOwn(visit, 'stage'));
    assert(!Object.hasOwn(visit, 'admissionStage'));
  }
  return calls;
}

for (const kind of ['single', 'fixed', 'map']) {
  for (const boundary of ['prepared', 'admission_started', 'accepted', 'lost_response']) {
    test(`public CLI ${kind} admission recovers at ${boundary} with immutable native inputs`, { timeout: 60000 }, async t => {
      const sandbox = await fixture(t, admissionDefinition(kind), () => verdict('done'), true, {}, { boundary });
      const saved = await waitFor(() => {
        const state = getWorkflow(sandbox.state, sandbox.runId);
        return (boundary !== 'lost_response' || state.service === 'unavailable') && state;
      }, 5000, 'durable fault boundary');
      const first = saved.visits[0];
      assert.equal(first.admissionStarted, boundary !== 'prepared');
      assert(!first.admitted);
      if (boundary === 'prepared' || boundary === 'admission_started') {
        assert.equal((await sandbox.events()).filter(event => event.type === 'received').length, 0);
        assert.equal((await transcript(sandbox.fault.calls)).length, 0);
      }
      const original = structuredClone(first.children ?? [first]);
      if (boundary !== 'prepared') {
        const message = join(sandbox.root, 'late-steering.txt');
        for (const [index, text] of ['First late clarification', 'Second late clarification'].entries()) {
          await writeFile(message, text);
          const target = original[index % original.length].participant;
          const queued = await sandbox.command(['steer', sandbox.runId, target, '--message-file', message]);
          assert.equal(queued.command.status, 'pending');
        }
      }
      if (boundary === 'lost_response') {
        const { pid } = await readJson(sandbox.fault.marker);
        assert(taggedProcesses(sandbox.token).some(item => item.pid === pid), 'Lost response must leave the original controller alive');
        await sandbox.fault.reconnect();
        assert.deepEqual(await cliJson(sandbox.start, 20000), { runId: sandbox.runId });
      } else expireWorkflowLease(sandbox);
      const inspected = await sandbox.command(['inspect', sandbox.runId]);
      assert.equal(inspected.runId, sandbox.runId);
      await sandbox.release();
      const result = await sandbox.finish();
      assert.equal(result.status, 'succeeded', result.error);
      const recovered = result.visits[0].children ?? [result.visits[0]];
      for (const [index, input] of recovered.entries()) {
        for (const field of ['sessionId', 'inputId', 'prompt', 'participant', 'item']) {
          assert.deepEqual(input[field], original[index][field], field);
        }
      }
      if (boundary !== 'prepared') {
        assert.deepEqual(result.controls.map(command => command.status), ['applied', 'applied']);
        for (const [index, text] of ['First late clarification', 'Second late clarification'].entries()) {
          const later = result.visits[index + 1];
          assert(later.prompt.includes(text));
          assert.equal(later.sessionId, original[index % original.length].sessionId);
          assert.notEqual(later.inputId, original[index % original.length].inputId);
        }
      }
      const calls = await assertAdmissionHistory(sandbox, result);
      if (['accepted', 'lost_response'].includes(boundary)) {
        assert(calls.filter(call => call.inputId === original[0].inputId).length >= 2);
      }
    });
  }

  if (kind !== 'single') {
    test(`public CLI restarts a partially acknowledged ${kind} group and retries only its unfinished admission`,
      { timeout: 60000 }, async t => {
        const sandbox = await fixture(t, admissionDefinition(kind), () => verdict('done'), true, {},
          { boundary: 'lost_response', index: 2 });
        const saved = await waitFor(() => {
          const state = getWorkflow(sandbox.state, sandbox.runId);
          return state.service === 'unavailable' && state;
        }, 5000, 'partial admission committed');
        assert.deepEqual(saved.visits[0].children.map(child => Boolean(child.admitted)), [true, false]);
        const { pid } = await readJson(sandbox.fault.marker);
        process.kill(pid, 'SIGKILL');
        await within(sandbox.start.exit, 5000, 'start observes partial controller crash');
        await within(sandbox.start.close, 5000, 'partial start closes');
        expireWorkflowLease(sandbox);
        await sandbox.fault.reconnect();
        assert.equal((await sandbox.command(['inspect', sandbox.runId])).runId, sandbox.runId);
        await sandbox.release();
        const result = await sandbox.finish();
        assert.equal(result.status, 'succeeded', result.error);
        assert.deepEqual(result.visits.map(visit => visit.node), ['jobs', 'summary']);
        const calls = await assertAdmissionHistory(sandbox, result);
        for (const [index, before] of saved.visits[0].children.entries()) {
          const after = result.visits[0].children[index];
          for (const field of ['sessionId', 'inputId', 'prompt', 'participant', 'item']) assert.deepEqual(after[field], before[field]);
          assert.equal(calls.filter(call => call.inputId === before.inputId).length, index === 0 ? 1 : 2);
          assert.equal(result.visits[0].verdict.results[index].participant, before.participant);
        }
      });

    test(`public CLI resumes legacy ${kind} children with saved results and errors but missing acknowledgements`,
      { timeout: 60000 }, async t => {
        const definition = admissionDefinition(kind);
        definition.transitions.jobs.failed = 'summary';
        definition.nodes.summary = { ...definition.nodes.summary, instructions: 'Summary branch' };
        if (kind === 'fixed') {
          definition.nodes.right = { ...definition.nodes.right, instructions: 'Right branch fails' };
          definition.nodes.extra = definition.nodes.left;
          definition.transitions.extra = { done: 'summary' };
          definition.groups.jobs.members.push('extra');
        } else {
          definition.groups.jobs.items[1].detail = 'Right branch fails';
          definition.groups.jobs.items.push({ id: 'gamma', detail: 'Third' });
        }
        const sandbox = await fixture(t, definition, ({ prompt }) =>
          prompt.includes('Right branch fails') && !prompt.includes('Summary branch') ? 'invalid JSON' : verdict('done'),
        true, {}, { boundary: 'observe' });
        // Produce real native results/errors, then seed an older partial-admission representation.
        // The third native input stays held, independently of the controller's acknowledgement.
        const state = getWorkflow(sandbox.state, sandbox.runId);
        const [left, right] = state.visits[0].children;
        const calls = await waitFor(async () => {
          const calls = (await sandbox.events()).filter(event => event.type === 'received');
          return calls.length === 3 && calls;
        }, 10000, 'three held native children');
        await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token,
          callIds: calls.filter(call => [left.sessionId, right.sessionId].includes(call.providerSessionId)).map(call => call.callId) });
        const settled = await waitFor(() => {
          const saved = getWorkflow(sandbox.state, sandbox.runId);
          return saved.visits[0].children[0].verdict && saved.visits[0].children[1].error && saved;
        }, 10000, 'durable native result and branch error');
        const controller = taggedProcesses(sandbox.token).find(item =>
          execFileSync('ps', ['-p', String(item.pid), '-o', 'command='], { encoding: 'utf8' }).includes('workflow-runtime.mjs'));
        assert(controller);
        process.kill(controller.pid, 'SIGKILL');
        expireWorkflowLease(sandbox);
        assert.equal(claimWorkflow(sandbox.state, sandbox.runId, 'legacy-fixture'), true);
        const group = settled.visits[0];
        group.admitted = false;
        delete group.admissionStarted;
        for (const child of group.children) delete child.admitted;
        updateWorkflow(sandbox.state, settled, 'legacy-fixture', true);
        assert.equal((await sandbox.command(['inspect', sandbox.runId])).runId, sandbox.runId);
        await sandbox.release();
        const result = await sandbox.finish();
        assert.equal(result.status, 'succeeded', result.error);
        assert.deepEqual(result.visits.map(visit => visit.node), ['jobs', 'summary']);
        assert.deepEqual(result.visits[0].children.slice(0, 2), group.children.slice(0, 2));
        assert.deepEqual(result.visits[0].verdict.results.map(child => child.status), ['completed', 'failed', 'completed']);
        const attempts = await assertAdmissionHistory(sandbox, result);
        for (const [index, child] of group.children.entries()) {
          assert.equal(attempts.filter(call => call.inputId === child.inputId).length, index === 2 ? 2 : 1);
          for (const field of ['sessionId', 'inputId', 'prompt', 'participant', 'item']) {
            assert.deepEqual(result.visits[0].children[index][field], child[field]);
          }
        }
      });
  }
}
