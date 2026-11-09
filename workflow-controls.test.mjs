import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorkflow, createWorkflow, getWorkflow, queueWorkflowCommand, updateWorkflow } from './run-store.mjs';

// Schedule commands at native I/O boundaries while exercising the real controller and store.
let io;
registerHooks({
  load(url, context, next) {
    if (url === new URL('./opencode-runtime.mjs', import.meta.url).href) {
      return { format: 'module', shortCircuit: true, source: `
        export const connect = async () => globalThis.dwfControlIO.connect();
        export const checkRoleAgents = async () => {};
        export const admit = async (_client, request) => globalThis.dwfControlIO.admit(request);
        export const readExecution = async (_client, request) => globalThis.dwfControlIO.read(request);
        export const captureStopSessions = async () => {};
        export const interruptSessions = async () => {};
        export const stopSessions = async () => { globalThis.dwfControlIO.stops++; };
      ` };
    }
    if (url === new URL('./workflow-git.mjs', import.meta.url).href) {
      return { format: 'module', shortCircuit: true, source: `
        export const snapshot = () => globalThis.dwfControlIO.snapshot();
        export const git = () => {};
        export const verificationWorkspace = (_root, _id, workspace) => workspace;
        export const writeReviewDiff = () => {};
        export const mergeWorkspace = () => globalThis.dwfControlIO.merge();
      ` };
    }
    return next(url, context);
  },
});
const { runWorkflow } = await import('./workflow-runtime.mjs');
const { prepareGroup } = await import('./workflow-groups.mjs');

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dwf-control-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'controlled';
  const definition = options.definition ?? { task: 'Controlled scheduling', workspace: 'directory', entry: 'review',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    transitions: { review: { approve: 'verify', changes: 'verify' }, verify: { approve: null, changes: null } } };
  if (options.merge) definition.merge = true;
  if (options.memory === false) definition.transitions.verify.changes = 'review';
  createWorkflow(root, { id, definition, workspace: { mode: 'directory', path: root },
    status: 'running', visits: options.visits ?? [], sessions: {},
    ...(options.memory === false ? { participants: { review: { memory: false, agent: { permissions: [] } } } } : {}) });
  const admitted = [];
  io = globalThis.dwfControlIO = {
    stops: 0, snapshot: () => 'original', connect: async () => ({}), merge: () => 'commit',
    admit: async request => admitted.push(request),
    read: async () => ({ outcome: { status: 'succeeded', result: '{"outcome":"approve","summary":"Checked"}' } }),
  };
  return { root, id, admitted, state: () => getWorkflow(root, id),
    command: (kind, node, text) => queueWorkflowCommand(root, id, kind, node, text),
    run: () => runWorkflow(root, id) };
}

test('accepted stop takes precedence over a malformed terminal answer', async t => {
  const f = await fixture(t);
  io.read = async () => {
    f.command('stop');
    return { outcome: { status: 'succeeded', result: 'malformed' } };
  };
  await f.run();
  assert.equal(f.state().status, 'cancelled');
  assert.equal(f.state().controls[0].status, 'applied');
  assert.equal(io.stops, 1);
  assert.equal(f.admitted.length, 1);
});

test('accepted steering recovers a malformed answer in the same session', async t => {
  const f = await fixture(t);
  const read = io.read;
  let first = true;
  io.read = async request => {
    if (!first) return read(request);
    first = false;
    f.command('steer', 'review', 'Clarify the failed answer');
    return { outcome: { status: 'succeeded', result: 'malformed' } };
  };
  await f.run();
  const state = f.state();
  assert.equal(state.status, 'succeeded', state.error);
  assert.deepEqual(state.visits.map(visit => visit.node), ['review', 'review', 'verify']);
  assert.equal(state.visits[0].sessionId, state.visits[1].sessionId);
  assert.equal(state.controls[0].status, 'applied');
});

for (const [target, visits] of [
  ['work', ['work', 'work', 'review', 'verify', 'finish']],
  ['review', ['work', 'review', 'verify', 'finish']],
  ['verify', ['work', 'verify', 'finish']],
]) {
  test(`steering to ${target} continues its route and retains mandatory approval checks`, async t => {
    const definition = { task: 'Clarify the compatibility check', workspace: 'directory', entry: 'work',
      nodes: { work: { role: 'worker' }, review: { role: 'reviewer' },
        verify: { role: 'verifier' }, finish: { role: 'orchestrator' } },
      transitions: { work: { done: 'review' }, review: { approve: 'verify', changes: 'work' },
        verify: { approve: 'finish', changes: 'work' }, finish: { done: null } } };
    const f = await fixture(t, { definition });
    let queued = false;
    io.read = async () => {
      const state = f.state();
      if (!queued) {
        queued = true;
        f.command('steer', target, 'Check the additional compatibility scenario');
      }
      const role = definition.nodes[state.visits.at(-1).node].role;
      const outcome = ['reviewer', 'verifier'].includes(role) ? 'approve' : 'done';
      return { outcome: { status: 'succeeded', result: JSON.stringify({ outcome, summary: 'Checked' }) } };
    };
    await f.run();
    const state = f.state();
    assert.deepEqual(state.visits.map(visit => visit.node), visits);
    assert.equal(state.controls[0].status, 'applied');
    assert.equal(state.status, target === 'verify' ? 'failed' : 'succeeded');
    if (target === 'verify') assert.match(state.error, /review/);
    if (target === 'work') assert.equal(state.visits[0].sessionId, state.visits[1].sessionId);
  });
}

for (const kind of ['stop', 'steer']) {
  test(`${kind} queued while preparing a transition runs before the next admission`, async t => {
    const f = await fixture(t);
    let queued = false;
    io.snapshot = () => {
      if (!queued && f.state().visits.at(-1)?.verdict) {
        queued = true;
        f.command(kind, 'review', 'Updated requirement');
      }
      return 'original';
    };
    await f.run();
    const state = f.state();
    assert.equal(state.controls[0].status, 'applied');
    assert.deepEqual(state.visits.map(visit => visit.node), kind === 'stop' ? ['review'] : ['review', 'review', 'verify']);
    assert.equal(state.status, kind === 'stop' ? 'cancelled' : 'succeeded');
  });
}

test('stop survives a controller connection failure and retries cleanup', async t => {
  const f = await fixture(t);
  let first = true;
  io.connect = async () => {
    if (!first) return {};
    first = false;
    f.command('stop');
    throw new Error('Temporary service failure');
  };
  await f.run();
  assert.equal(f.state().status, 'cancelled');
  assert.equal(f.state().controls[0].status, 'applied');
  assert.equal(io.stops, 1);
  assert.equal(f.admitted.length, 0);
});

test('read-only approval retains the revision actually observed by its participant', async t => {
  const f = await fixture(t);
  let snapshots = 0;
  io.snapshot = () => ++snapshots < 3 ? 'original' : 'replacement';
  await f.run();
  const state = f.state();
  assert.equal(state.visits[0].revision, 'original');
  assert.equal(state.visits[0].verdict.outcome, 'approve');
  assert.equal(state.status, 'failed');
});

test('finalization is durable before Git integration and rejects later controls', async t => {
  const f = await fixture(t, { merge: true });
  io.merge = () => {
    assert.equal(f.state().finalizing, true);
    return 'commit';
  };
  await f.run();
  assert.equal(f.state().status, 'succeeded');
  assert.throws(() => f.command('stop'), /завершает/);
});

test('steering accepted during snapshot survives a subsequent invalid answer', async t => {
  const f = await fixture(t);
  const read = io.read;
  let invalid = true;
  let queue = false;
  io.read = async request => {
    if (!invalid) return read(request);
    invalid = false;
    queue = true;
    return { outcome: { status: 'succeeded', result: 'invalid JSON' } };
  };
  io.snapshot = () => {
    if (queue) { queue = false; f.command('steer', 'review', 'Recover this answer'); }
    return 'original';
  };
  await f.run();
  assert.equal(f.state().status, 'succeeded', f.state().error);
  assert.equal(f.state().controls[0].status, 'applied');
});

test('discarded ordinary memory=false visit cannot replace the steering context', async t => {
  const f = await fixture(t, { memory: false });
  const read = io.read;
  let changed = false;
  let queued = false;
  io.read = async request => {
    if (request.request.session.title.endsWith('verify') && !changed) {
      changed = true;
      return { outcome: { status: 'succeeded', result: '{"outcome":"changes","summary":"Revise"}' } };
    }
    return read(request);
  };
  io.snapshot = () => {
    if (!queued && f.state().visits.at(-1)?.verdict?.outcome === 'changes') {
      queued = true;
      f.command('steer', 'review', 'Continue in the previous context');
    }
    return 'original';
  };
  await f.run();
  const reviews = f.state().visits.filter(visit => visit.node === 'review');
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].sessionId, reviews[1].sessionId);
  assert.equal(f.state().status, 'succeeded', f.state().error);
});

test('a transient reconnect failure preserves the resumable running state', async t => {
  const f = await fixture(t);
  const read = io.read;
  let failedRead = false;
  let failConnect = false;
  io.read = async request => {
    if (failedRead) return read(request);
    failedRead = true;
    failConnect = true;
    throw new Error('Transport failed');
  };
  io.connect = async () => {
    if (failConnect) { failConnect = false; throw new Error('Reconnect failed once'); }
    return {};
  };
  await f.run();
  assert.equal(f.state().status, 'succeeded', f.state().error);
  assert.equal(f.admitted.length, 2);
});

test('steering a prepared map child retains its identity before group admission', async t => {
  const definition = { task: 'Prepared group steering', workspace: 'directory', entry: 'jobs',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    groups: { jobs: { member: 'review', items: [{ id: 'alpha' }, { id: 'beta' }] } },
    transitions: { jobs: { done: 'verify', changes: null, failed: null },
      review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const children = ['alpha', 'beta'].map(id => ({ node: 'review', participant: `jobs/${id}`, required: true,
    item: { id }, sessionId: `ses_${id}`, inputId: `msg_${id}`, revision: 'original', prompt: `Item ${id}` }));
  const f = await fixture(t, { definition, visits: [{ node: 'jobs', inputId: 'group_1', revision: 'original', admissionStarted: false, children }] });
  f.command('steer', 'jobs/alpha', 'Check the updated condition');
  const watchdog = setTimeout(() => f.command('stop'), 2000);
  t.after(() => clearTimeout(watchdog));
  await f.run();
  clearTimeout(watchdog);
  const state = f.state();
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(state.controls[0].status, 'applied');
  assert.equal(state.visits[0].children[0].sessionId, 'ses_alpha');
  assert.equal(state.visits[0].children[0].item.id, 'alpha');
  assert.equal(f.admitted.length, 3);
  assert.match(f.admitted[0].request.text, /updated condition/);
  assert.doesNotMatch(f.admitted[1].request.text, /updated condition/);
});

test('steering a prepared repeated group keeps its fresh memory-disabled session and group route', async t => {
  const definition = { task: 'Clarify a repeated group', workspace: 'directory', entry: 'jobs',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    groups: { jobs: { members: ['review'] } },
    transitions: { jobs: { done: 'verify', changes: null, failed: null },
      review: { approve: null, changes: null }, verify: { approve: null, changes: null } } };
  const previous = { node: 'jobs', revision: 'original', verdict: { outcome: 'done', summary: 'First group' },
    children: [{ node: 'review', participant: 'review', sessionId: 'ses_previous', revision: 'original',
      verdict: { outcome: 'approve', summary: 'First review' } }] };
  const f = await fixture(t, { definition, memory: false, visits: [previous] });
  assert.equal(claimWorkflow(f.root, f.id, 'prepare-test'), true);
  const state = f.state();
  state.sessions.review = 'ses_previous';
  const prepared = prepareGroup(f.root, state, 'jobs', previous.verdict);
  state.visits.push(prepared);
  updateWorkflow(f.root, state, 'prepare-test', true);
  const freshSession = prepared.children[0].sessionId;
  assert.notEqual(freshSession, 'ses_previous');
  f.command('steer', 'review', 'Clarify the second group visit');
  await f.run();
  const result = f.state();
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.controls[0].status, 'applied');
  assert.deepEqual(result.visits.map(visit => visit.node), ['jobs', 'jobs', 'verify']);
  assert.equal(result.visits[1].children[0].sessionId, freshSession);
  assert.equal(result.sessions.review, freshSession);
  assert.equal(f.admitted.length, 2);
  assert.equal(f.admitted[0].sessionId, freshSession);
  assert.match(f.admitted[0].request.text, /Clarify the second group visit/);
});

for (const [kind, group, targets] of [
  ['fixed', { members: ['review', 'secondReview'] }, ['review', 'secondReview']],
  ['map', { member: 'review', items: [{ id: 'alpha' }, { id: 'beta' }] }, ['jobs/alpha', 'jobs/beta']],
]) {
  test(`two queued clarifications for a prepared ${kind} group preserve delivery order and the final node route`, async t => {
    const definition = { task: 'Clarify two prepared group members', workspace: 'directory', entry: 'jobs',
      nodes: { review: { role: 'reviewer' }, secondReview: { role: 'reviewer', required: kind === 'fixed' },
        verify: { role: 'verifier' } },
      groups: { jobs: group },
      transitions: { jobs: { done: 'verify', changes: null, failed: null },
        review: { approve: null, changes: null }, secondReview: { approve: null, changes: null },
        verify: { approve: null, changes: null } } };
    const f = await fixture(t, { definition, memory: false });
    assert.equal(claimWorkflow(f.root, f.id, 'prepare-test'), true);
    const state = f.state();
    const prepared = prepareGroup(f.root, state, 'jobs');
    state.visits.push(prepared);
    updateWorkflow(f.root, state, 'prepare-test', true);
    f.command('steer', targets[0], 'First queued clarification');
    f.command('steer', targets[1], 'Second queued clarification');
    await f.run();
    const result = f.state();
    assert.equal(result.status, 'failed');
    assert.match(result.error, /verify/);
    assert.deepEqual(result.controls.map(command => command.status), ['applied', 'applied']);
    assert.deepEqual(result.visits.map(visit => visit.node), ['jobs', prepared.children[1].node]);
    assert.equal(f.admitted.length, 3);
    assert.match(f.admitted[0].request.text, /First queued clarification/);
    assert.doesNotMatch(f.admitted[1].request.text, /Second queued clarification/);
    assert.match(f.admitted[2].request.text, /Second queued clarification/);
    assert.equal(f.admitted[1].sessionId, f.admitted[2].sessionId);
  });
}

test('group admission retry preserves the first steering and delivers a second separately', async t => {
  const definition = { task: 'Lost group acknowledgement', workspace: 'directory', entry: 'jobs',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    groups: { jobs: { member: 'review', items: [{ id: 'alpha' }] } },
    transitions: { jobs: { done: 'verify', changes: null, failed: null },
      review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const child = { node: 'review', participant: 'jobs/alpha', required: true, item: { id: 'alpha' },
    sessionId: 'ses_alpha', inputId: 'msg_alpha', revision: 'original', prompt: 'Alpha' };
  const f = await fixture(t, { definition, visits: [{ node: 'jobs', inputId: 'group_1',
    revision: 'original', admissionStarted: false, children: [child] }] });
  f.command('steer', 'jobs/alpha', 'First clarification');
  const admit = io.admit;
  let calls = 0;
  io.admit = async request => {
    assert.equal(f.state().visits.at(-1).admissionStarted, true);
    await admit(request);
    if (++calls === 1) throw new Error('Acknowledgement lost after acceptance');
  };
  let connections = 0;
  io.connect = async () => {
    if (++connections === 2) f.command('steer', 'jobs/alpha', 'Second clarification');
    return {};
  };
  await f.run();
  assert.equal(f.state().status, 'succeeded', f.state().error);
  assert.deepEqual(f.state().controls.map(command => command.status), ['applied', 'applied']);
  const requests = f.admitted.filter(request => request.sessionId === 'ses_alpha');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].inputId, requests[1].inputId);
  assert.equal(requests[0].request.text, requests[1].request.text);
  assert.doesNotMatch(requests[1].request.text, /Second clarification/);
  assert.notEqual(requests[1].inputId, requests[2].inputId);
  assert.match(requests[2].request.text, /Second clarification/);
});

test('ordinary admission retry retains the original input before applying later steering', async t => {
  const f = await fixture(t);
  const admit = io.admit;
  let calls = 0;
  io.admit = async request => {
    assert.equal(f.state().visits.at(-1).admissionStarted, true);
    await admit(request);
    if (++calls === 1) throw new Error('Acknowledgement lost after acceptance');
  };
  let connections = 0;
  io.connect = async () => {
    if (++connections === 2) f.command('steer', 'review', 'Later clarification');
    return {};
  };
  await f.run();
  assert.equal(f.state().status, 'succeeded', f.state().error);
  assert.equal(f.state().controls[0].status, 'applied');
  assert.equal(f.admitted[0].inputId, f.admitted[1].inputId);
  assert.equal(f.admitted[0].request.text, f.admitted[1].request.text);
  assert.notEqual(f.admitted[1].inputId, f.admitted[2].inputId);
  assert.match(f.admitted[2].request.text, /Later clarification/);
});
