import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow, getWorkflow, queueWorkflowCommand } from './run-store.mjs';

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
        export const stopSessions = async () => { globalThis.dwfControlIO.stops++; };
      ` };
    }
    if (url === new URL('./workflow-git.mjs', import.meta.url).href) {
      return { format: 'module', shortCircuit: true, source: `
        export const snapshot = () => globalThis.dwfControlIO.snapshot();
        export const verificationWorkspace = (_root, _id, workspace) => workspace;
        export const writeReviewDiff = () => {};
        export const mergeWorkspace = () => 'commit';
      ` };
    }
    return next(url, context);
  },
});
const { runWorkflow } = await import('./workflow-runtime.mjs');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dwf-control-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'controlled';
  const definition = { task: 'Controlled scheduling', workspace: 'directory', entry: 'review',
    nodes: { review: { role: 'reviewer' }, verify: { role: 'verifier' } },
    transitions: { review: { approve: 'verify', changes: 'verify' }, verify: { approve: null, changes: null } } };
  createWorkflow(root, { id, definition, workspace: { mode: 'directory', path: root },
    status: 'running', visits: [], sessions: {} });
  const admitted = [];
  io = globalThis.dwfControlIO = {
    stops: 0, snapshot: () => 'original', connect: async () => ({}),
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
