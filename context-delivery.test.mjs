import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRoleInput } from './role-context.mjs';
import { acknowledgeContext } from './context-delivery.mjs';
import { eightTasks } from './acceptance/context-fixture.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dwf-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { id: 'delivery', definition: eightTasks(), visits: [], workspace: { path: root }, taskRevisions: [] };
  let index = 0;
  const build = (node = 'manager', options = {}) => {
    const taskId = state.definition.nodes[node].taskId;
    const visit = { node, participant: node, sessionId: 'ses_' + node, inputId: 'msg_' + ++index,
      admissionStarted: false, revision: 'candidate', ...(taskId ? { taskId, taskVersion: 1 + state.taskRevisions.filter(r => r.taskId === taskId).length } : {}), ...options };
    prepareRoleInput(root, state, visit, undefined);
    state.visits.push(visit);
    return visit;
  };
  const ack = visit => { visit.admissionStarted = true; visit.admitted = true; acknowledgeContext(visit); };
  return { root, state, build, ack };
}
const wire = visit => JSON.parse(visit.prompt.match(/Task\/context data:\n([^\n]+)/)[1]);
// Independent JSON Pointer patch consumer: the payload must reproduce the exact current snapshot.
function apply(base, updates) {
  const result = structuredClone(base);
  for (const update of updates) {
    const keys = update.path.slice(1).split('/').map(k => k.replaceAll('~1', '/').replaceAll('~0', '~'));
    const key = keys.pop();
    const parent = keys.reduce((obj, key) => obj[key], result);
    if (update.op === 'move') {
      const from = update.from.slice(1).split('/').map(k => k.replaceAll('~1', '/').replaceAll('~0', '~'));
      const sourceKey = from.pop();
      const source = from.reduce((obj, key) => obj[key], result);
      const [value] = source.splice(Number(sourceKey), 1);
      parent.splice(Number(key), 0, value);
    } else if (update.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else if (update.op === 'add' && Array.isArray(parent)) parent.splice(Number(key), 0, update.value);
    else parent[key] = update.value;
  }
  return result;
}

test('only acknowledged inputs advance a participant/session delivery base; prepared and lost ack drafts do not', t => {
  const { build, ack } = fixture(t);
  const first = build();
  assert.equal(first.delivery.mode, 'snapshot');
  first.admissionStarted = true; // send may have happened, acknowledgement did not
  const unconfirmed = build();
  assert.equal(unconfirmed.delivery.mode, 'snapshot');
  ack(first);
  const next = build();
  assert.equal(next.delivery.baseInputId, first.inputId);
  assert.equal(next.delivery.mode, 'delta');
  assert.deepEqual(apply(first.taskContext, wire(next).updates), next.taskContext);
  assert.equal(first.delivery.acknowledged, true);
  assert.equal(next.delivery.acknowledged, false);
});

test('multi-round manager transmits new results and decisions, not accumulated history', t => {
  const { state, build, ack } = fixture(t);
  let previous = build();
  ack(previous);
  let full = 0, delta = 0;
  for (let round = 1; round <= 4; round++) {
    state.visits.push({ node: `worker${round}`, participant: `worker${round}`, taskId: `task-${round}`,
      inputId: `result-${round}`, verdict: { outcome: 'done', summary: `NEW_RESULT_${round}_` + 'evidence '.repeat(400) } });
    state.taskRevisions.push({ taskId: 'task-0', version: round + 1, kind: 'decision', text: `NEW_DECISION_${round}`,
      source: `steer:${round}`, createdAt: round });
    const current = build();
    const payload = wire(current);
    assert.deepEqual(apply(previous.taskContext, payload.updates), current.taskContext);
    assert(current.prompt.includes(`NEW_RESULT_${round}_`));
    assert(current.prompt.includes(`NEW_DECISION_${round}`));
    for (let old = 1; old < round; old++) {
      assert(!current.prompt.includes(`NEW_RESULT_${old}_`));
      assert(!current.prompt.includes(`NEW_DECISION_${old}`));
    }
    assert.deepEqual(JSON.parse(readFileSync(current.delivery.snapshot.path)), current.taskContext);
    assert(JSON.parse(readFileSync(current.taskContext.history.path)).some(r => r.inputId === 'result-1'));
    full += JSON.stringify(current.taskContext).length;
    delta += JSON.stringify(payload).length;
    ack(current); previous = current;
  }
  assert(delta < full * 0.65, `${delta} delta vs ${full} full UTF-16 units`);
  t.diagnostic(`Four manager returns: ${delta} delta vs ${full} full UTF-16 units`);
});

test('fresh sessions, memory:false, legacy and read-disabled participants receive current snapshots', t => {
  const { state, build, ack } = fixture(t);
  const first = build('worker0'); ack(first);
  state.taskRevisions.push({ taskId: 'task-0', version: 2, kind: 'decision', text: 'CURRENT_DECISION', source: 'steer:new', createdAt: 1 });
  for (const options of [{ sessionId: 'ses_fresh' }, { participant: 'mapped-other' }]) {
    const next = build('worker0', options);
    assert.equal(next.delivery.mode, 'snapshot');
    assert(next.prompt.includes('CURRENT_DECISION'));
    assert(wire(next).task.requirements);
  }
  state.participants = { worker0: { memory: false, agent: {} } };
  assert.equal(build('worker0').delivery.mode, 'snapshot');
  state.participants = { worker0: { agent: { permissions: [{ effect: 'allow', action: 'grep' }] } } };
  assert.equal(build('worker0').delivery.mode, 'snapshot');
  delete state.participants;
  delete first.delivery;
  assert.equal(build('worker0').delivery.mode, 'snapshot');
});

test('group and implement identities do not share cursors; findings and revisions round trip exactly', t => {
  const { state, build, ack } = fixture(t);
  const first = build('worker0', { participant: 'alpha/worker', implementId: 'alpha' }); ack(first);
  state.visits.splice(state.visits.indexOf(first), 1, { node: 'group', children: [first] });
  const own = build('worker0', { participant: 'alpha/worker', implementId: 'alpha' });
  assert.equal(own.delivery.baseInputId, first.inputId);
  assert.equal(build('worker0', { participant: 'beta/worker', implementId: 'beta' }).delivery.mode, 'snapshot');
  assert.equal(build('worker0', { participant: 'alpha/reviewer', implementId: 'alpha' }).delivery.mode, 'snapshot');
  assert.deepEqual(apply(first.taskContext, wire(own).updates), own.taskContext);
});


test('returning participants do not resend unchanged neighbours when latest reports reorder', t => {
  const { state, build, ack } = fixture(t);
  state.visits.push(...[0, 1].map(i => ({ node: 'worker' + i, participant: 'worker' + i, inputId: 'old-' + i,
    verdict: { outcome: 'done', summary: 'OLD_NEIGHBOUR_' + i } })));
  const first = build(); ack(first);
  state.visits.push({ node: 'worker0', participant: 'worker0', inputId: 'new-0', verdict: { outcome: 'done', summary: 'NEW_RESULT' } });
  const next = build();
  assert(next.prompt.includes('NEW_RESULT'));
  assert(!next.prompt.includes('OLD_NEIGHBOUR_'));
  assert.deepEqual(apply(first.taskContext, wire(next).updates), next.taskContext);
});

test('a cancelled prepared delta cannot consume decisions; replacement includes every unacknowledged revision', t => {
  const { state, build, ack } = fixture(t);
  const first = build('worker0'); ack(first);
  const revision = (version, text) => ({ taskId: 'task-0', version, kind: 'decision', text, source: 'steer:' + version, createdAt: version });
  state.taskRevisions.push(revision(2, 'UNRECEIVED_DECISION'));
  const cancelled = build('worker0');
  state.visits.splice(state.visits.indexOf(cancelled), 1);
  state.taskRevisions.push(revision(3, 'FOLLOWUP_DECISION'));
  const next = build('worker0');
  assert.equal(next.delivery.baseInputId, first.inputId);
  assert(next.prompt.includes('UNRECEIVED_DECISION'));
  assert(next.prompt.includes('FOLLOWUP_DECISION'));
  assert.deepEqual(apply(first.taskContext, wire(next).updates), next.taskContext);
});

test('delta reproduces removals, moves, escaped keys and changed exact requirements without clipping', t => {
  const { build, ack } = fixture(t);
  const first = build('worker0', { item: { 'key/~': ['a', 'b', 'c'], choices: [{ id: 'a', value: 'A' }, { id: 'b', value: 'B' }], instructions: 'Old instruction' } }); ack(first);
  const next = build('worker0', { item: { 'key/~': ['changed\r\n', 'b'], choices: [{ id: 'b', value: 'B' }, { id: 'a', value: 'A' }], instructions: 'Exact\r\nnew instruction\n' } });
  assert.deepEqual(apply(first.taskContext, wire(next).updates), next.taskContext);
  assert(wire(next).updates.some(p => p.path.includes('key~1~0')));
  assert(wire(next).updates.some(p => p.op === 'move'));
});

test('durable acknowledgement and immutable retry bytes survive takeover; stale owners cannot advance delivery', async t => {
  const { createWorkflow, claimWorkflow, getWorkflow, updateWorkflow, withWorkflowAction } = await import('./run-store.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const { root, state, build, ack } = fixture(t);
  state.status = 'running'; state.sessions = {};
  const visit = build(); visit.admissionStarted = true;
  createWorkflow(root, state);
  assert(claimWorkflow(root, state.id, 'old'));
  const originalBytes = visit.prompt;
  const db = new DatabaseSync(join(root, 'dwf.sqlite'));
  db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(state.id); db.close();
  assert(claimWorkflow(root, state.id, 'replacement'));
  ack(visit); // a late transport response in the old process is not durable proof
  assert.throws(() => updateWorkflow(root, state, 'old'), /владение/);
  await assert.rejects(withWorkflowAction(root, state, 'old', () => { throw new Error('must not execute'); }), /владение/);
  const recovered = getWorkflow(root, state.id);
  assert.equal(recovered.visits[0].delivery.acknowledged, false);
  assert.equal(recovered.visits[0].prompt, originalBytes);
  const retry = recovered.visits[0]; retry.admitted = true; acknowledgeContext(retry);
  updateWorkflow(root, recovered, 'replacement');
  assert.equal(getWorkflow(root, state.id).visits[0].delivery.acknowledged, true);
  for (const mutate of [v => { v.delivery.baseInputId = 'other'; }, v => { v.delivery.acknowledged = false; },
    v => { v.prompt += 'changed'; }, v => { v.sessionId = 'other'; }]) {
    const changed = getWorkflow(root, state.id); mutate(changed.visits[0]);
    assert.throws(() => updateWorkflow(root, changed, 'replacement'), /Task packages:/);
  }
});

test('unbound legacy-scope steering remains exact current requirements/decisions after context loss', t => {
  const { state, build, ack } = fixture(t);
  delete state.definition.taskPackages;
  for (const node of Object.values(state.definition.nodes)) delete node.taskId;
  state.controls = [];
  const first = build('worker0'); ack(first);
  state.controls.push({ id: 'decision-1', node: 'worker0', kind: 'steer', revisionKind: 'decision', status: 'applied',
    text: 'EXACT_UNBOUND_DECISION\r\n', createdAt: 1 });
  state.controls.push({ id: 'legacy-note', node: 'worker0', kind: 'steer', status: 'pending', text: 'PRIOR_UNBOUND_CLARIFICATION', createdAt: 2 });
  const next = build('worker0');
  assert(next.prompt.includes('EXACT_UNBOUND_DECISION'));
  assert.equal(next.taskContext.userInputs[0].source, 'steer:decision-1');
  assert.equal(next.taskContext.userInputs[0].kind, 'decision');
  assert.equal(next.taskContext.userInputs[1].kind, undefined, 'old commands must not be classified retrospectively');
  ack(next);
  const restored = build('worker0', { sessionId: 'ses_restored' });
  assert.equal(restored.delivery.mode, 'snapshot');
  assert(restored.prompt.includes('EXACT_UNBOUND_DECISION'));
  assert(restored.prompt.includes('PRIOR_UNBOUND_CLARIFICATION'));
  const manager = build();
  assert(manager.prompt.includes('EXACT_UNBOUND_DECISION'));
});

test('unbound decision classification is persisted by public steering command storage without inventing a package', async t => {
  const { createWorkflow, queueWorkflowCommand, getWorkflow } = await import('./run-store.mjs');
  const { root, state } = fixture(t);
  state.definition = { task: 'Legacy whole-workflow requirements', nodes: { manager: { role: 'orchestrator' } } };
  state.status = 'running';
  createWorkflow(root, state);
  const command = queueWorkflowCommand(root, state.id, 'steer', 'manager', 'Exact unbound decision\r\n', 'decision');
  assert.equal(command.revisionKind, 'decision');
  const saved = getWorkflow(root, state.id);
  assert.equal(saved.controls[0].revisionKind, 'decision');
  assert.equal(saved.controls[0].text, 'Exact unbound decision\r\n');
  assert.equal(saved.taskRevisions?.length ?? 0, 0);
});
