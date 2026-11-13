import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { validateWorkflow } from './workflow-definition.mjs';
import { createWorkflow, getWorkflow, claimWorkflow, updateWorkflow, queueWorkflowCommand, withWorkflowAction } from './run-store.mjs';

const exact = '  Точное требование\r\n\tПример: e\u0301 ≠ é 😀\n\u0000 Конец  \r\n';
function definition() {
  return { task: 'Full original workflow request', workspace: 'directory', entry: 'review',
    taskPackages: [{ formatVersion: 1, id: 'task-A', beadsId: 'dwf-oc-xit.1', requirements: exact,
      acceptanceCriteria: ['Keep every byte', 'Check links'], dependencies: [],
      decisions: [{ id: 'decision-1', text: 'Use existing store', source: 'user:approved-architecture' }],
      artifacts: [{ id: 'contract', uri: 'docs/task-packages.md' }] }],
    nodes: { review: { role: 'reviewer', taskId: 'task-A' } },
    transitions: { review: { approve: null, changes: null } } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dwf-packages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('packages validate exact requirements and reject ambiguous identities and links', () => {
  const value = definition();
  assert.deepEqual(validateWorkflow(value), value);
  for (const change of [
    d => d.taskPackages.push(structuredClone(d.taskPackages[0])),
    d => d.taskPackages[0].id = '__proto__',
    d => d.nodes.review.taskId = 'unknown',
    d => d.taskPackages[0].dependencies = ['unknown'],
    d => d.taskPackages[0].dependencies = ['task-A'],
    d => d.taskPackages[0].dependencies = ['task-B', 'task-B'],
    d => { d.taskPackages.push({ ...structuredClone(d.taskPackages[0]), id: 'task-B', beadsId: 'other', dependencies: ['task-A'] }); d.taskPackages[0].dependencies = ['task-B']; },
    d => d.taskPackages.push({ ...structuredClone(d.taskPackages[0]), id: 'task-B' }),
    d => d.taskPackages[0].acceptanceCriteria = 'summary',
    d => d.taskPackages[0].decisions[0].source = '',
    d => d.taskPackages[0].artifacts.push(d.taskPackages[0].artifacts[0]),
    d => d.taskPackages[0].formatVersion = 999,
    d => { delete d.taskPackages; },
  ]) {
    const invalid = structuredClone(value); change(invalid);
    assert.throws(() => validateWorkflow(invalid), /Task packages:/);
  }
});

test('store keeps the immutable original and versioned steering provenance across processes', async t => {
  const root = await fixture(t);
  const state = { id: 'package-state', definition: definition(), status: 'running', visits: [], sessions: {} };
  createWorkflow(root, state);
  claimWorkflow(root, state.id, 'owner');
  const command = queueWorkflowCommand(root, state.id, 'steer', 'review', '  Clarification\r\n');
  updateWorkflow(root, state, 'owner');
  const saved = getWorkflow(root, state.id);
  assert.deepEqual(Buffer.from(saved.definition.taskPackages[0].requirements), Buffer.from(exact));
  assert.equal(saved.taskRevisions[0].source, `steer:${command.id}`);
  assert.equal(saved.taskRevisions[0].version, 2);
  assert.equal(saved.taskRevisions[0].text, '  Clarification\r\n');
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {getWorkflow} from './run-store.mjs'; console.log(JSON.stringify(getWorkflow(process.argv[1], 'package-state')));`, root], { encoding: 'utf8' }));
  assert.deepEqual(restored, saved);
  state.definition.taskPackages[0].requirements = 'summary instead of original';
  assert.throws(() => updateWorkflow(root, state, 'owner'), /Task packages:/);
  assert.equal(getWorkflow(root, state.id).definition.taskPackages[0].requirements, exact);
});

test('public CLI rejects invalid package links before creating state or contacting OpenCode', async t => {
  const root = await fixture(t);
  const file = join(root, 'workflow.json');
  const state = join(root, 'state');
  const invalid = definition(); invalid.nodes.review.taskId = 'unknown';
  await writeFile(file, JSON.stringify(invalid));
  const result = spawnSync(process.execPath, ['dwf.mjs', 'start', '--file', file], {
    encoding: 'utf8', env: { ...process.env, DWF_STATE_DIR: state, OPENCODE_CONFIG: '/nonexistent/no-service' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Task packages:/);
  await assert.rejects(readFile(join(state, 'dwf.sqlite')), { code: 'ENOENT' });
});

test('store rejects corrupt task versions and links without rewriting the saved record', async t => {
  const root = await fixture(t);
  const state = { id: 'corrupt', definition: definition(), status: 'running', visits: [], sessions: {} };
  createWorkflow(root, state); claimWorkflow(root, state.id, 'owner');
  for (const visit of [
    { node: 'review' },
    { node: 'review', taskId: 'unknown', taskVersion: 1 },
    { node: 'review', taskId: 'task-A', taskVersion: 2 },
  ]) {
    state.visits = [visit];
    assert.throws(() => updateWorkflow(root, state, 'owner'), /Task packages:/);
    assert.deepEqual(getWorkflow(root, state.id).visits, []);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, 'dwf.sqlite'));
  const corrupt = { ...state, visits: [], taskRevisions: [{ taskId: 'task-A', version: 3, kind: 'decision', text: 'Lost version', source: 'test', createdAt: 1 }] };
  const serialized = JSON.stringify(corrupt);
  db.prepare('UPDATE workflows SET state = ? WHERE id = ?').run(serialized, state.id);
  try {
    assert.throws(() => getWorkflow(root, state.id), /Task packages:/);
    assert.equal(db.prepare('SELECT state FROM workflows WHERE id = ?').get(state.id).state, serialized);
  } finally { db.close(); }
});

test('package lookup returns exact requirements and only revisions through the requested version', async () => {
  const { taskPackageAt } = await import('./task-packages.mjs');
  const state = { definition: definition(), taskRevisions: [
    { taskId: 'task-A', version: 2, kind: 'clarification', text: 'New condition', source: 'user:2', createdAt: 1 },
  ] };
  assert.equal(taskPackageAt(state, 'task-A', 1).requirements, exact);
  assert.deepEqual(taskPackageAt(state, 'task-A', 1).revisions, []);
  assert.equal(taskPackageAt(state, 'task-A').revisions[0].text, 'New condition');
  assert.throws(() => taskPackageAt(state, 'unknown'), /Task packages:/);
  assert.throws(() => taskPackageAt(state, 'task-A', 3), /Task packages:/);
});

test('mapped items explicitly override task identity and unknown dynamic links fail before workspace preparation', async () => {
  const { prepareGroup } = await import('./workflow-groups.mjs');
  const d = definition();
  d.entry = 'work';
  d.transitions.work = { done: null, changes: null, failed: null };
  d.groups = { work: { member: 'review', items: [{ id: 'first', taskId: 'unknown' }] } };
  assert.throws(() => validateWorkflow(d), /Task packages:/);
  // The source directory does not exist: package errors must win over filesystem actions.
  const state = { id: 'dynamic', definition: { ...d, groups: { work: { member: 'review', itemsFrom: 'review' } } },
    workspace: { mode: 'directory', path: '/nonexistent/dwf-package-link-test' },
    visits: [{ node: 'review', verdict: { items: [{ id: 'first', taskId: 'unknown' }] } }], sessions: {} };
  assert.throws(() => prepareGroup('/nonexistent', state, 'work'), /Task packages:/);
});

test('mapped task bindings override the template without guessing an unbound participant', async () => {
  const { taskBinding } = await import('./task-packages.mjs');
  const d = definition();
  d.taskPackages.push({ ...structuredClone(d.taskPackages[0]), id: 'task-B', beadsId: 'example-B', dependencies: ['task-A'] });
  d.nodes.manager = { role: 'orchestrator' };
  const state = { definition: d, taskRevisions: [{ taskId: 'task-B', version: 2 }] };
  assert.deepEqual(taskBinding(state, 'review'), { taskId: 'task-A', taskVersion: 1 });
  assert.deepEqual(taskBinding(state, 'review', { id: 'item', taskId: 'task-B' }), { taskId: 'task-B', taskVersion: 2 });
  assert.deepEqual(taskBinding(state, 'manager'), {});
});

test('multiple accepted steering commands append versions without overwriting the original or prior decisions', async t => {
  const root = await fixture(t);
  const state = { id: 'revisions', definition: definition(), status: 'running', visits: [], sessions: {} };
  createWorkflow(root, state); claimWorkflow(root, state.id, 'owner');
  const first = queueWorkflowCommand(root, state.id, 'steer', 'review', 'Exact clarification');
  const second = queueWorkflowCommand(root, state.id, 'steer', 'review', 'Exact decision', 'decision');
  // A controller holding the initial state cannot erase either newly accepted update.
  updateWorkflow(root, state, 'owner');
  assert.deepEqual(state.taskRevisions.map(r => [r.version, r.kind, r.source]), [
    [2, 'clarification', `steer:${first.id}`], [3, 'decision', `steer:${second.id}`],
  ]);
  state.taskRevisions[0].text = 'silent rewrite';
  assert.throws(() => updateWorkflow(root, state, 'owner'), /Task packages:/);
  assert.equal(getWorkflow(root, state.id).taskRevisions[0].text, 'Exact clarification');
});

test('legacy map metadata named taskId remains opaque without a package catalog', async () => {
  const { taskBinding, validateTaskState } = await import('./task-packages.mjs');
  const d = definition(); delete d.taskPackages; delete d.nodes.review.taskId;
  d.entry = 'work';
  d.groups = { work: { member: 'review', items: [{ id: 'old-item', taskId: 'external:legacy-reference' }] } };
  d.transitions.work = { done: null, changes: null, failed: null };
  assert.deepEqual(validateWorkflow(d), d);
  const state = { definition: d, visits: [{ node: 'review', item: d.groups.work.items[0] }] };
  assert.deepEqual(taskBinding(state, 'review', d.groups.work.items[0]), {});
  assert.doesNotThrow(() => validateTaskState(state));
});

test('withWorkflowAction rejects snapshot, package and revision rewrites made inside its callback', async t => {
  const root = await fixture(t);
  const state = { id: 'action-snapshots', definition: definition(), status: 'running', visits: [], sessions: {},
    inputSnapshot: { encoding: 'base64', data: Buffer.from('original full input').toString('base64'), source: 'test' } };
  createWorkflow(root, state); claimWorkflow(root, state.id, 'owner');
  queueWorkflowCommand(root, state.id, 'steer', 'review', 'Original clarification');
  const original = getWorkflow(root, state.id);
  for (const mutate of [
    state => { state.inputSnapshot.data = Buffer.from('replacement input').toString('base64'); },
    state => { state.definition.taskPackages[0].requirements = 'replacement requirement'; },
    state => { state.taskRevisions[0].text = 'replacement clarification'; },
  ]) {
    const current = getWorkflow(root, state.id);
    await assert.rejects(withWorkflowAction(root, current, 'owner', async () => mutate(current)), /Task packages:/);
    assert.deepEqual(getWorkflow(root, state.id), original);
  }
});

for (const grouped of [false, true]) {
  test(`a frozen ${grouped ? 'group child' : 'ordinary input'} cannot be relabelled with a later task version`, async t => {
    const root = await fixture(t);
    const input = { node: 'review', participant: 'review', inputId: 'msg_frozen', sessionId: 'ses_frozen',
      taskId: 'task-A', taskVersion: 1, prompt: 'Saved version-one input', admissionStarted: true };
    const state = { id: 'frozen-version', definition: definition(), status: 'running', sessions: {},
      visits: grouped ? [{ node: 'group', admissionStarted: true, children: [input] }] : [input] };
    createWorkflow(root, state); claimWorkflow(root, state.id, 'owner');
    queueWorkflowCommand(root, state.id, 'steer', 'review', 'New version-two condition');
    const original = getWorkflow(root, state.id);
    const current = structuredClone(original);
    const target = grouped ? current.visits[0].children[0] : current.visits[0];
    target.taskVersion = 2;
    assert.throws(() => updateWorkflow(root, current, 'owner'), /Task packages:/);
    const callbackState = getWorkflow(root, state.id);
    await assert.rejects(withWorkflowAction(root, callbackState, 'owner', async () => {
      (grouped ? callbackState.visits[0].children[0] : callbackState.visits[0]).taskVersion = 2;
    }), /Task packages:/);
    assert.deepEqual(getWorkflow(root, state.id), original);
  });
}

test('withWorkflowAction cannot erase the definition and audit by deleting all package fields', async t => {
  const root = await fixture(t);
  const state = { id: 'deleted-snapshots', definition: definition(), status: 'running', visits: [], sessions: {},
    inputSnapshot: { encoding: 'base64', data: Buffer.from('exact full input').toString('base64'), source: 'test' } };
  createWorkflow(root, state); claimWorkflow(root, state.id, 'owner');
  queueWorkflowCommand(root, state.id, 'steer', 'review', 'Exact clarification');
  const original = getWorkflow(root, state.id);
  for (const audit of ['delete', 'replace', 'unchanged']) {
    const current = getWorkflow(root, state.id);
    await assert.rejects(withWorkflowAction(root, current, 'owner', async () => {
      delete current.definition;
      delete current.taskRevisions;
      if (audit === 'delete') delete current.inputSnapshot;
      if (audit === 'replace') current.inputSnapshot.data = 'replacement';
    }), /Task packages:/, audit);
    assert.deepEqual(getWorkflow(root, state.id), original);
  }
});

for (const grouped of [false, true]) {
  for (const action of [false, true]) {
    test(`frozen ${grouped ? 'group' : 'ordinary'} input cannot reset preparation then change version via ${action ? 'callback' : 'update'}`, async t => {
      const root = await fixture(t);
      const input = { node: 'review', participant: 'review', inputId: 'msg_frozen', sessionId: 'ses_frozen',
        taskId: 'task-A', taskVersion: 1, prompt: 'Saved version-one input', admissionStarted: true };
      const state = { id: 'reset-freeze', definition: definition(), status: 'running', sessions: {},
        visits: grouped ? [{ node: 'group', admissionStarted: true, children: [input] }] : [input] };
      createWorkflow(root, state); claimWorkflow(root, state.id, 'owner');
      queueWorkflowCommand(root, state.id, 'steer', 'review', 'Version-two clarification');
      const original = getWorkflow(root, state.id);
      const attempt = async mutate => {
        const current = getWorkflow(root, state.id);
        if (action) await assert.rejects(withWorkflowAction(root, current, 'owner', async () => mutate(current)), /Task packages:/);
        else { mutate(current); assert.throws(() => updateWorkflow(root, current, 'owner'), /Task packages:/); }
        assert.deepEqual(getWorkflow(root, state.id), original);
      };
      await attempt(current => { current.visits[0].admissionStarted = false; });
      await attempt(current => { (grouped ? current.visits[0].children[0] : current.visits[0]).taskVersion = 2; });
    });
  }
}

test('preset file import rejects invalid UTF-8 before creating or overwriting saved requirements', async t => {
  const root = await fixture(t);
  const file = join(root, 'workflow.json');
  const state = join(root, 'state');
  const cli = args => spawnSync(process.execPath, ['dwf.mjs', ...args], {
    encoding: 'utf8', env: { ...process.env, DWF_STATE_DIR: state, OPENCODE_CONFIG: '/nonexistent/no-service' },
  });
  const invalid = definition(); invalid.taskPackages[0].requirements = 'Exact ORIGINAL requirement';
  const bytes = Buffer.from(JSON.stringify(invalid));
  bytes[bytes.indexOf('ORIGINAL')] = 0xff;
  await writeFile(file, bytes);
  const rejected = cli(['preset', 'save', 'corrupt-input', '--file', file]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /UTF-8/);
  await assert.rejects(readFile(join(state, 'dwf.sqlite')), { code: 'ENOENT' });

  await writeFile(file, JSON.stringify(definition()));
  assert.equal(cli(['preset', 'save', 'preserved', '--file', file]).status, 0);
  const original = cli(['preset', 'show', 'preserved']);
  assert.equal(original.status, 0);
  assert.deepEqual(Buffer.from(JSON.parse(original.stdout).taskPackages[0].requirements), Buffer.from(exact));
  await writeFile(file, bytes);
  const overwritten = cli(['preset', 'save', 'preserved', '--file', file]);
  assert.equal(overwritten.status, 1);
  assert.match(overwritten.stderr, /UTF-8/);
  assert.equal(cli(['preset', 'show', 'preserved']).stdout, original.stdout);
  assert.deepEqual(JSON.parse(cli(['preset', 'list']).stdout), { presets: ['preserved'] });
});
