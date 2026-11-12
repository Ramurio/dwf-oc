import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { admissionStage } from './workflow-admission.mjs';
import { createWorkflow, getWorkflow } from './run-store.mjs';

const verdict = { outcome: 'approve', summary: 'Already checked' };
for (const [name, visit, group, expected] of [
  ['prepared', { admissionStarted: false }, undefined, 'prepared'],
  ['started', { admissionStarted: true }, undefined, 'admission_started'],
  ['admitted', { admissionStarted: true, admitted: true }, undefined, 'admitted'],
  ['verdict', { admissionStarted: false, verdict }, undefined, 'finished'],
  ['error', { admitted: true, error: 'Branch failed' }, undefined, 'finished'],
  ['terminal blocked verdict', { verdict: { outcome: 'blocked' } }, undefined, 'finished'],
  ['terminal changes verdict', { verdict: { outcome: 'changes' } }, undefined, 'finished'],
  ['legacy unacknowledged', {}, undefined, 'admission_started'],
  ['legacy explicit unacknowledged', { admitted: false }, undefined, 'admission_started'],
  ['legacy admitted', { admitted: true }, undefined, 'admitted'],
  ['legacy completed', { verdict }, undefined, 'finished'],
  ['legacy error', { error: 'Earlier error' }, undefined, 'finished'],
  ['admitted takes precedence over preparation', { admissionStarted: false, admitted: true }, undefined, 'admitted'],
  ['correction awaits its own admission', { admissionStarted: true, admitted: false,
    correction: { inputId: 'msg_correction', prompt: 'Correct the answer' } }, undefined, 'admission_started'],
  ['admitted correction', { admitted: true, correction: { inputId: 'msg_correction' } }, undefined, 'admitted'],
  ['prepared group child', {}, { admissionStarted: false }, 'prepared'],
  ['started group child', {}, { admissionStarted: true }, 'admission_started'],
  ['legacy group child', {}, {}, 'admission_started'],
  ['admitted group child', { admitted: true }, { admissionStarted: true }, 'admitted'],
  ['finished group child without acknowledgement', { verdict }, { admissionStarted: true }, 'finished'],
  ['failed group child', { error: 'Admission rejected' }, { admissionStarted: true }, 'finished'],
  ['partially admitted group', { admissionStarted: true, admitted: false,
    children: [{ admitted: true }, {}, { verdict }, { error: 'Rejected' }] }, undefined, 'admission_started'],
  ['admitted group still awaiting join', { admitted: true, children: [{ verdict }] }, undefined, 'admitted'],
  ['finished group', { admitted: true, verdict: { outcome: 'done' }, children: [{ verdict }] }, undefined, 'finished'],
]) {
  test(`computed admission stage: ${name}`, () => {
    const before = JSON.stringify({ visit, group });
    assert.equal(admissionStage(visit, group), expected);
    assert.equal(JSON.stringify({ visit, group }), before, 'Derivation must not mutate persisted fields');
  });
}

test('deriving group and child stages neither writes a stage nor normalizes legacy JSON in SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dwf-admission-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { id: 'legacy', visits: [{ node: 'jobs', children: [
    { participant: 'jobs/alpha', admitted: true }, { participant: 'jobs/beta', verdict },
    { participant: 'jobs/gamma', error: 'Rejected' }, { participant: 'jobs/delta' },
  ] }] };
  createWorkflow(root, state);
  const db = new DatabaseSync(join(root, 'dwf.sqlite'));
  t.after(() => db.close());
  const stored = () => db.prepare('SELECT state FROM workflows WHERE id = ?').get(state.id).state;
  const before = stored();
  const saved = getWorkflow(root, state.id);
  const group = saved.visits[0];
  assert.equal(admissionStage(group), 'admission_started');
  assert.deepEqual(group.children.map(child => admissionStage(child, group)),
    ['admitted', 'finished', 'finished', 'admission_started']);
  assert.equal(JSON.stringify(saved), before);
  assert.equal(stored(), before);
  assert.deepEqual(db.prepare('PRAGMA table_info(workflows)').all().map(column => column.name),
    ['id', 'state', 'owner', 'expires']);
});
