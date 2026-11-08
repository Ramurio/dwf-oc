import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkAssessment, benchmarkEnvironment, benchmarkWorkflows, prepareBenchmark } from './benchmark.mjs';
import { createWorkflow } from '../run-store.mjs';

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
