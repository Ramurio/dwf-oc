import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkflow, getWorkflow, queueWorkflowCommand, claimWorkflow, updateWorkflow, withWorkflowAction } from './run-store.mjs';
import { continueWorkflow, checkContinuationAdmission } from './workflow-continuation.mjs';
import { snapshot, git, verificationWorkspace } from './workflow-git.mjs';
import { prepareRoleInput } from './role-context.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dwf-continuation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = { mode: 'directory', path: join(root, 'project') };
  mkdirSync(workspace.path);
  const state = { id: randomUUID(), status: 'failed', error: 'provider.auth HTTP 403: Forbidden',
    workspace, sessions: {}, visits: [], definition: { task: 'Keep exact requirements', workspace: 'directory', entry: 'work',
      nodes: { work: { role: 'worker', tools: [], skills: [] } }, transitions: { work: { done: null } } }, ...options };
  return { root, state, save: () => createWorkflow(root, state) };
}
function visit(f) {
  const v = { node: 'work', participant: 'work', inputId: 'msg_' + randomUUID(), sessionId: 'ses_' + randomUUID(),
    revision: snapshot(f.state.workspace), admissionStarted: true, admitted: true, execution: { status: 'failed', error: f.state.error } };
  prepareRoleInput(f.root, f.state, v);
  f.state.visits.push(v);
  return v;
}
const failed = { observe: async () => ({ outcome: { status: 'failed', error: 'provider.auth HTTP 403' } }), client: {} };

test('continue preserves immutable input, requirements and error; new attempt uses the same session, and running/succeeded are no-ops', async t => {
  const f = fixture(t); const old = visit(f); const original = structuredClone(old); f.save();
  const state = await continueWorkflow(f.root, f.state.id, {}, failed);
  assert.equal(state.status, 'running'); assert.equal(state.visits.length, 2);
  assert.deepEqual({ ...state.visits[0], recoveredBy: undefined }, { ...original, recoveredBy: undefined });
  assert.equal(state.visits[1].sessionId, old.sessionId); assert.notEqual(state.visits[1].inputId, old.inputId);
  assert.equal(state.visits[1].taskContext.task.requirements, f.state.definition.task);
  assert.match(state.visits[1].prompt, /DWF continuation/);
  assert.equal(state.recoveryHistory[0].error, f.state.error);
  assert.equal(JSON.stringify(await continueWorkflow(f.root, state.id)), JSON.stringify(state));
  assert(claimWorkflow(f.root, state.id, 'owner'));
  await withWorkflowAction(f.root, state, 'owner', () => { state.status = 'succeeded'; });
  assert.equal((await continueWorkflow(f.root, state.id)).visits.length, 2);
  assert.equal(getWorkflow(f.root, state.id).recoveryHistory.length, 1);
});

test('lost ack, pending work and saved success resume without creating an input', async t => {
  for (const native of [{ active: true }, { pending: true }, { outcome: { status: 'succeeded', result: '{}' } }, { absent: true }]) {
    const f = fixture(t); const old = visit(f); delete old.execution; old.admitted = false; f.save();
    const state = await continueWorkflow(f.root, f.state.id, {}, { client: {}, observe: async () => native });
    assert.equal(state.status, 'running'); assert.equal(state.visits.length, 1);
    assert.equal(state.visits[0].inputId, old.inputId); assert.equal(state.visits[0].prompt, old.prompt);
  }
});

test('unknown command requires a revision-bound decision, rejects stale decisions, and records confirm without forging a result', async t => {
  const f = fixture(t); const old = visit(f); f.save();
  const dependencies = { client: {}, observe: async () => ({ outcome: { status: 'failed' }, uncertain: [{ id: 'shell:1', kind: 'tool' }] }) };
  const blocked = await continueWorkflow(f.root, f.state.id, {}, dependencies);
  assert.equal(blocked.status, 'failed'); assert.equal(blocked.visits.length, 1);
  const resolution = blocked.recovery.resolutionTemplate;
  writeFileSync(join(f.state.workspace.path, 'changed'), 'changed');
  await assert.rejects(continueWorkflow(f.root, f.state.id, { resolution }, dependencies), /устарело/);
  const again = await continueWorkflow(f.root, f.state.id, {}, dependencies);
  const confirm = again.recovery.resolutionTemplate; confirm.decisions[0].action = 'confirm'; confirm.decisions[0].evidence = 'Checked remote result; do not repeat';
  const resumed = await continueWorkflow(f.root, f.state.id, { resolution: confirm }, dependencies);
  assert.equal(resumed.status, 'running'); assert.equal(resumed.visits[0].verdict, undefined);
  assert.equal(resumed.visits[1].verdict, undefined); assert.equal(resumed.visits[1].recoveryOf, old.inputId);
  assert.deepEqual(resumed.recoveryHistory[0].resolution, confirm);
});

test('cancelled requires explicit intent, keeps stop history and admits later controls', async t => {
  const f = fixture(t, { status: 'cancelled', controls: [{ id: 'stop-one', kind: 'stop', status: 'applied' }] }); visit(f); f.save();
  await assert.rejects(continueWorkflow(f.root, f.state.id, {}, failed), /resume-cancelled/);
  const state = await continueWorkflow(f.root, f.state.id, { resumeCancelled: true }, failed);
  assert.equal(state.status, 'running'); assert.equal(state.controls[0].status, 'applied'); assert(state.controls[0].resumedBy);
  assert.equal(queueWorkflowCommand(f.root, state.id, 'stop').status, 'pending');
});

test('continuation fences a stale terminal owner and concurrent callers create one retry', async t => {
  const f = fixture(t); visit(f); f.save(); assert(claimWorkflow(f.root, f.state.id, 'old'));
  const oldState = getWorkflow(f.root, f.state.id);
  await continueWorkflow(f.root, f.state.id, {}, failed);
  assert.throws(() => updateWorkflow(f.root, oldState, 'old'), /владение/);
  await continueWorkflow(f.root, f.state.id, {}, failed);
  assert.equal(getWorkflow(f.root, f.state.id).visits.length, 2);
});

test('environment diagnostics block without losing any saved attempt', async t => {
  const f = fixture(t); visit(f); f.save();
  const state = await continueWorkflow(f.root, f.state.id, {}, { client: {}, observe: async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); } });
  assert.equal(state.status, 'failed'); assert.equal(state.visits.length, 1);
  assert.match(state.recovery.reason, /EACCES/); assert.equal(state.error, f.state.error);
});

test('an unchanged template is not permission; abort is idempotent and does not reopen the run', async t => {
  const f = fixture(t); visit(f); f.save();
  const deps = { client: {}, observe: async () => ({ outcome: { status: 'failed' }, uncertain: [{ id: 'op', kind: 'tool' }] }) };
  const blocked = await continueWorkflow(f.root, f.state.id, {}, deps);
  const resolution = blocked.recovery.resolutionTemplate;
  await assert.rejects(continueWorkflow(f.root, f.state.id, { resolution }, deps), /устарело/);
  resolution.decisions[0].action = 'abort'; resolution.decisions[0].evidence = 'Do not proceed';
  const aborted = await continueWorkflow(f.root, f.state.id, { resolution }, deps);
  assert.equal(aborted.status, 'failed'); assert.equal(aborted.visits.length, 1);
  assert.equal(aborted.recovery.status, 'aborted');
  const again = await continueWorkflow(f.root, f.state.id, { resolution }, deps);
  assert.equal(again.recoveryHistory.length, 1);
});

test('read-only native recovery never creates a successful result from a retry decision', async t => {
  const f = fixture(t); visit(f); f.save();
  const deps = { client: {}, observe: async () => ({ absent: true, sessionMissing: true,
    uncertain: [{ id: 'missing', kind: 'missing_session' }] }) };
  const blocked = await continueWorkflow(f.root, f.state.id, {}, deps);
  const resolution = blocked.recovery.resolutionTemplate;
  resolution.decisions[0].action = 'retry'; resolution.decisions[0].evidence = 'Explicit retry permission';
  const state = await continueWorkflow(f.root, f.state.id, { resolution }, deps);
  assert.equal(state.status, 'running'); assert.notEqual(state.visits[0].sessionId, state.visits[1].sessionId);
  assert.equal(state.visits[1].verdict, undefined); assert.match(state.visits[1].prompt, /unavailable/);
});

test('recovery and failure audit prefixes cannot be rewritten by a controller', async t => {
  const f = fixture(t); visit(f); f.save();
  const state = await continueWorkflow(f.root, f.state.id, {}, failed);
  assert(claimWorkflow(f.root, state.id, 'owner'));
  state.recoveryHistory[0].error = 'erased';
  assert.throws(() => updateWorkflow(f.root, state, 'owner'), /история восстановления неизменяема/);
});

test('an accepted permission expires before admission when files change; preflight asks for a fresh decision', async t => {
  const f = fixture(t); visit(f); f.save();
  const deps = { client: {}, observe: async () => ({ outcome: { status: 'failed' }, uncertain: [{ id: 'op', kind: 'tool' }] }) };
  const blocked = await continueWorkflow(f.root, f.state.id, {}, deps);
  const resolution = blocked.recovery.resolutionTemplate; resolution.decisions[0].action = 'retry'; resolution.decisions[0].evidence = 'Allow once at this tree';
  const accepted = await continueWorkflow(f.root, f.state.id, { resolution }, deps);
  writeFileSync(join(f.state.workspace.path, 'late'), 'permission now stale');
  const changed = await continueWorkflow(f.root, f.state.id, {}, { client: {}, observe: async () => ({ absent: true }) });
  assert.equal(changed.recovery.status, 'blocked');
  assert.equal(changed.visits.length, accepted.visits.length);
  assert.equal(changed.recovery.problems[0].kind, 'stale_permission');
});

test('send boundary revalidates permission, but lost ack of an already accepted input preserves its bytes', async t => {
  const f = fixture(t); visit(f); f.save();
  const deps = { client: {}, observe: async () => ({ outcome: { status: 'failed' }, uncertain: [{ id: 'op', kind: 'tool' }] }) };
  const blocked = await continueWorkflow(f.root, f.state.id, {}, deps);
  const resolution = blocked.recovery.resolutionTemplate; resolution.decisions[0].action = 'retry'; resolution.decisions[0].evidence = 'Permit once';
  const state = await continueWorkflow(f.root, f.state.id, { resolution }, deps); const input = state.visits[1];
  writeFileSync(join(f.state.workspace.path, 'late'), 'changed');
  let messages = [];
  const client = { session: { get: async () => ({ metadata: { dwfRunId: state.id } }), active: async () => ({}), inbox: { list: async () => [] } },
    message: { list: async () => ({ data: messages, cursor: {} }) } };
  await assert.rejects(checkContinuationAdmission(client, state, input), /устарело до отправки/);
  messages = [{ id: input.inputId, type: 'user' }, { type: 'idle', outcome: 'failed' }];
  await checkContinuationAdmission(client, state, input);
  assert.equal(input.prompt, state.visits[1].prompt); assert.equal(input.admitted, undefined);
});

test('a saved blocked report is retained and gets a separate continuation with its explicit operation decisions', async t => {
  const f = fixture(t); const old = visit(f); old.verdict = { outcome: 'blocked', summary: 'External command interrupted' }; f.save();
  const deps = { client: {}, observe: async () => ({ outcome: { status: 'succeeded', result: '{}' }, uncertain: [{ id: 'op', kind: 'tool' }] }) };
  const blocked = await continueWorkflow(f.root, f.state.id, {}, deps);
  const resolution = blocked.recovery.resolutionTemplate; resolution.decisions[0].action = 'confirm'; resolution.decisions[0].evidence = 'Checked effect; do not repeat';
  const state = await continueWorkflow(f.root, f.state.id, { resolution }, deps);
  assert.equal(state.visits.length, 2); assert.equal(state.visits[0].verdict.outcome, 'blocked');
  assert.match(state.visits[1].prompt, /Checked effect; do not repeat/);
  assert.equal(state.visits[1].recoveryOf, old.inputId);
});

test('UI shows an actually saved pre-correction reply instead of claiming its text was lost', async t => {
  const { workflowView } = await import('./ui-data.mjs');
  const f = fixture(t); const v = visit(f);
  v.correction = { inputId: 'msg_corrected', prompt: 'Correct JSON' };
  v.executionHistory = [{ inputId: v.inputId, outcome: { status: 'succeeded', result: 'Saved original reply requiring correction' } }];
  v.error = 'Correction failed';
  const calls = workflowView(f.state, { root: f.root }).graph.nodes.find(n => n.id === 'work').participants[0].invocations;
  assert.equal(calls[0].resultRaw, 'Saved original reply requiring correction');
  assert.equal(calls[1].problem, 'Correction failed');
});

test('public CLI help advertises continuation and both explicit-intent flags', async () => {
  const { execFileSync } = await import('node:child_process');
  const help = execFileSync(process.execPath, ['dwf.mjs', '--help'], { encoding: 'utf8' });
  assert.match(help, /dwf continue <run-id> \[--resume-cancelled\] \[--resolution-file <file>\]/);
});

for (const change of ['command', 'native']) test(`permission expires on a changed ${change} even when files are unchanged`, async t => {
  const f = fixture(t); const old = visit(f); f.save();
  const tool = { type: 'tool', id: 'tool-1', name: 'shell', state: { status: 'error', input: { command: 'remote-effect' }, error: 'interrupted' } };
  const messages = [{ id: old.inputId, type: 'user' }, { type: 'assistant', id: 'answer', content: [tool] }, { type: 'idle', outcome: 'failed' }];
  const client = { session: { get: async () => ({ metadata: { dwfRunId: f.state.id } }), active: async () => ({}), inbox: { list: async () => [] } },
    message: { list: async () => ({ data: messages, cursor: {} }) } };
  const blocked = await continueWorkflow(f.root, f.state.id, {}, { client });
  const resolution = blocked.recovery.resolutionTemplate; resolution.decisions[0].action = 'retry'; resolution.decisions[0].evidence = 'Permit exact operation at verified state';
  const state = await continueWorkflow(f.root, f.state.id, { resolution }, { client });
  if (change === 'command') queueWorkflowCommand(f.root, f.state.id, 'steer', 'work', 'New exact requirement');
  else tool.state = { status: 'completed', input: { command: 'remote-effect' }, content: [{ type: 'text', text: 'External result confirmed later' }] };
  const latest = getWorkflow(f.root, f.state.id);
  await assert.rejects(checkContinuationAdmission(client, latest, latest.visits[1]), /устарело до отправки/);
  const refreshed = await continueWorkflow(f.root, f.state.id, {}, { client });
  assert.equal(refreshed.recovery.status, 'blocked'); assert.equal(refreshed.recovery.problems[0].kind, 'stale_permission');
  assert.equal(refreshed.visits.length, state.visits.length);
});

for (const scope of ['group-child', 'verifier']) for (const changed of ['observed', 'replacement']) test(`review regression: permission revalidates the ${changed} ${scope} workspace at send`, async t => {
  const f = fixture(t);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['commit', '--allow-empty', '-m', 'base']]) git(f.state.workspace.path, args);
  f.state.workspace = { ...f.state.workspace, mode: 'worktree', base: git(f.state.workspace.path, ['rev-parse', 'HEAD']) };
  const old = visit(f);
  const isolated = verificationWorkspace(f.root, f.state.id, f.state.workspace, old.revision, 'isolated');
  old.workspace = isolated; old.revision = snapshot(isolated);
  if (scope === 'group-child') {
    f.state.definition.groups = { checks: { members: ['work'] } };
    f.state.definition.transitions.checks = { done: null, failed: null, changes: null };
    old.required = true;
    f.state.visits = [{ node: 'checks', inputId: 'group_old', revision: snapshot(f.state.workspace), admissionStarted: true, admitted: true, children: [old] }];
  } else f.state.definition.nodes.work.role = 'verifier';
  const tool = { type: 'tool', id: 'tool', name: 'shell', state: { status: 'error', input: { command: 'external' }, error: 'interrupted' } };
  const messages = [{ id: old.inputId, type: 'user' }, { type: 'assistant', id: 'reply', content: [tool] }, { type: 'idle', outcome: 'failed' }];
  const client = { session: { get: async () => ({ metadata: { dwfRunId: f.state.id } }), active: async () => ({}), inbox: { list: async () => [] } },
    message: { list: async () => ({ data: messages, cursor: {} }) } };
  f.save();
  const blocked = await continueWorkflow(f.root, f.state.id, {}, { client });
  const resolution = blocked.recovery.resolutionTemplate;
  for (const d of resolution.decisions) { d.action = 'retry'; d.evidence = 'Permit this checked isolated revision'; }
  const state = await continueWorkflow(f.root, f.state.id, { resolution }, { client });
  const retry = scope === 'group-child' ? state.visits[0].children.at(-1) : state.visits.at(-1);
  writeFileSync(join(changed === 'observed' ? isolated.path : (retry.workspace ?? state.workspace).path, 'late'), 'changed after permission');
  await assert.rejects(checkContinuationAdmission(client, state, retry), /устарело до отправки/);
});

test('review regression: legacy group retry false marker cannot hide an acknowledged native failure', async t => {
  const f = fixture(t); const old = visit(f); old.admissionStarted = false; old.required = true;
  f.state.definition.groups = { checks: { members: ['work'] } };
  f.state.definition.transitions.checks = { done: null, failed: null, changes: null };
  f.state.visits = [{ node: 'checks', inputId: 'group', revision: old.revision, admitted: true, admissionStarted: true, children: [old] }];
  f.save(); let observed = false;
  const state = await continueWorkflow(f.root, f.state.id, {}, { client: {}, observe: async () => { observed = true; return { outcome: { status: 'failed' } }; } });
  assert(observed); assert.equal(state.visits[0].children.length, 2);
  assert.equal(state.visits[0].children[1].recoveryOf, old.inputId);
});

for (const action of ['confirm', 'retry']) test(`recheck revision: drifted checking-group child carries ${action} and enforces permission before send`, async t => {
  const f = fixture(t); f.state.definition.nodes.work.role = 'verifier'; const old = visit(f);
  const isolated = { mode: 'directory', path: join(f.root, 'isolated') }; mkdirSync(isolated.path);
  old.workspace = isolated; old.revision = snapshot(f.state.workspace); old.required = true;
  f.state.definition.groups = { checks: { members: ['work'] } };
  f.state.definition.transitions.checks = { done: null, failed: null, changes: null };
  f.state.visits = [{ node: 'checks', inputId: 'group_old', revision: old.revision, admitted: true, admissionStarted: true, children: [old] }];
  writeFileSync(join(f.state.workspace.path, 'drift'), 'changed common candidate');
  const messages = [{ id: old.inputId, type: 'user' }, { type: 'assistant', id: 'answer', content: [
    { type: 'tool', id: 'op', name: 'shell', state: { status: 'error', input: { command: 'external' }, error: 'interrupted' } },
  ] }, { type: 'idle', outcome: 'failed' }];
  const client = { session: { get: async () => ({ metadata: { dwfRunId: f.state.id } }), active: async () => ({}), inbox: { list: async () => [] } },
    message: { list: async () => ({ data: messages, cursor: {} }) } };
  f.save();
  const blocked = await continueWorkflow(f.root, f.state.id, {}, { client });
  const resolution = blocked.recovery.resolutionTemplate;
  for (const d of resolution.decisions) { d.action = action; d.evidence = 'Explicit decision for interrupted group operation'; }
  const state = await continueWorkflow(f.root, f.state.id, { resolution }, { client });
  const group = state.visits.at(-1), child = group.children[0];
  assert.equal(child.recoveryId, group.recoveryId);
  assert.deepEqual(child.taskContext.recovery.decisions, resolution.decisions);
  assert.equal(child.taskContext.recovery.previousInputId, old.inputId);
  await checkContinuationAdmission(client, state, child);
  writeFileSync(join(isolated.path, 'late'), 'changed checked catalog before send');
  await assert.rejects(checkContinuationAdmission(client, state, child), /устарело до отправки/);
});

test('recheck revision: a failed aggregate does not hide an unfinished worker behind its stale checking child', async t => {
  const f = fixture(t); const worker = visit(f); worker.required = true;
  f.state.definition.nodes.review = { role: 'reviewer', tools: [], skills: [] };
  f.state.definition.transitions.review = { approve: null, changes: null };
  const review = { node: 'review', participant: 'review', inputId: 'msg_review', sessionId: 'ses_review', required: true,
    revision: worker.revision, verdict: { outcome: 'approve', summary: 'Old approval' } };
  f.state.definition.groups = { mixed: { members: ['work', 'review'] } };
  f.state.definition.transitions.mixed = { done: null, failed: null, changes: null };
  const group = { node: 'mixed', inputId: 'group_mixed', revision: worker.revision, admissionStarted: true, admitted: true,
    verdict: { outcome: 'failed', summary: 'worker failed' }, children: [worker, review] };
  f.state.visits = [group]; writeFileSync(join(f.state.workspace.path, 'drift'), 'worker partial change'); f.save();
  const state = await continueWorkflow(f.root, f.state.id, {}, failed);
  assert.equal(state.visits.length, 1, 'do not append a recheck boundary over the worker');
  assert.equal(state.visits[0].children.length, 3);
  assert.equal(state.visits[0].children.at(-1).node, 'work');
  assert.equal(state.visits[0].children[1].inputId, review.inputId);
});

for (const projection of ['UI', 'context history']) test(`retained membership: ${projection} counts one execution per input and keeps every checking attempt`, async t => {
  const f = fixture(t); const writer = visit(f); writer.verdict = { outcome: 'done', summary: 'One writer result' };
  f.state.definition.entry = 'mixed';
  f.state.definition.nodes.verify = { role: 'verifier', tools: [], skills: [] };
  f.state.definition.groups = { mixed: { members: ['work', 'verify'] } };
  f.state.definition.transitions.mixed = { done: null, changes: null, failed: null };
  const checks = ['msg_check_1', 'msg_check_2', 'msg_check_3'];
  f.state.visits = checks.map((inputId, index) => ({ node: 'mixed', inputId: `group_${index}`, revision: writer.revision,
    verdict: { outcome: 'done', summary: `Membership ${index}` }, children: [structuredClone(writer),
      { node: 'verify', participant: 'verify', inputId, sessionId: 'ses_verify', admitted: true, revision: writer.revision,
        verdict: { outcome: 'approve', summary: `Check ${index}` } }] }));
  if (projection === 'UI') {
    const { workflowView } = await import('./ui-data.mjs');
    const people = workflowView(f.state, { root: f.root }).graph.nodes.find(n => n.id === 'mixed').participants;
    assert.deepEqual(people.find(p => p.id === 'work').invocations.map(c => c.id), [writer.inputId]);
    assert.deepEqual(people.find(p => p.id === 'verify').invocations.map(c => c.id), checks);
  } else {
    const next = { node: 'verify', inputId: 'msg_next', sessionId: 'ses_next', revision: writer.revision };
    prepareRoleInput(f.root, f.state, next);
    const { readFileSync } = await import('node:fs');
    const reports = JSON.parse(readFileSync(next.taskContext.history.path, 'utf8'));
    assert.deepEqual(reports.filter(r => r.node === 'work').map(r => r.inputId), [writer.inputId]);
    assert.deepEqual(reports.filter(r => r.node === 'verify').map(r => r.inputId), checks);
    assert.equal(reports.filter(r => r.role === 'group').length, 3);
  }
  assert.equal(f.state.visits.length, 3);
  assert(f.state.visits.every(group => group.children[0].inputId === writer.inputId));
});
