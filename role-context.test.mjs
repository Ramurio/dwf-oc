import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactLink, prepareRoleInput } from './role-context.mjs';

import { eightTasks } from './acceptance/context-fixture.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dwf-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { id: 'context-test', definition: eightTasks(), visits: [], workspace: { path: root }, taskRevisions: [] };
  return { root, state };
}
let inputSequence = 0;
function build(root, state, node, previous, item) {
  const taskId = item?.taskId ?? state.definition.nodes[node].taskId;
  const visit = { node, participant: node, inputId: `msg_${node}_${++inputSequence}`, revision: 'candidate-2', ...(item ? { item } : {}),
    ...(taskId ? { taskId, taskVersion: 1 + state.taskRevisions.filter(r => r.taskId === taskId).length } : {}) };
  prepareRoleInput(root, state, visit, previous, state.workspace);
  return visit;
}

test('eight addressed tasks keep every criterion and no full text of the other seven tasks', t => {
  const { root, state } = fixture(t);
  for (let i = 0; i < 8; i++) for (const role of ['worker', 'reviewer', 'verifier']) {
    const visit = build(root, state, `${role}${i}`);
    const data = visit.taskContext;
    assert.equal(data.role, role);
    assert.equal(data.candidate, 'candidate-2');
    assert.equal(data.task.requirements, state.definition.taskPackages[i].requirements);
    assert.deepEqual(data.task.acceptanceCriteria, state.definition.taskPackages[i].acceptanceCriteria);
    const decoded = JSON.parse(visit.prompt.match(/Task\/context data:\n([^\n]+)/)[1]);
    assert.deepEqual(decoded, data);
    for (const criterion of data.task.acceptanceCriteria) assert(visit.prompt.includes(criterion));
    for (let j = 0; j < 8; j++) if (j !== i) assert(!visit.prompt.includes(`UNIQUE_REQUIREMENT_${j}`));
    assert(!visit.prompt.includes('MANAGER_OWN_INSTRUCTIONS'));
    assert(!visit.prompt.includes('hidden'));
    assert.equal(JSON.parse(readFileSync(data.sources.task.path, 'utf8')).requirements, data.task.requirements);
  }
});

test('manager gets navigation, current states, decisions and questions but never repeats its instructions in nodes', t => {
  const { root, state } = fixture(t);
  state.visits = [{ node: 'worker0', participant: 'worker0', taskId: 'task-0', taskVersion: 1,
    revision: 'candidate-1', verdict: { outcome: 'blocked', summary: 'QUESTION: which API?' } }];
  const visit = build(root, state, 'manager');
  assert.equal(visit.prompt.split('MANAGER_OWN_INSTRUCTIONS').length - 1, 1);
  assert(!visit.prompt.includes('UNIQUE_REQUIREMENT_'));
  assert(!visit.prompt.includes('ASSIGNMENT_worker_'));
  assert.equal(visit.taskContext.catalog.length, 8);
  assert.equal(visit.taskContext.catalog[0].status, 'blocked');
  assert.equal(visit.taskContext.questions[0].result.summary, 'QUESTION: which API?');
  assert.equal(visit.taskContext.catalog[1].decisions[0].source, 'user:approval-1');
  for (const card of visit.taskContext.catalog) assert.equal(JSON.parse(readFileSync(card.details.path)).id, card.id);
});

test('revision, mapped identity, prior findings and others reports are explicit and task scoped', t => {
  const { root, state } = fixture(t);
  state.taskRevisions.push({ taskId: 'task-2', version: 2, kind: 'decision', text: 'Exact new agreement', source: 'steer:2', createdAt: 1 });
  state.visits = [
    { node: 'reviewer2', participant: 'reviewer2', taskId: 'task-2', taskVersion: 1, revision: 'candidate-1', verdict: { outcome: 'changes', summary: 'Old finding: invalid input' } },
    { node: 'worker7', participant: 'worker7', taskId: 'task-7', revision: 'candidate-1', verdict: { outcome: 'done', summary: 'Unrelated report' } },
  ];
  const previous = { outcome: 'done', summary: 'Collected 8 reports', results: [
    { taskId: 'task-2', result: { outcome: 'done', summary: 'Claim: tests pass' } },
    { taskId: 'task-7', result: { outcome: 'done', summary: 'Unrelated report' } },
  ] };
  const visit = build(root, state, 'verifier0', previous, { id: 'mapped', taskId: 'task-2', instructions: 'Run invalid input scenario' });
  assert.equal(visit.taskContext.task.id, 'task-2');
  assert.equal(visit.taskContext.task.version, 2);
  assert.equal(visit.taskContext.task.revisions[0].source, 'steer:2');
  assert(visit.prompt.includes('Old finding: invalid input'));
  assert(visit.prompt.includes('Claim: tests pass'));
  assert(visit.prompt.includes('not independent verification'));
  assert(!visit.prompt.includes('Unrelated report'));
});

test('artifact references do not authorize traversal, absolute paths or symlink escapes', t => {
  const { root } = fixture(t);
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(root, 'secret'), 'not a project artifact');
  symlinkSync(root, join(project, 'escape'));
  const link = uri => artifactLink({ id: 'spec', uri }, { path: project }, ['read']);
  for (const uri of ['../secret', join(root, 'secret'), 'file:///secret', 'escape/secret', 'escape/future/file']) {
    assert.equal(link(uri).access, 'unavailable', uri);
  }
  assert.equal(link('docs/future.md').access, 'read');
  assert.equal(link('https://example.invalid/spec').access, 'unavailable');
  assert.equal(artifactLink({ id: 'spec', uri: 'https://example.invalid/spec' }, { path: project }, ['webfetch']).access, 'webfetch');
});

test('saved task links keep their original version after a later clarification', t => {
  const { root, state } = fixture(t);
  const first = build(root, state, 'worker0');
  const saved = readFileSync(first.taskContext.sources.task.path, 'utf8');
  state.taskRevisions.push({ taskId: 'task-0', version: 2, kind: 'clarification', text: 'Later requirement', source: 'steer:later', createdAt: 1 });
  const second = build(root, state, 'worker0');
  assert.equal(first.taskContext.task.version, 1);
  assert.equal(second.taskContext.task.version, 2);
  assert.equal(readFileSync(first.taskContext.sources.task.path, 'utf8'), saved);
  assert.notEqual(second.taskContext.sources.task.path, first.taskContext.sources.task.path);
});

test('review context pins the complete diff and never prescribes shell or test edits', t => {
  const { root, state } = fixture(t);
  const visit = { node: 'reviewer0', inputId: 'msg_review_diff', taskId: 'task-0', taskVersion: 1, revision: 'candidate-2',
    review: { path: '/isolated/reviews/candidate.diff', base: 'base', revision: 'candidate-2', bytes: 20000000 } };
  prepareRoleInput(root, state, visit, undefined, state.workspace);
  assert.equal(visit.taskContext.review.bytes, 20000000);
  assert.equal(visit.taskContext.review.revision, visit.taskContext.candidate);
  assert(visit.prompt.includes(visit.review.path));
  assert(!visit.prompt.includes('shell'));
  assert(!visit.prompt.includes('modify tests'));
});

test('handoff from an unrelated task is not forwarded to the next worker', t => {
  const { root, state } = fixture(t);
  const verdict = { outcome: 'done', summary: state.definition.taskPackages[7].requirements };
  state.visits.push({ node: 'worker7', taskId: 'task-7', taskVersion: 1, verdict });
  const visit = build(root, state, 'worker0', verdict);
  assert(!visit.prompt.includes('UNIQUE_REQUIREMENT_7'));
});


test('comparable eight-task size measurement reduces context and requirement repetition without clipping', async () => {
  const { contextSizeComparison } = await import('./acceptance/context-size.mjs');
  const measurement = contextSizeComparison();
  assert.equal(measurement.tasks, 8);
  assert.equal(measurement.criteria, 40);
  for (const row of measurement.rows) {
    assert(row.afterChars < row.unchangedDefinitionBeforeChars);
    assert(row.unchangedDefinitionBeforeChars < row.beforeChars);
  }
  assert.deepEqual(measurement.rows[0].beforeRequirementOccurrences, Array(8).fill(2));
  assert.deepEqual(measurement.rows[0].afterRequirementOccurrences, Array(8).fill(0));
  assert.deepEqual(measurement.rows[1].afterRequirementOccurrences, [1, 0, 0, 0, 0, 0, 0, 0]);
});


test('context references stay identical when a restarted controller uses a symlink alias of the state root', t => {
  const { root, state } = fixture(t);
  const alias = join(root, 'state-alias');
  symlinkSync(root, alias);
  const first = build(root, state, 'worker0');
  const restored = structuredClone(first);
  prepareRoleInput(alias, state, restored, undefined, state.workspace);
  assert.equal(first.contextDirectory, restored.contextDirectory);
  assert.deepEqual(first.taskContext, restored.taskContext);
  assert.equal(first.taskContext.runId, state.id);
  assert.equal(first.taskContext.inputId, first.inputId);
});


test('unresolvable optional artifact links are explicit unavailable references, not input assembly failures', t => {
  const { root } = fixture(t);
  symlinkSync('loop', join(root, 'loop'));
  for (const uri of ['loop', 'invalid\u0000path']) {
    const link = artifactLink({ id: 'optional', uri }, { path: root }, ['read']);
    assert.equal(link.access, 'unavailable');
    assert(link.reason);
  }
});

for (const managerTask of [undefined, 'task-0']) {
  test(`manager handoff survives sender binding ${managerTask ?? 'unbound'} without forwarding its backlog`, t => {
    const { root, state } = fixture(t);
    if (managerTask) state.definition.nodes.manager.taskId = managerTask;
    const previous = { outcome: 'assign1', summary: 'UNIQUE_MANAGER_ASSIGNMENT: keep the agreed endpoint',
      backlog: state.definition.taskPackages };
    state.visits.push({ node: 'manager', participant: 'manager', inputId: 'msg_manager_prior',
      ...(managerTask ? { taskId: managerTask, taskVersion: 1 } : {}), revision: 'candidate-1', verdict: previous });
    const visit = build(root, state, 'worker1', previous);
    assert(visit.prompt.includes(previous.summary));
    assert.equal(visit.taskContext.otherReports.handoffSource.node, 'manager');
    assert.equal(visit.taskContext.otherReports.handoffSource.taskId, managerTask);
    const ref = visit.taskContext.otherReports.handoffSource.details;
    const savedReport = JSON.parse(readFileSync(ref.path, 'utf8'))[Number(ref.pointer.slice(1))];
    assert.deepEqual(savedReport.result, previous);
    for (let i = 0; i < 8; i++) if (i !== 1) assert(!visit.prompt.includes(`UNIQUE_REQUIREMENT_${i}`));
  });
}

for (const verifierTask of [undefined, 'task-1']) {
  test(`immediate verifier receives review question despite binding ${verifierTask ?? 'unbound'}`, t => {
    const { root, state } = fixture(t);
    if (verifierTask) state.definition.nodes.verifier1.taskId = verifierTask;
    else delete state.definition.nodes.verifier1.taskId;
    state.definition.task = 'Common workflow requirement, not a package catalog';
    const previous = { outcome: 'approve', summary: 'UNIQUE_REVIEW_QUESTION: reproduce baseline exception continuation',
      findings: [{ path: 'index.mjs', question: 'Observe the second callback' }] };
    state.visits.push({ node: 'reviewer0', taskId: 'task-0', taskVersion: 1, revision: 'candidate-2', verdict: previous });
    const visit = build(root, state, 'verifier1', previous);
    assert(visit.prompt.includes(previous.summary));
    assert.equal(visit.taskContext.otherReports.handoffSource.role, 'reviewer');
    assert.deepEqual(visit.taskContext.otherReports.handoff.findings, previous.findings);
    assert.equal(visit.taskContext.otherReports.handoffSource.revision, 'candidate-2');
    assert(!visit.prompt.includes('UNIQUE_REQUIREMENT_0'));
  });
}

for (const role of ['worker', 'reviewer', 'verifier']) {
  test(`unbound ${role} has explicit general requirements and valid scenario sources`, t => {
    const { root, state } = fixture(t);
    const id = `${role}0`;
    delete state.definition.nodes[id].taskId;
    state.definition.task = 'UNIQUE_COMMON_REQUIREMENT: preserve public compatibility\r\nCheck the two invocation scenario.';
    const visit = build(root, state, id);
    const context = visit.taskContext;
    assert.equal(context.task.requirements, state.definition.task);
    assert.equal(context.taskScope.kind, 'workflow');
    assert(context.taskScope.reason.includes('taskId'));
    assert.equal(context.task.id, undefined);
    const source = JSON.parse(readFileSync(context.sources.task.path, 'utf8'));
    assert.equal(context.sources.requirementsPointer, '/definition/task');
    assert.equal(source.definition.task, state.definition.task);
    for (const key of ['criteria', 'requirements', 'assignment']) if (context.scenarios?.[key]) {
      let target = context;
      for (const part of context.scenarios[key].split('/').slice(1)) target = target?.[part];
      assert.notEqual(target, undefined, `Broken scenario pointer: ${context.scenarios[key]}`);
    }
  });
}

test('manager sees group integration failure separately from successful addressed children and in full history', t => {
  const { root, state } = fixture(t);
  const children = [0, 1].map(i => ({ node: `worker${i}`, participant: `jobs/item${i}`, inputId: `msg_child${i}`,
    taskId: `task-${i}`, taskVersion: 1, revision: `branch-${i}`, verdict: { outcome: 'done', summary: `Implemented ${i}` } }));
  const previous = { outcome: 'failed', summary: 'Collected two successful branches',
    integrationError: 'UNIQUE_INTEGRATION_FAILURE: conflicting shared schema',
    results: children.map(child => ({ participant: child.participant, taskId: child.taskId, result: child.verdict })) };
  state.visits.push({ node: 'jobs', inputId: 'group_prior', revision: 'candidate-1', children, verdict: previous });
  const visit = build(root, state, 'manager', previous);
  assert(visit.prompt.includes(previous.integrationError));
  assert.equal(visit.taskContext.groupResults[0].result.outcome, 'failed');
  assert.equal(visit.taskContext.catalog[0].results[0].result.outcome, 'done');
  const history = JSON.parse(readFileSync(visit.taskContext.history.path, 'utf8'));
  assert.deepEqual(history.find(report => report.node === 'jobs').result, previous);
  assert.equal(history.find(report => report.node === 'jobs').role, 'group');
});


for (const source of ['reviewer0', 'verifier0']) {
  test(`direct checking feedback from ${source} remains addressed to a worker with a different task`, t => {
    const { root, state } = fixture(t);
    const previous = { outcome: 'changes', summary: 'UNIQUE_CROSS_TASK_CORRECTION: repair the shared boundary',
      findings: [{ path: 'index.mjs', summary: 'Retain compatibility with the predecessor contract' }] };
    state.visits.push({ node: source, taskId: 'task-0', taskVersion: 1, revision: 'candidate-1', verdict: previous });
    const visit = build(root, state, 'worker1', previous);
    assert(visit.prompt.includes(previous.summary));
    assert.deepEqual(visit.taskContext.otherReports.handoff.findings, previous.findings);
    assert(!visit.prompt.includes('UNIQUE_REQUIREMENT_0'));
  });
}

import { implementDefinition } from './acceptance/implement-definition.mjs';
import { publicImplements } from './workflow-implements.mjs';
import { taskBinding } from './task-packages.mjs';

function implementFixture(t) {
  const fixtureState = fixture(t);
  const { state } = fixtureState;
  state.definition = implementDefinition();
  state.sessions = {};
  state.implements = { instances: Object.fromEntries(['alpha', 'beta', 'gamma'].map(id => [id,
    { id, taskId: id, status: id === 'gamma' ? 'queued' : 'running', cycle: 1 }])),
    events: [{ sequence: 1, implementId: 'alpha', taskId: 'alpha', type: 'changes', result: { outcome: 'changes', summary: 'Fix alpha only' } }] };
  return fixtureState;
}

test('shared preparation gives manager real implement states, dependencies and state-aware gates', t => {
  const { root, state } = implementFixture(t);
  const visit = { node: 'manage', participant: 'manage', inputId: 'msg_manager', revision: 'combined' };
  prepareRoleInput(root, state, visit, undefined, state.workspace, 'manage', undefined, { implements: publicImplements(state) });
  assert.equal(visit.taskContext.implements.instances[2].waitingReason, 'dependencies');
  assert.deepEqual(visit.taskContext.implements.instances[2].waitingFor, ['alpha', 'beta']);
  assert.equal(visit.taskContext.catalog[2].status, 'queued');
  assert.equal(visit.taskContext.catalog[0].implementId, 'alpha');
  assert.equal(visit.taskContext.implements.events[0].result.summary, 'Fix alpha only');
  for (const task of state.definition.taskPackages) assert(!visit.prompt.includes(task.requirements));
});

test('interleaved implement handoff uses saved input identity, not the last neighbour or object equality', t => {
  const { root, state } = implementFixture(t);
  const previous = { outcome: 'changes', summary: 'Addressed alpha finding', findings: [{ file: 'alpha.txt', text: 'Keep exact bytes' }] };
  state.visits = [
    { node: 'review', participant: 'alpha/reviewer', implementId: 'alpha', inputId: 'msg_alpha_review', taskId: 'alpha', taskVersion: 1, verdict: previous },
    { node: 'review', participant: 'beta/reviewer', implementId: 'beta', inputId: 'msg_beta_review', taskId: 'beta', taskVersion: 1,
      verdict: { outcome: 'changes', summary: 'UNRELATED_BETA_FINDING' } },
  ];
  const visit = { node: 'work', participant: 'alpha/worker', implementId: 'alpha', inputId: 'msg_alpha_fix', revision: 'alpha-tree',
    item: { id: 'alpha', taskId: 'alpha' }, ...taskBinding(state, 'work', { taskId: 'alpha' }) };
  prepareRoleInput(root, state, visit, structuredClone(previous), state.workspace, 'work', undefined, {
    handoffInputId: 'msg_alpha_review', implement: { id: 'alpha', taskId: 'alpha', cycle: 2, assignment: 'Original concrete alpha assignment',
      controllerInputId: 'msg_admission', dependencies: [] },
  });
  const context = visit.taskContext;
  assert.equal(context.implement.id, 'alpha');
  assert.equal(context.participant, 'alpha/worker');
  assert.equal(context.assignment.implement.text, 'Original concrete alpha assignment');
  assert.deepEqual(context.otherReports.handoff, previous);
  assert.equal(context.otherReports.handoffSource.inputId, 'msg_alpha_review');
  assert.equal(context.otherReports.handoffSource.implementId, 'alpha');
  assert(!visit.prompt.includes('UNRELATED_BETA_FINDING'));
  assert(!visit.prompt.includes('Implement execution context:'));
  assert.equal(JSON.parse(readFileSync(context.sources.task.path)).requirements, state.definition.taskPackages[0].requirements);
});

test('prepared implement control context is detached from subsequent events and nested operation changes', t => {
  const { root, state } = implementFixture(t);
  state.implements.instances.alpha.integration = { id: 'integration_alpha', status: 'prepared' };
  const visit = { node: 'manage', participant: 'manage', inputId: 'msg_control_snapshot', revision: 'combined' };
  prepareRoleInput(root, state, visit, undefined, state.workspace, 'manage', undefined, { implements: publicImplements(state) });
  const saved = structuredClone(visit.taskContext);
  state.implements.events.push({ sequence: 2, implementId: 'alpha', type: 'ready' });
  state.implements.instances.alpha.integration.status = 'integrated';
  assert.deepEqual(visit.taskContext, saved);
});

test('implement dependency links keep package identity separate from instance identity', t => {
  const { root, state } = implementFixture(t);
  const visit = { node: 'work', participant: 'gamma-instance/worker', implementId: 'gamma-instance', inputId: 'msg_dependency',
    revision: 'gamma-tree', item: { id: 'gamma-instance', taskId: 'gamma' }, ...taskBinding(state, 'work', { taskId: 'gamma' }) };
  prepareRoleInput(root, state, visit, undefined, state.workspace, 'work', undefined, { implement: {
    id: 'gamma-instance', taskId: 'gamma', assignment: 'Use integrated dependencies', dependencies: [
      { id: 'alpha-instance', taskId: 'alpha', revision: 'alpha-tree', resultVersion: 2, result: { outcome: 'approve', summary: 'Observed alpha checks' } },
    ],
  } });
  const dependency = visit.taskContext.dependencies[0];
  assert.equal(dependency.id, 'alpha');
  assert.equal(dependency.implementId, 'alpha-instance');
  assert.equal(dependency.resultVersion, 2);
  assert.equal(JSON.parse(readFileSync(dependency.details.path)).id, 'alpha');
});
