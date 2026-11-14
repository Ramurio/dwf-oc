import test from 'node:test';
import assert from 'node:assert/strict';
import { trialSignals } from './context-implement-faults.mjs';

test('trial fault selects real admitted workers and integrated successes, not queued or finished visits', () => {
  const state = { definition: { nodes: { work: { role: 'worker' }, review: { role: 'reviewer' } } },
    implements: { instances: { a: { id: 'a', status: 'integrated' }, b: { id: 'b', status: 'ready' } } },
    visits: [
      { node: 'work', implementId: 'a', admitted: true, inputId: 'active' },
      { node: 'work', implementId: 'b', admitted: false },
      { node: 'work', implementId: 'b', admitted: true, verdict: { outcome: 'done' } },
      { node: 'review', implementId: 'b', admitted: true },
      { node: 'work', admitted: true },
    ] };
  assert.deepEqual(trialSignals(state).activeWorkers.map(v => v.inputId), ['active']);
  assert.deepEqual(trialSignals(state).integrated.map(i => i.id), ['a']);
});
