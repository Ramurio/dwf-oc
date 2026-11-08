import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, prepareWorkspace, snapshot } from './workflow-git.mjs';
import { validateWorkflow, checkApprovals } from './workflow-definition.mjs';
import { prepareGroup, groupVerdict, integrateGroup } from './workflow-groups.mjs';

function definition() {
  return { task: 'Parallel changes', entry: 'work',
    nodes: { first: { role: 'worker' }, second: { role: 'worker' }, summary: { role: 'orchestrator' } },
    groups: { work: { members: ['first', 'second'] } },
    transitions: { first: { done: 'summary' }, second: { done: 'summary' }, summary: { done: null },
      work: { done: 'summary', changes: 'summary', failed: 'summary' } } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dwf-group-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'DWF Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'shared.txt'), 'baseline\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'base']);
  const state = { id: 'group-test', definition: definition(), sessions: {}, visits: [],
    workspace: prepareWorkspace(join(root, 'state'), source, 'group-test') };
  return { root: join(root, 'state'), source, state };
}

test('group definitions validate fixed members and runtime item sources', () => {
  assert.deepEqual(validateWorkflow(definition()), definition());
  for (const invalid of [
    { members: ['first', 'first'] }, { members: ['missing'] },
    { members: ['first'], required: ['second'] },
    { member: 'first', items: [{ id: 'duplicate' }, { id: 'duplicate' }] },
    { member: 'first', itemsFrom: 'missing' },
    { members: ['first'], items: [] },
  ]) {
    const value = definition();
    value.groups.work = invalid;
    assert.throws(() => validateWorkflow(value));
  }
});

test('parallel workers have isolated trees and integrate all independent changes', async t => {
  const { root, state, source } = await fixture(t);
  const visit = prepareGroup(root, state, 'work');
  assert.notEqual(visit.children[0].workspace.path, visit.children[1].workspace.path);
  for (const child of visit.children) {
    await writeFile(join(child.workspace.path, `${child.node}.txt`), child.node);
    child.verdict = { outcome: 'done', summary: 'added file' };
    child.revision = snapshot(child.workspace);
  }
  await assert.rejects(readFile(join(state.workspace.path, 'first.txt')), { code: 'ENOENT' });
  integrateGroup(root, state, visit);
  assert.equal(await readFile(join(state.workspace.path, 'first.txt'), 'utf8'), 'first');
  assert.equal(await readFile(join(state.workspace.path, 'second.txt'), 'utf8'), 'second');
  await assert.rejects(readFile(join(source, 'first.txt')), { code: 'ENOENT' });
  assert.equal(groupVerdict(visit).results.length, 2);
});

test('conflicting worker changes preserve the parent tree and every branch result', async t => {
  const { root, state } = await fixture(t);
  const visit = prepareGroup(root, state, 'work');
  const before = snapshot(state.workspace);
  for (const child of visit.children) {
    await writeFile(join(child.workspace.path, 'shared.txt'), child.node + '\n');
    child.verdict = { outcome: 'done', summary: child.node };
    child.revision = snapshot(child.workspace);
  }
  assert.throws(() => integrateGroup(root, state, visit));
  assert.equal(snapshot(state.workspace), before);
  assert.equal(await readFile(join(state.workspace.path, 'shared.txt'), 'utf8'), 'baseline\n');
  assert.deepEqual(groupVerdict(visit).results.map(result => result.result.summary), ['first', 'second']);
});

test('map groups preserve item identities and require approval from every current member', async t => {
  const { root, state } = await fixture(t);
  state.definition.nodes.first = { role: 'reviewer' };
  state.definition.nodes.second = { role: 'orchestrator' };
  state.definition.groups.work = { member: 'first', itemsFrom: 'second' };
  state.visits = [{ node: 'second', verdict: { outcome: 'done', summary: 'tasks', items: [{ id: 'alpha' }, { id: 'beta' }] } }];
  const visit = prepareGroup(root, state, 'work');
  assert.deepEqual(visit.children.map(child => child.participant), ['work/alpha', 'work/beta']);
  assert.notEqual(visit.children[0].sessionId, visit.children[1].sessionId);
  for (const child of visit.children) child.verdict = { outcome: 'approve', summary: 'checked' };
  state.visits.push(visit);
  assert.doesNotThrow(() => checkApprovals(state, visit.revision));
  visit.children[1].revision = 'outdated';
  assert.throws(() => checkApprovals(state, visit.revision), /work\/beta/);
  visit.children[1].error = 'transport error';
  assert.equal(groupVerdict(visit).outcome, 'failed');
});

test('empty map groups cannot substitute for actual merge approvals', async t => {
  const { root, state } = await fixture(t);
  state.definition.merge = true;
  state.definition.nodes.first = { role: 'reviewer' };
  state.definition.nodes.second = { role: 'verifier' };
  state.definition.groups = { reviews: { member: 'first', items: [] }, checks: { member: 'second', items: [] } };
  state.visits = [prepareGroup(root, state, 'reviews'), prepareGroup(root, state, 'checks')];
  assert.throws(() => checkApprovals(state, snapshot(state.workspace)), /фактические одобрения/);
});
