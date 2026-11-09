import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkAssessment, benchmarkEnvironment, benchmarkWorkflows, monitorBenchmark, prepareBenchmark } from './benchmark.mjs';
import { claimWorkflow, createWorkflow, updateWorkflow } from '../run-store.mjs';

test('benchmark archives a pristine baseline with no future Git objects or runtime task records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-benchmark-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'upstream');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'code.txt'), 'baseline\n');
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  const baseline = git(['rev-parse', 'HEAD']);
  await writeFile(join(source, 'code.txt'), 'private future answer\n');
  git(['commit', '-qam', 'private answer']);
  const future = git(['rev-parse', 'HEAD']);
  const settings = { root: join(directory, 'benchmark'), project: source, baseline, prompt: 'Use DWF.' };
  const first = await prepareBenchmark(settings);
  const second = await prepareBenchmark(settings);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.workspace, second.workspace);
  assert.equal(await readFile(join(first.workspace, 'code.txt'), 'utf8'), 'baseline\n');
  assert.equal(execFileSync('git', ['-C', first.workspace, 'rev-list', '--all', '--count'], { encoding: 'utf8' }).trim(), '1');
  assert.equal(execFileSync('git', ['-C', first.workspace, 'remote'], { encoding: 'utf8' }).trim(), '');
  assert.throws(() => execFileSync('git', ['-C', first.workspace, 'cat-file', '-e', future], { stdio: 'pipe' }));
  await assert.rejects(readFile(join(first.runtime, '.beads/issues.jsonl')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(first.runtime, 'acceptance/benchmark-results.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(first.runtime, 'docs/autonomous-goal.md')), { code: 'ENOENT' });
  await assert.rejects(prepareBenchmark({ ...settings, root: join(source, 'benchmark') }), /outside/);
});

test('benchmark sanitizes inherited secrets and directs caches into the attempt', () => {
  const key = 'DWF_TEST_PRIVATE_CREDENTIAL';
  process.env[key] = 'must not leak';
  try {
    const env = benchmarkEnvironment({ directory: '/attempt', workspace: '/attempt/project', stateDirectory: '/attempt/state' },
      'http://127.0.0.1:1234', 1235, { npm_config_cache: '{{attempt}}/npm-cache', PYTHONPATH: '{{project}}/src' });
    assert.equal(env[key], '');
    assert.equal(env.HOME, '/attempt/home');
    assert.equal(env.DWF_STATE_DIR, '/attempt/state');
    assert.equal(env.npm_config_cache, '/attempt/npm-cache');
    assert.equal(env.PYTHONPATH, '/attempt/project/src');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1234');
  } finally { delete process.env[key]; }
});

test('benchmark distinguishes a successful tester report from actual workflow completion', () => {
  const tester = { status: 'succeeded' };
  assert.equal(benchmarkAssessment(tester, []).status, 'failed');
  const workflow = { id: 'test', status: 'failed', definition: { merge: true }, error: 'Blocked check' };
  assert.equal(benchmarkAssessment(tester, [workflow]).status, 'failed');
  assert.equal(benchmarkAssessment(tester, [{ ...workflow, status: 'running' }]).status, 'running');
  assert.equal(benchmarkAssessment(tester, [{ ...workflow, status: 'succeeded' }]).status, 'failed');
  const complete = { ...workflow, status: 'succeeded', error: undefined, result: { commit: 'verified' } };
  const result = benchmarkAssessment(tester, [complete]);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.workflows[0].integration, 'merged');
  assert.equal(benchmarkAssessment({ status: 'failed' }, [complete]).status, 'failed');
});

test('benchmark observes its own durable workflow state after the tester finishes', async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'dwf-benchmark-state-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const attempt = { stateDirectory };
  assert.deepEqual(benchmarkWorkflows(attempt), []);
  const workflow = { id: 'pending', status: 'running', definition: { merge: true } };
  createWorkflow(stateDirectory, workflow);
  assert.deepEqual(benchmarkWorkflows(attempt), [workflow]);
  assert.equal(benchmarkAssessment({ status: 'succeeded' }, benchmarkWorkflows(attempt)).status, 'running');
});

test('benchmark waits for a concurrent state transaction before reading workflows', async t => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'dwf-benchmark-lock-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const workflow = { id: 'work', status: 'running', definition: { merge: true } };
  createWorkflow(stateDirectory, workflow);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);
  `, join(stateDirectory, 'dwf.sqlite')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill());
  await once(holder.stdout, 'data');
  assert.deepEqual(benchmarkWorkflows({ stateDirectory }), [workflow]);
  const [code] = await once(holder, 'exit');
  assert.equal(code, 0);
});

test('benchmark rereads a resumed tester until the combined assessment finishes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-benchmark-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attempt = { directory, stateDirectory: directory };
  const workflow = { id: 'work', status: 'running', definition: { merge: true } };
  createWorkflow(directory, workflow);
  assert(claimWorkflow(directory, workflow.id, 'controller'));
  let polls = 0;
  const resumed = [];
  const result = await monitorBenchmark(attempt, {
    interval: 0,
    inspect: async () => ({ status: ['succeeded', 'running', 'failed'][polls++], messageCount: polls }),
    resume: async id => {
      resumed.push(id);
      updateWorkflow(directory, { ...workflow, status: 'succeeded', result: { commit: 'verified' } }, 'controller', true);
    },
  });
  assert.equal(polls, 3);
  assert.deepEqual(resumed, ['work']);
  assert.equal(result.state.status, 'failed');
  assert.equal(result.assessment.status, 'failed');
  assert.equal(JSON.parse(await readFile(join(directory, 'assessment.json'), 'utf8')).status, 'failed');
});
