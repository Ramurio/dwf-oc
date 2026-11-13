import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claimWorkflow, createWorkflow, getWorkflow, publicError, queueWorkflowCommand, updateWorkflow } from './run-store.mjs';

// Schedule commands at native I/O boundaries while exercising the real controller and store.
let io;
registerHooks({
  load(url, context, next) {
    if (url === new URL('./opencode-runtime.mjs', import.meta.url).href) {
      return { format: 'module', shortCircuit: true, source: `
        export const OPENCODE_VERSION = '2.2.5';
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
        export const mergeWorkspace = (_workspace, _revision, title) => globalThis.dwfControlIO.merge(title);
      ` };
    }
    return next(url, context);
  },
});
const { publicWorkflow, runWorkflow } = await import('./workflow-runtime.mjs');
const { prepareGroup } = await import('./workflow-groups.mjs');

function orchestration() {
  const nodes = { manager: { role: 'orchestrator' } };
  const transitions = { manager: { taskA: 'a_work', taskB: 'b_work', recheckB: 'b_review', done: null } };
  for (const id of ['a', 'b']) {
    nodes[`${id}_work`] = { role: 'worker' };
    nodes[`${id}_review`] = { role: 'reviewer' };
    nodes[`${id}_verify`] = { role: 'verifier' };
    transitions[`${id}_work`] = { done: `${id}_review` };
    transitions[`${id}_review`] = { approve: `${id}_verify`, changes: `${id}_work` };
    transitions[`${id}_verify`] = { approve: 'manager', changes: `${id}_work` };
  }
  return { task: 'Implement two compatible tasks', entry: 'manager', nodes, transitions };
}

test('orchestrator routes two implementations, returns a compatibility fix and merges only after fresh checks', async t => {
  const definition = orchestration();
  const f = await fixture(t, { definition, merge: true });
  let revision = 'base';
  let workCount = 0;
  let decisions = 0;
  let merges = 0;
  const reviewed = new Set();
  io.snapshot = () => revision;
  io.merge = () => { merges++; return 'combined-commit'; };
  io.read = async request => {
    const visit = f.state().visits.at(-1);
    const role = definition.nodes[visit.node].role;
    let outcome;
    let summary = 'Checked';
    if (role === 'worker') { revision = `tree-${++workCount}`; outcome = 'done'; }
    else if (role === 'orchestrator') {
      outcome = ['taskA', 'taskB', 'taskA', 'recheckB', 'done'][decisions++];
      summary = outcome === 'taskA' && decisions === 3 ? 'Correct A to preserve the interface introduced by B' : 'Proceed';
    } else if (visit.node === 'a_review' && !reviewed.has('a_review')) {
      outcome = 'changes'; summary = 'Handle empty input'; reviewed.add('a_review');
    } else outcome = 'approve';
    if (visit.node === 'a_work' && workCount === 4) {
      assert.match(request.request.text, /Correct A to preserve the interface introduced by B/);
    }
    return { outcome: { status: 'succeeded', result: JSON.stringify({ outcome, summary }) } };
  };
  await f.run();
  const state = f.state();
  assert.equal(state.status, 'succeeded', state.error);
  assert.equal(merges, 1);
  assert.deepEqual(state.visits.map(visit => visit.node), [
    'manager', 'a_work', 'a_review', 'a_work', 'a_review', 'a_verify', 'manager',
    'b_work', 'b_review', 'b_verify', 'manager', 'a_work', 'a_review', 'a_verify',
    'manager', 'b_review', 'b_verify', 'manager',
  ]);
  for (const node of ['manager', 'a_work', 'b_review']) {
    assert.equal(new Set(state.visits.filter(visit => visit.node === node).map(visit => visit.sessionId)).size, 1);
  }
  const { workflowView } = await import('./ui-data.mjs');
  const view = workflowView(state, { root: f.root });
  assert.equal(view.graph.nodes.length, 8);
  for (const target of ['a_work', 'b_work', 'b_review']) {
    assert(view.graph.edges.some(edge => edge.from === 'manager' && edge.to === target));
  }
  assert(view.graph.edges.some(edge => edge.from === 'a_verify' && edge.to === 'manager' && edge.reentry));
});

for (const decision of ['done', 'invented', 'blocked']) {
  test(`orchestrator ${decision} cannot bypass outstanding checks or invent a route`, async t => {
    const f = await fixture(t, { definition: orchestration(), merge: true });
    let merges = 0;
    io.merge = () => { merges++; };
    io.read = async () => ({ outcome: { status: 'succeeded',
      result: JSON.stringify({ outcome: decision, summary: 'Not ready' }) } });
    await f.run();
    assert.equal(f.state().status, 'failed');
    assert.equal(f.admitted.length, 1);
    assert.equal(merges, 0);
  });
}

test('an explicit blocked route returns a worker question to orchestrator and preserves the session', async t => {
  const definition = orchestration();
  definition.transitions.a_work.blocked = 'manager';
  const f = await fixture(t, { definition });
  let decisions = 0;
  io.read = async request => {
    const node = f.state().visits.at(-1).node;
    if (node === 'manager') {
      if (decisions++) {
        assert.match(request.request.text, /Need a decision on the shared interface/);
        return { outcome: { status: 'succeeded', result: '{"outcome":"taskA","summary":"Use the existing public interface"}' } };
      }
      return { outcome: { status: 'succeeded', result: '{"outcome":"taskA","summary":"Implement A"}' } };
    }
    if (decisions === 2) {
      assert.match(request.request.text, /Use the existing public interface/);
      f.command('stop');
    }
    return { outcome: { status: 'succeeded', result: '{"outcome":"blocked","summary":"Need a decision on the shared interface"}' } };
  };
  await f.run();
  const visits = f.state().visits;
  assert.deepEqual(visits.map(visit => visit.node), ['manager', 'a_work', 'manager', 'a_work']);
  assert.equal(visits[1].sessionId, visits[3].sessionId);
  assert.equal(f.state().status, 'cancelled');
});

test('saved orchestrator route resumes without repeating the decision and stop wins over dispatch', async t => {
  const definition = orchestration();
  const saved = { node: 'manager', sessionId: 'saved-manager', inputId: 'saved-decision', admitted: true,
    revision: 'original', verdict: { outcome: 'taskB', summary: 'Implement B first' } };
  const f = await fixture(t, { definition, visits: [saved] });
  io.read = async request => {
    assert.equal(f.state().visits.at(-1).node, 'b_work');
    assert.match(request.request.text, /Implement B first/);
    f.command('stop');
    return { outcome: { status: 'succeeded', result: '{"outcome":"done","summary":"Done"}' } };
  };
  await f.run();
  assert.equal(f.admitted.length, 1);
  assert.equal(f.state().status, 'cancelled');
  const stopped = await fixture(t, { definition });
  io.read = async () => {
    stopped.command('stop');
    return { outcome: { status: 'succeeded', result: '{"outcome":"taskA","summary":"Start A"}' } };
  };
  await stopped.run();
  assert.equal(stopped.admitted.length, 1);
  assert.deepEqual(stopped.state().visits.map(visit => visit.node), ['manager']);
  assert.equal(stopped.state().status, 'cancelled');
});

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
  io.merge = title => {
    assert.equal(f.state().finalizing, true);
    assert.equal(title, 'DWF chore: Controlled scheduling');
    return 'commit';
  };
  await f.run();
  assert.equal(f.state().status, 'succeeded');
  assert.throws(() => f.command('stop'), /завершает/);
});

test('a final orchestrator preserves the approved verifier commit title during controller recovery', async t => {
  const definition = { task: 'Preserve the admission input', merge: true, entry: 'review',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' }, finish: { role: 'orchestrator' } },
    transitions: { review: { approve: 'verify', changes: null },
      verify: { approve: 'finish', changes: null }, finish: { done: null } } };
  const title = 'DWF fix: preserve the admission input';
  const f = await fixture(t, { definition, visits: [
    { node: 'review', revision: 'original', verdict: { outcome: 'approve', summary: 'Reviewed' } },
    { node: 'verify', revision: 'original', verdict: { outcome: 'approve', summary: title + '\n\nRetries passed.' } },
    { node: 'finish', revision: 'original', verdict: { outcome: 'done', summary: 'Completed verification.' } },
  ] });
  io.merge = observed => { assert.equal(observed, title); return 'commit'; };
  await f.run();
  assert.equal(f.state().status, 'succeeded', f.state().error);
  assert.equal(f.state().result.summary, 'Completed verification.');
  assert.equal(f.admitted.length, 0);
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

test('discarding a prepared map group retains every accepted child clarification', async t => {
  const items = [{ id: 'alpha', detail: 'first' }, { id: 'beta', detail: 'second' }];
  const definition = { task: 'Retain accepted mapped recipients', workspace: 'directory', entry: 'jobs',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    groups: { jobs: { member: 'review', items } },
    transitions: { jobs: { done: 'verify', changes: null, failed: null },
      review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const f = await fixture(t, { definition, memory: false });
  assert.equal(claimWorkflow(f.root, f.id, 'prepare-test'), true);
  const state = f.state();
  state.visits.push(prepareGroup(f.root, state, 'jobs'));
  updateWorkflow(f.root, state, 'prepare-test', true);
  f.command('steer', 'verify', 'Visit the external node first');
  for (const item of items) f.command('steer', `jobs/${item.id}`, `Clarify ${item.id}`);
  assert(f.state().controls.every(command => !Object.hasOwn(command, 'target')));
  const watchdog = setTimeout(() => f.command('stop'), 2000);
  t.after(() => clearTimeout(watchdog));
  await f.run();
  clearTimeout(watchdog);
  const result = f.state();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /jobs/);
  assert.deepEqual(result.visits.map(visit => visit.node), ['verify', 'review', 'review', 'verify']);
  assert.deepEqual(result.visits.filter(visit => visit.node === 'review').map(visit => visit.item), items);
  assert.deepEqual(result.controls.map(command => command.status), ['applied', 'applied', 'applied']);
  assert.equal(f.admitted.length, 4);
  for (const [index, item] of items.entries()) {
    const section = f.admitted[index + 1].request.text.match(/Task\/context data:\n([^\n]+)/)[1];
    const context = JSON.parse(section);
    assert.deepEqual(context.assignment.item, item);
    assert.equal(context.assignment.steering.text, `Clarify ${item.id}`);
    assert.deepEqual(result.visits[index + 1].taskContext, context);
  }
  assert(publicWorkflow(result).controls.every(command => !Object.hasOwn(command, 'target')));
});

test('discarded map items keep their accepted data and previous session', async t => {
  const item = { id: 'alpha', detail: 'current item' };
  const definition = { task: 'Keep the accepted item and established conversation', workspace: 'directory', entry: 'jobs',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    groups: { jobs: { member: 'review', items: [item] } },
    transitions: { jobs: { done: 'verify', changes: null, failed: null },
      review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const previous = { node: 'jobs', revision: 'original', verdict: { outcome: 'done', summary: 'Previous group' },
    children: [{ node: 'review', participant: 'jobs/alpha', sessionId: 'ses_previous', revision: 'original',
      item: { id: 'alpha', detail: 'old item' }, verdict: { outcome: 'approve', summary: 'Previous review' } }] };
  const f = await fixture(t, { definition, memory: false, visits: [previous] });
  assert.equal(claimWorkflow(f.root, f.id, 'prepare-test'), true);
  const state = f.state();
  state.sessions['jobs/alpha'] = 'ses_previous';
  const prepared = prepareGroup(f.root, state, 'jobs', previous.verdict);
  assert.notEqual(prepared.children[0].sessionId, 'ses_previous');
  state.visits.push(prepared);
  updateWorkflow(f.root, state, 'prepare-test', true);
  f.command('steer', 'verify', 'Visit the external node first');
  f.command('steer', 'jobs/alpha', 'Clarify the current item');
  await f.run();
  const result = f.state();
  assert.equal(result.status, 'succeeded', result.error);
  assert.deepEqual(result.visits.map(visit => visit.node), ['jobs', 'verify', 'review', 'verify']);
  assert.equal(result.visits[2].sessionId, 'ses_previous');
  assert.deepEqual(result.visits[2].item, item);
});

test('an unresolvable persisted steering target fails without a retry loop', async t => {
  const f = await fixture(t);
  assert.equal(claimWorkflow(f.root, f.id, 'prepare-test'), true);
  const state = f.state();
  state.controls = [{ id: 'legacy-command', kind: 'steer', node: 'jobs/missing',
    text: 'Earlier accepted clarification', status: 'pending', createdAt: 0 }];
  updateWorkflow(f.root, state, 'prepare-test', true);
  const watchdog = setTimeout(() => f.command('stop'), 2000);
  t.after(() => clearTimeout(watchdog));
  await f.run();
  clearTimeout(watchdog);
  assert.equal(f.state().status, 'failed');
  assert.match(f.state().error, /jobs\/missing/);
  assert.equal(f.admitted.length, 0);
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

test('legacy ordinary visits without admissionStarted retain their frozen input before queued steering', async t => {
  const visit = { node: 'review', participant: 'review', sessionId: 'ses_legacy', inputId: 'msg_legacy',
    prompt: 'Saved legacy request\nЮникод  ', revision: 'original' };
  const f = await fixture(t, { visits: [visit] });
  f.command('steer', 'review', 'First later clarification');
  f.command('steer', 'review', 'Second later clarification');
  await f.run();
  const state = f.state();
  assert.equal(state.status, 'succeeded', state.error);
  assert.deepEqual(state.controls.map(command => command.status), ['applied', 'applied']);
  assert.deepEqual(f.admitted.slice(0, 3).map(request => request.sessionId), Array(3).fill('ses_legacy'));
  assert.equal(f.admitted[0].inputId, visit.inputId);
  assert.equal(f.admitted[0].request.text, visit.prompt);
  assert.match(f.admitted[1].request.text, /First later clarification/);
  assert.match(f.admitted[2].request.text, /Second later clarification/);
  assert(!Object.hasOwn(state.visits[0], 'admissionStarted'));
});

for (const [marker, admitted] of [[undefined, false], [true, false], [true, true]]) {
  test(`partially admitted groups preserve terminal children and retry only unfinished inputs (marker=${marker}, admitted=${admitted})`, async t => {
    const definition = { task: 'Resume persisted children', workspace: 'directory', entry: 'jobs',
      nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
      groups: { jobs: { member: 'review', items: ['done', 'error', 'active', 'pending'].map(id => ({ id })) } },
      transitions: { jobs: { done: 'verify', failed: null, changes: null },
        review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
    const children = ['done', 'error', 'active', 'pending'].map(id => ({ node: 'review', participant: `jobs/${id}`,
      required: id !== 'error', item: { id, detail: `saved ${id}` }, sessionId: `ses_${id}`, inputId: `msg_${id}`,
      revision: 'original', prompt: `Saved ${id}`,
      ...(id === 'done' ? { verdict: { outcome: 'approve', summary: 'Persisted result without admitted flag' } } : {}),
      ...(id === 'error' ? { error: 'Persisted branch error' } : {}),
      ...(id === 'active' ? { admitted: true } : {}) }));
    const f = await fixture(t, { definition, visits: [{ node: 'jobs', revision: 'original', children, admitted,
      ...(marker === undefined ? {} : { admissionStarted: marker }) }] });
    const reads = [];
    const read = io.read;
    io.read = async request => { reads.push(request.inputId); return read(request); };
    await f.run();
    const state = f.state();
    // Group aggregation tolerates the optional error, but the existing final
    // mandatory-approval check still rejects the missing mapped review.
    assert.equal(state.status, 'failed');
    assert.match(state.error, /jobs\/error/);
    assert.equal(f.admitted.filter(request => request.inputId.startsWith('msg_')).length, 2);
    assert.equal(f.admitted[0].inputId, 'msg_pending');
    assert.deepEqual(reads.slice(0, 2), ['msg_active', 'msg_pending']);
    assert.deepEqual(state.visits[0].children[0], children[0]);
    assert.deepEqual(state.visits[0].children[1], children[1]);
    assert.deepEqual(state.visits[0].verdict.results.map(result => result.participant), children.map(child => child.participant));
    assert.equal(state.visits[0].verdict.results[1].error, 'Persisted branch error');
    assert.equal(state.visits[0].verdict.outcome, 'done');
  });
}

test('a legacy research-mid correction retries its saved input without reopening the original request', async t => {
  const definition = JSON.parse(await readFile(new URL('./workflows/research-mid.json', import.meta.url), 'utf8'));
  const correction = { inputId: 'msg_correction', prompt: 'DWF needs a corrected JSON response\nЮникод  ' };
  const visit = { node: 'scientist', participant: 'scientist', sessionId: 'ses_scientist', inputId: 'msg_original',
    prompt: 'Original scientist request', revision: 'original', admitted: false, correction };
  const f = await fixture(t, { definition, visits: [visit] });
  const admit = io.admit;
  io.admit = async request => {
    await admit(request);
    if (f.admitted.length === 1) throw new Error('Lost correction acknowledgement');
  };
  const reads = [];
  io.read = async request => {
    reads.push(request.inputId);
    return { outcome: { status: 'succeeded', result: JSON.stringify({ outcome: 'scout', summary: 'Corrected assignments',
      items: [{ id: 'foundations', instructions: 'Sources' }, { id: 'recent', instructions: 'Recent sources' }] }) } };
  };
  let stopped = false;
  io.snapshot = () => {
    if (!stopped && f.state().visits[0].verdict) { stopped = true; f.command('stop'); }
    return 'original';
  };
  await f.run();
  const state = f.state();
  assert.equal(state.status, 'cancelled');
  assert.deepEqual(reads, ['msg_correction']);
  assert.equal(state.visits[0].verdict.outcome, 'scout');
  assert.equal(f.admitted.length, 2);
  assert.deepEqual(f.admitted[0], f.admitted[1]);
  assert.equal(f.admitted[0].sessionId, visit.sessionId);
  assert.equal(f.admitted[0].inputId, correction.inputId);
  assert.equal(f.admitted[0].request.text, correction.prompt);
  assert.equal(state.visits[0].prompt, visit.prompt);
  assert(!Object.hasOwn(state.visits[0], 'admissionStarted'));
});

test('a persisted terminal error is not sent or read again', async t => {
  const f = await fixture(t, { visits: [{ node: 'review', error: 'Saved terminal error' }] });
  io.read = () => { throw publicError('Terminal error was incorrectly polled'); };
  await f.run();
  assert.equal(f.state().status, 'failed');
  assert.equal(f.state().error, 'Saved terminal error');
  assert.equal(f.admitted.length, 0);
});

for (const kind of ['single', 'fixed', 'map']) {
  const group = kind !== 'single';
  for (const control of ['stop', 'replacement owner']) {
    test(`${control} prevents stale ${kind} admission after the saved boundary`, async t => {
      const child = { node: 'review', participant: kind === 'map' ? 'jobs/alpha' : 'review',
        ...(kind === 'map' ? { item: { id: 'alpha' } } : {}), sessionId: 'ses_saved', inputId: 'msg_saved',
        revision: 'original', prompt: 'Frozen request' };
      const definition = { task: 'Fence admission', workspace: 'directory', entry: group ? 'jobs' : 'review',
        nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
        ...(group ? { groups: { jobs: kind === 'map' ? { member: 'review', items: [{ id: 'alpha' }] } : { members: ['review'] } } } : {}),
        transitions: { review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null },
          ...(group ? { jobs: { done: 'verify', failed: null, changes: null } } : {}) } };
      const visit = group ? { node: 'jobs', admissionStarted: true, children: [child] } : { ...child, admissionStarted: true };
      const f = await fixture(t, { definition, visits: [visit] });
      io.connect = async () => {
        if (control === 'stop') f.command('stop');
        else {
          const db = new DatabaseSync(join(f.root, 'dwf.sqlite'));
          try { db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(f.id); }
          finally { db.close(); }
          assert.equal(claimWorkflow(f.root, f.id, 'replacement'), true);
        }
        return {};
      };
      await f.run();
      assert.equal(f.admitted.length, 0);
      assert.equal(f.state().status, control === 'stop' ? 'cancelled' : 'running');
      if (control === 'stop') assert.equal(f.state().controls[0].status, 'applied');
    });
  }
}

test('prepared mapped steering updates only its bound package version while preserving the other child', async t => {
  const taskPackages = ['A', 'B'].map(id => ({ formatVersion: 1, id: `task-${id}`, requirements: `Exact task ${id}`,
    acceptanceCriteria: [], dependencies: [], decisions: [], artifacts: [] }));
  const definition = { task: 'Prepared package steering', workspace: 'directory', taskPackages, entry: 'jobs',
    nodes: { review: { role: 'reviewer', taskId: 'task-A' }, verify: { role: 'verifier' } },
    groups: { jobs: { member: 'review', items: [{ id: 'alpha' }, { id: 'beta', taskId: 'task-B' }] } },
    transitions: { jobs: { done: 'verify', changes: null, failed: null },
      review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const children = definition.groups.jobs.items.map((item, index) => ({ node: 'review', participant: `jobs/${item.id}`,
    item, required: true, taskId: taskPackages[index].id, taskVersion: 1,
    sessionId: `ses_${item.id}`, inputId: `msg_${item.id}`, revision: 'original', prompt: `Item ${item.id}` }));
  const f = await fixture(t, { definition, visits: [{ node: 'jobs', inputId: 'group_1', revision: 'original', admissionStarted: false, children }] });
  f.command('steer', 'jobs/beta', 'Exact clarification for B');
  await f.run();
  const state = f.state();
  assert.equal(state.status, 'succeeded', state.error);
  assert.deepEqual(state.visits[0].children.map(child => [child.taskId, child.taskVersion]), [['task-A', 1], ['task-B', 2]]);
  assert.equal(state.taskRevisions[0].taskId, 'task-B');
  assert.equal(state.taskRevisions[0].text, 'Exact clarification for B');
  assert.doesNotMatch(f.admitted[0].request.text, /Exact clarification for B/);
  assert.match(f.admitted[1].request.text, /Exact clarification for B/);
});

test('legacy prepared steering recovers orphan context documents left before a failed state commit', async t => {
  const definition = { task: 'Recover a legacy prepared draft', workspace: 'directory', entry: 'jobs',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    groups: { jobs: { members: ['review'] } },
    transitions: { jobs: { done: 'verify', changes: null, failed: null },
      review: { approve: 'verify', changes: null }, verify: { approve: null, changes: null } } };
  const child = { node: 'review', participant: 'review', required: true, sessionId: 'ses_legacy',
    inputId: 'msg_legacy', revision: 'original', prompt: 'Saved raw-only draft' };
  const f = await fixture(t, { definition, visits: [{ node: 'jobs', inputId: 'group_legacy', revision: 'original',
    admissionStarted: false, children: [child] }] });
  const first = f.command('steer', 'review', 'FIRST_CLARIFICATION');
  const { prepareRoleInput } = await import('./role-context.mjs');
  const saved = f.state();
  const orphan = structuredClone(child);
  // Simulate process failure after document writes but before the enclosing
  // SQLite action commits: persisted legacy child still has no taskContext.
  prepareRoleInput(f.root, saved, orphan, undefined, saved.workspace, 'jobs', first);
  const document = join(orphan.contextDirectory, 'context.json');
  const original = await readFile(document, 'utf8');
  f.command('steer', 'review', 'SECOND_CLARIFICATION');
  await f.run();
  const result = f.state();
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.visits[0].verdict.outcome, 'done');
  assert.notEqual(result.visits[0].children[0].inputId, child.inputId);
  assert.equal(result.visits[0].children[0].sessionId, child.sessionId);
  assert.deepEqual(result.controls.map(command => command.status), ['applied', 'applied']);
  assert.equal(await readFile(document, 'utf8'), original);
});
