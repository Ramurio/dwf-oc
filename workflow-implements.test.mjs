import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkflow, checkApprovals } from './workflow-definition.mjs';
import { implementDefinition } from './acceptance/implement-definition.mjs';

test('implement contract preserves template cycles and demands explicit concurrency and integration gates', () => {
  const definition = implementDefinition();
  assert.deepEqual(validateWorkflow(definition), definition);
  const overrides = structuredClone(definition);
  overrides.roles.worker.memory = false;
  overrides.nodes.work.memory = true;
  assert.deepEqual(validateWorkflow(overrides), overrides);
  for (const change of [
    value => { delete value.implements.concurrency; },
    value => { value.implements.concurrency = 0; },
    value => { value.implements.instances.beta.taskId = 'alpha'; },
    value => { value.implements.instances.alpha.reviewer = 'work'; },
    value => { delete value.implements.instances.beta; },
    value => { value.nodes.integrationVerify.required = false; },
    value => { value.nodes.work.memory = false; },
    value => { value.transitions.review.approve = 'manage'; },
    value => { value.implements = null; },
    value => { value.implements.instances.alpha = null; },
    value => { value.groups = { alpha: { members: ['integrationReview'] } }; value.transitions.alpha = { done: 'manage', changes: 'manage', failed: 'manage' }; value.transitions.manage.check = 'alpha'; },
    value => { value.transitions.manage.dispatch = 'work'; },
  ]) {
    const value = structuredClone(definition);
    change(value);
    assert.throws(() => validateWorkflow(value));
  }
});

test('global approvals cannot complete a workflow while implement instances remain unintegrated', () => {
  const state = { definition: implementDefinition(), visits: ['integrationReview', 'integrationVerify'].map(node =>
    ({ node, revision: 'combined', verdict: { outcome: 'approve', summary: 'checked' } })) };
  assert.throws(() => checkApprovals(state, 'combined'), /implement/i);
});

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, prepareWorkspace, snapshot } from './workflow-git.mjs';
import { initializeImplements, applyImplementDecision, advanceImplementState as advanceOnce, candidateApprovalProblems,
  checkImplementCandidates, publicImplements } from './workflow-implements.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-implement-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  await mkdir(source);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'DWF Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'shared.txt'), 'base\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'base']);
  const root = join(directory, 'state');
  const state = { id: 'unit', status: 'running', definition: implementDefinition(), sessions: {}, visits: [],
    workspace: prepareWorkspace(root, source, 'unit') };
  initializeImplements(state);
  return { root, state, source };
}

function advanceImplementState(root, state) { for (let count = 0; count < 6; count++) advanceOnce(root, state); }

function decide(state, actions) {
  const visit = { node: 'manage', inputId: `manager-${state.visits.length}`, verdict: { outcome: 'dispatch', summary: 'Assign tasks', implements: actions } };
  state.visits.push(visit);
  applyImplementDecision(state, visit);
  applyImplementDecision(state, visit); // saved decisions replay without double admission
}
function finish(root, state, id, outcome) {
  const instance = state.implements.instances[id];
  const visit = state.visits.find(visit => visit.inputId === instance.currentInputId);
  state.sessions[visit.participant] = visit.sessionId;
  visit.verdict = { outcome, summary: `${id} ${instance.phase} ${outcome}` };
  if (instance.phase === 'worker') visit.revision = snapshot(instance.workspace);
  advanceImplementState(root, state);
  return visit;
}
async function ready(root, state, id, file, text) {
  await writeFile(join(state.implements.instances[id].workspace.path, file), text);
  finish(root, state, id, 'done');
  finish(root, state, id, 'approve');
  finish(root, state, id, 'approve');
  assert.equal(state.implements.instances[id].status, 'ready');
}

test('isolated cycles keep approvals independent, reuse revision session and queue dependencies', async t => {
  const { root, state, source } = await fixture(t);
  decide(state, ['alpha', 'beta', 'gamma'].map(id => ({ action: 'admit', id, assignment: `Create ${id}.txt` })));
  advanceImplementState(root, state);
  const alpha = state.implements.instances.alpha;
  const beta = state.implements.instances.beta;
  assert.notEqual(alpha.workspace.path, beta.workspace.path);
  assert.equal(state.implements.instances.gamma.status, 'queued');
  assert.equal(publicImplements(state).instances[2].waitingReason, 'dependencies');
  const first = finish(root, state, 'alpha', 'done');
  const review = finish(root, state, 'alpha', 'changes');
  assert.equal(alpha.status, 'running');
  assert.equal(alpha.phase, 'worker');
  const revised = state.visits.find(visit => visit.inputId === alpha.currentInputId);
  assert.equal(revised.sessionId, first.sessionId);
  assert.notEqual(revised.inputId, first.inputId);
  assert.match(revised.prompt, new RegExp(review.verdict.summary));
  assert.equal(state.visits.filter(visit => visit.node === 'manage').length, 1);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  await writeFile(join(beta.workspace.path, 'beta.txt'), 'beta');
  assert.deepEqual(candidateApprovalProblems(state, alpha), []);
  assert.throws(() => checkApprovals(state, snapshot(state.workspace)), /implement/i);
  await ready(root, state, 'beta', 'beta.txt', 'beta');
  decide(state, ['alpha', 'beta'].map(id => ({ action: 'integrate', id })));
  advanceImplementState(root, state);
  assert.equal(alpha.status, 'integrated');
  assert.equal(beta.status, 'integrated');
  assert.equal(state.implements.instances.gamma.status, 'running');
  assert.equal(await readFile(join(state.implements.instances.gamma.workspace.path, 'beta.txt'), 'utf8'), 'beta');
  await assert.rejects(readFile(join(source, 'alpha.txt')), { code: 'ENOENT' });
  await ready(root, state, 'gamma', 'gamma.txt', 'gamma');
  decide(state, [{ action: 'integrate', id: 'gamma' }]);
  advanceImplementState(root, state);
  assert.throws(() => checkApprovals(state, snapshot(state.workspace)), /integrationReview/);
  const revision = snapshot(state.workspace);
  state.visits.push(...['integrationReview', 'integrationVerify'].map(node => ({ node, revision, verdict: { outcome: 'approve', summary: 'checked combined files' } })));
  assert.doesNotThrow(() => checkApprovals(state, revision));
  assert.doesNotThrow(() => checkImplementCandidates(state));
  await writeFile(join(state.workspace.path, 'new-combined-change.txt'), 'invalidate only global approvals');
  assert.throws(() => checkApprovals(state, snapshot(state.workspace)), /integrationReview/);
  assert.deepEqual(candidateApprovalProblems(state, alpha), []);
  await writeFile(join(alpha.workspace.path, 'alpha.txt'), 'changed after approval');
  assert.equal(candidateApprovalProblems(state, alpha).length, 3);
  assert.throws(() => checkImplementCandidates(state), /текущего кандидата/);
});

test('integration conflicts preserve both candidates, conflict artifacts and the parent, then return to the same worker', async t => {
  const { root, state } = await fixture(t);
  decide(state, ['alpha', 'beta'].map(id => ({ action: 'admit', id, assignment: `Change shared to ${id}` })));
  advanceImplementState(root, state);
  const alpha = state.implements.instances.alpha;
  const beta = state.implements.instances.beta;
  await ready(root, state, 'alpha', 'shared.txt', 'alpha\n');
  await ready(root, state, 'beta', 'shared.txt', 'beta\n');
  const session = state.sessions['beta/worker'];
  decide(state, [{ action: 'integrate', id: 'alpha' }, { action: 'integrate', id: 'beta' }]);
  advanceImplementState(root, state);
  assert.equal(alpha.status, 'integrated');
  assert.equal(beta.status, 'conflict');
  assert.equal(await readFile(join(state.workspace.path, 'shared.txt'), 'utf8'), 'alpha\n');
  assert.equal(await readFile(join(beta.workspace.path, 'shared.txt'), 'utf8'), 'beta\n');
  assert.match(await readFile(join(beta.integration.workspace.path, 'shared.txt'), 'utf8'), /<<<<<<<[\s\S]*alpha[\s\S]*beta/);
  assert.deepEqual(beta.integration.conflicts, ['shared.txt']);
  assert(beta.integration.patch.bytes > 0);
  decide(state, [{ action: 'revise', id: 'beta', assignment: 'Resolve shared.txt to alpha and beta' }]);
  advanceImplementState(root, state);
  const visit = state.visits.find(visit => visit.inputId === beta.currentInputId);
  assert.equal(visit.sessionId, session);
  assert.match(visit.prompt, /Resolve shared.txt/);
  await ready(root, state, 'beta', 'shared.txt', 'alpha and beta\n');
  decide(state, [{ action: 'integrate', id: 'beta' }]);
  advanceImplementState(root, state);
  assert.equal(beta.status, 'integrated');
  assert.equal(await readFile(join(state.workspace.path, 'shared.txt'), 'utf8'), 'alpha and beta\n');
  assert.equal(beta.conflictHistory.length, 1);
  assert.equal(candidateApprovalProblems(state, alpha).length, 0);
});

test('a changed ready candidate is rejected before integration without touching the combined tree', async t => {
  const { root, state } = await fixture(t);
  decide(state, [{ action: 'admit', id: 'alpha', assignment: 'Create alpha' }]);
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  const before = snapshot(state.workspace);
  decide(state, [{ action: 'integrate', id: 'alpha' }]);
  await writeFile(join(state.implements.instances.alpha.workspace.path, 'alpha.txt'), 'unreviewed');
  advanceImplementState(root, state);
  assert.equal(state.implements.instances.alpha.status, 'changes_requested');
  assert.equal(snapshot(state.workspace), before);
});

import { workflowView } from './ui-data.mjs';

test('UI projection exposes one workflow, real scoped participants and waiting instances without invented calls', async t => {
  const { root, state } = await fixture(t);
  decide(state, ['alpha', 'beta', 'gamma'].map(id => ({ action: 'admit', id, assignment: `Create ${id}` })));
  advanceImplementState(root, state);
  for (const visit of state.visits.filter(visit => visit.implementId)) visit.admitted = true;
  const view = workflowView(state, { root, owned: true });
  assert.equal(view.id, state.id);
  assert.equal(view.implements.instances.length, 3);
  const platform = view.graph.nodes.find(node => node.id === 'implements');
  assert.equal(platform.instances[2].waitingReason, 'dependencies');
  assert.equal(platform.participants.length, 9);
  assert.equal(platform.participants.filter(person => person.active).length, 2);
  assert.equal(platform.participants.find(person => person.id === 'gamma/worker').invocations.length, 0);
  assert(platform.participants.find(person => person.id === 'alpha/worker').invocations[0].callDirectory.endsWith('implement_alpha'));
  assert(!view.graph.nodes.some(node => ['work', 'review', 'verify'].includes(node.id)), 'shared templates are not fake standalone platforms');
  const ids = new Set(view.graph.nodes.map(node => node.id));
  assert(view.graph.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)));
});

test('several addressed steering commands remain ordered and each gets its own saved worker input', async t => {
  const { root, state } = await fixture(t);
  decide(state, [{ action: 'admit', id: 'alpha', assignment: 'Initial work' }]);
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  state.controls = ['first', 'second'].map(id => ({ id, kind: 'steer', node: 'alpha', status: 'pending', text: id }));
  advanceImplementState(root, state);
  const first = state.visits.find(visit => visit.inputId === state.implements.instances.alpha.currentInputId);
  assert.equal(first.steering, 'first');
  assert.equal(state.controls[1].status, 'pending');
  assert.equal(first.taskContext.assignment.implement.text, 'first');
  finish(root, state, 'alpha', 'done');
  const second = state.visits.find(visit => visit.inputId === state.implements.instances.alpha.currentInputId);
  assert.equal(second.steering, 'second');
  assert.notEqual(second.inputId, first.inputId);
  assert.equal(second.sessionId, first.sessionId);
});

test('an addressed reviewer cannot substitute for the mandatory implement worker result', async t => {
  const { root, state } = await fixture(t);
  state.controls = [{ id: 'review-only', kind: 'steer', node: 'alpha/reviewer', status: 'pending', text: 'Review now' }];
  advanceImplementState(root, state);
  finish(root, state, 'alpha', 'approve');
  finish(root, state, 'alpha', 'approve');
  assert.equal(state.implements.instances.alpha.status, 'changes_requested');
  assert.match(state.implements.events.at(-1).problems[0], /worker/);
});

test('integration feedback reopens its implement and invalidates dependent results without discarding their files', async t => {
  const { root, state } = await fixture(t);
  decide(state, ['alpha', 'beta', 'gamma'].map(id => ({ action: 'admit', id, assignment: `Create ${id}` })));
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  await ready(root, state, 'beta', 'beta.txt', 'beta');
  decide(state, ['alpha', 'beta'].map(id => ({ action: 'integrate', id })));
  advanceImplementState(root, state);
  await ready(root, state, 'gamma', 'gamma.txt', 'gamma');
  decide(state, [{ action: 'integrate', id: 'gamma' }]);
  advanceImplementState(root, state);
  const betaRevision = state.implements.instances.beta.candidateRevision;
  const alphaSession = state.sessions['alpha/worker'];
  decide(state, [{ action: 'revise', id: 'alpha', assignment: 'Fix alpha after integration verification' },
    { action: 'revise', id: 'gamma', assignment: 'Recheck gamma against corrected alpha' }]);
  advanceImplementState(root, state);
  assert.equal(state.implements.instances.alpha.status, 'running');
  assert.equal(state.implements.instances.gamma.status, 'queued');
  assert.equal(state.visits.find(visit => visit.inputId === state.implements.instances.alpha.currentInputId).sessionId, alphaSession);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha-corrected');
  decide(state, [{ action: 'integrate', id: 'alpha' }]);
  advanceImplementState(root, state);
  assert.equal(await readFile(join(state.implements.instances.gamma.workspace.path, 'alpha.txt'), 'utf8'), 'alpha-corrected');
  assert.equal(await readFile(join(state.implements.instances.gamma.workspace.path, 'gamma.txt'), 'utf8'), 'gamma');
  finish(root, state, 'gamma', 'done');
  finish(root, state, 'gamma', 'approve');
  finish(root, state, 'gamma', 'approve');
  decide(state, [{ action: 'integrate', id: 'gamma' }]);
  advanceImplementState(root, state);
  assert.equal(state.implements.instances.gamma.status, 'integrated');
  assert.equal(state.implements.instances.alpha.resultVersion, 2);
  assert.equal(state.implements.instances.gamma.resultVersion, 2);
  assert.equal(state.implements.instances.beta.candidateRevision, betaRevision);
  assert.deepEqual(candidateApprovalProblems(state, state.implements.instances.beta), []);
  for (const id of ['beta', 'gamma']) assert.equal(await readFile(join(state.workspace.path, `${id}.txt`), 'utf8'), id);
});

test('empty integration-check maps cannot substitute for actual combined approvals even with merge:false', () => {
  const definition = implementDefinition();
  definition.merge = false;
  definition.groups = { integrationReviews: { member: 'integrationReview', items: [] }, integrationVerifiers: { member: 'integrationVerify', items: [] } };
  const state = { definition, implements: { instances: Object.fromEntries(['alpha', 'beta', 'gamma'].map(id => [id, { status: 'integrated' }])) },
    visits: ['integrationReviews', 'integrationVerifiers'].map(node => ({ node, children: [], verdict: { outcome: 'done', summary: 'empty' } })) };
  assert.throws(() => checkApprovals(state, 'combined'), /фактические одобрения/);
});

import { admit } from './opencode-runtime.mjs';

test('native admission rejects a different scoped participant even within the same workflow', async () => {
  const expected = { dwfRunId: 'one', dwfImplementId: 'alpha', dwfTaskId: 'alpha', dwfParticipant: 'alpha/worker' };
  let sent = false;
  const client = { session: { get: async () => ({ metadata: { ...expected, dwfParticipant: 'alpha/reviewer' } }),
    prompt: async () => { sent = true; } } };
  await assert.rejects(admit(client, { id: 'one', sessionId: 'session', inputId: 'input',
    request: { text: 'work', session: { metadata: expected, location: { directory: '/candidate' } } } }), /implement/);
  assert.equal(sent, false);
});

async function conflictFixture(t) {
  const fixtureState = await fixture(t);
  const { root, state } = fixtureState;
  decide(state, ['alpha', 'beta'].map(id => ({ action: 'admit', id, assignment: `Change shared to ${id}` })));
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'shared.txt', 'alpha\n');
  await ready(root, state, 'beta', 'shared.txt', 'beta\n');
  decide(state, ['alpha', 'beta'].map(id => ({ action: 'integrate', id })));
  advanceImplementState(root, state);
  assert.equal(state.implements.instances.beta.status, 'conflict');
  return { ...fixtureState, beta: state.implements.instances.beta };
}

test('conflict replacement preserves late originals before reset and replays the persisted before/after intent', async t => {
  const { root, state, beta } = await conflictFixture(t);
  await writeFile(join(beta.workspace.path, 'shared.txt'), 'late candidate edit\n');
  await writeFile(join(beta.workspace.path, 'late.bin'), Buffer.from([0, 1, 255]));
  const before = snapshot(beta.workspace);
  decide(state, [{ action: 'revise', id: 'beta', assignment: 'Resolve conflict and keep late edits' }]);
  advanceOnce(root, state); // intent must commit before replacing any files
  assert.equal(snapshot(beta.workspace), before);
  const intent = structuredClone(beta.integration.resolution);
  assert.equal(intent.candidateRevision, before);
  assert.equal(await readFile(join(intent.candidateWorkspace.path, 'shared.txt'), 'utf8'), 'late candidate edit\n');
  assert.deepEqual(await readFile(join(intent.candidateWorkspace.path, 'late.bin')), Buffer.from([0, 1, 255]));
  const saved = structuredClone(state); // simulate the durable transaction boundary
  advanceOnce(root, state);
  assert.equal(snapshot(beta.workspace), intent.conflictRevision);
  // Git completed but SQLite did not: replay the saved intent against the replaced directory.
  advanceOnce(root, saved);
  const recovered = saved.implements.instances.beta;
  assert.equal(recovered.phase, 'worker');
  assert.equal(recovered.status, 'running');
  assert.equal(recovered.conflictHistory.length, 1);
  assert.equal(snapshot(recovered.workspace), intent.conflictRevision);
  assert.equal(await readFile(join(intent.candidateWorkspace.path, 'shared.txt'), 'utf8'), 'late candidate edit\n');
  assert.equal(recovered.integration.resolution.status, 'replaced');
});

for (const target of ['candidate', 'combined', 'conflict']) {
  test(`conflict replacement rejects changed ${target} after durable intent without overwriting any tree`, async t => {
    const { root, state, beta } = await conflictFixture(t);
    decide(state, [{ action: 'revise', id: 'beta', assignment: 'Resolve conflict' }]);
    advanceOnce(root, state);
    const workspace = target === 'candidate' ? beta.workspace : target === 'combined' ? state.workspace : beta.integration.workspace;
    await writeFile(join(workspace.path, 'unexpected.txt'), `late ${target}`);
    const before = [beta.workspace, state.workspace, beta.integration.workspace].map(snapshot);
    assert.throws(() => advanceOnce(root, state), /измен|соответств/);
    assert.deepEqual([beta.workspace, state.workspace, beta.integration.workspace].map(snapshot), before);
  });
}


test('verifier findings automatically return to the original worker without another controller decision', async t => {
  const { root, state } = await fixture(t);
  decide(state, [{ action: 'admit', id: 'alpha', assignment: 'Create alpha' }]);
  advanceImplementState(root, state);
  const first = finish(root, state, 'alpha', 'done');
  finish(root, state, 'alpha', 'approve');
  const verifier = finish(root, state, 'alpha', 'changes');
  const alpha = state.implements.instances.alpha;
  const corrected = state.visits.find(visit => visit.inputId === alpha.currentInputId);
  assert.equal(alpha.status, 'running');
  assert.equal(alpha.phase, 'worker');
  assert.equal(corrected.sessionId, first.sessionId);
  assert.match(corrected.prompt, new RegExp(verifier.verdict.summary));
  assert.equal(state.visits.filter(visit => visit.node === 'manage').length, 1);
  assert.equal(state.implements.events.at(-1).type, 'changes');
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
});

test('candidate refresh rejects late edits after its saved preparation instead of overwriting them', async t => {
  const { root, state } = await fixture(t);
  decide(state, [{ action: 'admit', id: 'alpha', assignment: 'Create alpha' }]);
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  decide(state, [{ action: 'integrate', id: 'alpha' }]);
  advanceImplementState(root, state);
  decide(state, [{ action: 'revise', id: 'alpha', assignment: 'Fix integrated alpha' }]);
  advanceOnce(root, state);
  assert.equal(state.implements.instances.alpha.refresh.status, 'prepared');
  await writeFile(join(state.implements.instances.alpha.workspace.path, 'shared.txt'), 'late edit after refresh preparation');
  const before = snapshot(state.implements.instances.alpha.workspace);
  assert.throws(() => advanceOnce(root, state), /измен/);
  assert.equal(snapshot(state.implements.instances.alpha.workspace), before);
});

test('candidate refresh replays a saved intent after Git replacement without duplicating local edits', async t => {
  const { root, state } = await fixture(t);
  decide(state, [{ action: 'admit', id: 'alpha', assignment: 'Create alpha' }]);
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  decide(state, [{ action: 'integrate', id: 'alpha' }]);
  advanceImplementState(root, state);
  const alpha = state.implements.instances.alpha;
  await writeFile(join(alpha.workspace.path, 'local.bin'), Buffer.from([1, 0, 255]));
  decide(state, [{ action: 'revise', id: 'alpha', assignment: 'Fix integrated alpha; keep local edits' }]);
  advanceOnce(root, state);
  const saved = structuredClone(state);
  advanceOnce(root, state);
  const expected = snapshot(alpha.workspace);
  advanceOnce(root, saved);
  const recovered = saved.implements.instances.alpha;
  assert.equal(recovered.status, 'running');
  assert.equal(snapshot(recovered.workspace), expected);
  assert.equal(recovered.refreshHistory.length, 1);
  assert.deepEqual(await readFile(join(recovered.workspace.path, 'local.bin')), Buffer.from([1, 0, 255]));
});

for (const replacement of ['refresh', 'conflict']) {
  test(`independent integration and ${replacement} revision share a decision without invalidating the saved replacement`, async t => {
    const { root, state } = await fixture(t);
    state.definition.taskPackages.find(task => task.id === 'gamma').dependencies = [];
    decide(state, ['alpha', 'beta', 'gamma'].map(id => ({ action: 'admit', id, assignment: `Create ${id}` })));
    advanceImplementState(root, state);
    await ready(root, state, 'alpha', replacement === 'conflict' ? 'shared.txt' : 'alpha.txt', 'alpha\n');
    await ready(root, state, 'beta', replacement === 'conflict' ? 'shared.txt' : 'beta.txt', 'beta\n');
    await ready(root, state, 'gamma', 'gamma.txt', 'gamma\n');
    const { alpha, beta, gamma } = state.implements.instances;
    decide(state, (replacement === 'conflict' ? ['alpha', 'beta'] : ['beta']).map(id => ({ action: 'integrate', id })));
    advanceImplementState(root, state);
    assert.equal(beta.status, replacement === 'conflict' ? 'conflict' : 'integrated');
    const independent = replacement === 'conflict' ? gamma : alpha;
    const session = state.sessions['beta/worker'];
    await writeFile(join(beta.workspace.path, 'late.bin'), Buffer.from([0, 255, 2]));
    decide(state, [{ action: 'integrate', id: independent.id }, { action: 'revise', id: 'beta', assignment: 'Correct beta and preserve late files' }]);
    advanceOnce(root, state); // both operation intents can be saved on the same common base
    const intent = replacement === 'conflict' ? beta.integration.resolution : beta.refresh;
    assert.equal(intent.status, 'prepared');
    const beforeIntegration = snapshot(state.workspace);
    const saved = structuredClone(state);
    advanceOnce(root, state); // replacement must commit before the independent common-tree write
    assert.equal(snapshot(state.workspace), beforeIntegration);
    advanceOnce(root, saved); // Git changed, SQLite rolled back: replay both saved intents
    assert.equal(snapshot(saved.workspace), beforeIntegration);
    assert.equal(snapshot(saved.implements.instances.beta.workspace), snapshot(beta.workspace));
    assert.equal(saved.implements.instances.beta.status, 'running');
    assert.equal(beta.status, 'running');
    assert.equal(state.visits.find(v => v.inputId === beta.currentInputId).sessionId, session);
    if (replacement === 'conflict') {
      assert.deepEqual(await readFile(join(intent.candidateWorkspace.path, 'late.bin')), Buffer.from([0, 255, 2]));
      assert.match(await readFile(join(beta.workspace.path, 'shared.txt'), 'utf8'), /<<<<<<</);
    } else assert.deepEqual(await readFile(join(beta.workspace.path, 'late.bin')), Buffer.from([0, 255, 2]));
    advanceImplementState(root, state);
    assert.equal(independent.status, 'integrated');
    assert.deepEqual(candidateApprovalProblems(state, independent), []);
    assert.equal(await readFile(join(state.workspace.path, `${independent.id}.txt`), 'utf8'), `${independent.id}\n`);
    assert.throws(() => checkApprovals(state, snapshot(state.workspace)), /implement/i);
    await ready(root, state, 'beta', replacement === 'conflict' ? 'shared.txt' : 'beta.txt', 'beta corrected\n');
    decide(state, [{ action: 'integrate', id: 'beta' }]);
    advanceImplementState(root, state);
    assert.equal(beta.status, 'integrated');
    assert.equal(await readFile(join(state.workspace.path, replacement === 'conflict' ? 'shared.txt' : 'beta.txt'), 'utf8'), 'beta corrected\n');
  });
}

test('a prepared dependent refresh waits for a reopened dependency without reserving the common tree forever', async t => {
  const { root, state } = await fixture(t);
  decide(state, ['alpha', 'beta', 'gamma'].map(id => ({ action: 'admit', id, assignment: `Create ${id}` })));
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  await ready(root, state, 'beta', 'beta.txt', 'beta');
  decide(state, ['alpha', 'beta'].map(id => ({ action: 'integrate', id })));
  advanceImplementState(root, state);
  await ready(root, state, 'gamma', 'gamma.txt', 'gamma');
  decide(state, [{ action: 'integrate', id: 'gamma' }]);
  advanceImplementState(root, state);
  decide(state, [{ action: 'revise', id: 'gamma', assignment: 'Revise gamma' }]);
  advanceOnce(root, state);
  const oldRefresh = state.implements.instances.gamma.refresh;
  assert.equal(oldRefresh.status, 'prepared');
  decide(state, [{ action: 'revise', id: 'alpha', assignment: 'Correct alpha first' }]);
  advanceImplementState(root, state);
  assert.equal(state.implements.instances.gamma.status, 'queued');
  await ready(root, state, 'alpha', 'alpha.txt', 'corrected alpha');
  decide(state, [{ action: 'integrate', id: 'alpha' }]);
  advanceImplementState(root, state);
  assert.equal(oldRefresh.status, 'superseded');
  assert.equal(state.implements.instances.gamma.status, 'running');
  assert.equal(await readFile(join(state.implements.instances.gamma.workspace.path, 'alpha.txt'), 'utf8'), 'corrected alpha');
  assert.equal(await readFile(join(state.implements.instances.gamma.workspace.path, 'gamma.txt'), 'utf8'), 'gamma');
});

test('prepared replacements release the common-tree barrier even when all native cycle slots are occupied', async t => {
  const { root, state } = await fixture(t);
  state.definition.taskPackages.find(task => task.id === 'gamma').dependencies = [];
  state.definition.taskPackages.push({ ...structuredClone(state.definition.taskPackages[0]), id: 'delta' });
  state.definition.implements.instances.delta = { ...state.definition.implements.instances.alpha, taskId: 'delta' };
  delete state.implements;
  initializeImplements(state);
  decide(state, ['alpha', 'beta'].map(id => ({ action: 'admit', id, assignment: `Create ${id}` })));
  advanceImplementState(root, state);
  await ready(root, state, 'alpha', 'alpha.txt', 'alpha');
  await ready(root, state, 'beta', 'beta.txt', 'beta');
  decide(state, [{ action: 'integrate', id: 'beta' }]);
  advanceImplementState(root, state);
  decide(state, [{ action: 'integrate', id: 'alpha' }, { action: 'revise', id: 'beta', assignment: 'Correct beta' },
    ...['gamma', 'delta'].map(id => ({ action: 'admit', id, assignment: `Create ${id}` }))]);
  advanceOnce(root, state);
  const { alpha, beta, gamma, delta } = state.implements.instances;
  assert.equal(beta.refresh.status, 'prepared');
  assert.equal(gamma.status, 'running');
  assert.equal(delta.status, 'running');
  const currentInputId = beta.currentInputId;
  advanceOnce(root, state);
  assert.equal(beta.refresh.status, 'refreshed');
  assert.equal(beta.currentInputId, currentInputId, 'replacement does not admit a worker beyond the explicit limit');
  assert.equal(beta.status, 'queued');
  advanceImplementState(root, state);
  assert.equal(alpha.status, 'integrated', 'common-tree integration does not wait for a native slot');
  assert.equal(await readFile(join(state.workspace.path, 'alpha.txt'), 'utf8'), 'alpha');
  await ready(root, state, 'gamma', 'gamma.txt', 'gamma');
  assert.equal(beta.status, 'running');
  assert.equal(state.visits.find(v => v.inputId === beta.currentInputId).participant, 'beta/worker');
});

for (const refreshed of ['conflict', 'clean']) {
  test(`dependency refresh (${refreshed}) supersedes an older integration conflict before worker admission and replays without restoring old dependency files`, async t => {
    const { root, state } = await fixture(t);
    state.definition.taskPackages.find(task => task.id === 'beta').dependencies = ['gamma'];
    state.definition.taskPackages.find(task => task.id === 'gamma').dependencies = [];
    decide(state, ['alpha', 'beta', 'gamma'].map(id => ({ action: 'admit', id, assignment: `Create ${id}` })));
    advanceImplementState(root, state);
    await ready(root, state, 'gamma', 'gamma.txt', 'gamma-v1');
    decide(state, [{ action: 'integrate', id: 'gamma' }]);
    advanceImplementState(root, state);
    await ready(root, state, 'alpha', 'shared.txt', 'alpha\n');
    await ready(root, state, 'beta', 'shared.txt', 'beta\n');
    decide(state, ['alpha', 'beta'].map(id => ({ action: 'integrate', id })));
    advanceImplementState(root, state);
    const { beta, gamma } = state.implements.instances;
    assert.equal(beta.status, 'conflict');
    const oldConflict = structuredClone(beta.integration);
    assert.equal(await readFile(join(oldConflict.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v1');
    const originalSession = state.sessions['beta/worker'];
    await writeFile(join(beta.workspace.path, 'late.bin'), Buffer.from([0, 1, 255]));
    decide(state, [{ action: 'revise', id: 'gamma', assignment: 'Update gamma to v2' },
      { action: 'revise', id: 'beta', assignment: 'Resolve beta against the updated dependency' }]);
    advanceImplementState(root, state);
    assert.equal(beta.status, 'queued');
    if (refreshed === 'clean') await writeFile(join(gamma.workspace.path, 'shared.txt'), 'beta\n');
    await ready(root, state, 'gamma', 'gamma.txt', 'gamma-v2');
    decide(state, [{ action: 'integrate', id: 'gamma' }]);
    advanceOnce(root, state);
    advanceOnce(root, state);
    assert.equal(gamma.resultVersion, 2);
    assert.equal(beta.refresh.status, 'prepared');
    const saved = structuredClone(state); // last durable boundary before replacement
    advanceOnce(root, state);
    advanceOnce(root, state); // an older integration conflict must not undo this refresh
    assert.equal(await readFile(join(beta.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v2');
    assert.equal(beta.status, 'running');
    assert.deepEqual(beta.dependencyResults, { gamma: 2 });
    const visit = state.visits.find(v => v.inputId === beta.currentInputId);
    assert.equal(visit.sessionId, originalSession);
    assert.equal(visit.taskContext.dependencies[0].resultVersion, 2);
    if (refreshed === 'conflict') {
      assert.equal(visit.taskContext.implement.conflict.id, beta.refresh.id);
      assert.match(await readFile(join(beta.workspace.path, 'shared.txt'), 'utf8'), /<<<<<<<[\s\S]*alpha[\s\S]*beta/);
    } else {
      assert.equal(visit.taskContext.implement.conflict, undefined);
      assert.equal(await readFile(join(beta.workspace.path, 'shared.txt'), 'utf8'), 'beta\n');
    }
    assert.deepEqual(await readFile(join(beta.workspace.path, 'late.bin')), Buffer.from([0, 1, 255]));
    assert.equal(beta.integration.status, 'superseded');
    assert.equal(beta.integration.supersededBy, beta.refresh.id);
    assert.equal(beta.conflictHistory.find(op => op.id === oldConflict.id).supersededBy, beta.refresh.id);
    assert.equal(await readFile(join(oldConflict.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v1');
    const expected = snapshot(beta.workspace);
    advanceOnce(root, saved); // Git replacement completed, but SQLite rolled back
    const recovered = saved.implements.instances.beta;
    assert.equal(recovered.status, 'running');
    assert.equal(snapshot(recovered.workspace), expected);
    assert.equal(recovered.integration.status, 'superseded');
    assert.equal(recovered.conflictHistory.filter(op => op.id === oldConflict.id).length, 1);
    assert.equal(await readFile(join(recovered.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v2');
    assert.deepEqual(candidateApprovalProblems(saved, recovered).filter(problem => problem.includes('зависимости')), []);
    await ready(root, saved, 'beta', 'shared.txt', 'alpha and beta\n');
    decide(saved, [{ action: 'integrate', id: 'beta' }]);
    advanceImplementState(root, saved);
    assert.equal(recovered.status, 'integrated');
    assert.equal(await readFile(join(saved.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v2');
  });
}
