import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox } from './harness.mjs';
import { prepareCandidateTester } from './candidate-tester.mjs';

test('candidate trial uses a pristine clone, explicit wrapper, fresh profile and normal-speed Sol', async t => {
  const s = await createSandbox(); t.after(() => s.cleanup());
  const seed = s.workspace;
  const git = args => execFileSync('git', args, { cwd: seed, env: s.env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'DWF Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['add', '.']); git(['commit', '-qm', 'seed']);
  const baseline = git(['rev-parse', 'HEAD']);
  const skillDirectory = join(s.root, "candidate's skill"); await mkdir(skillDirectory);
  await writeFile(join(skillDirectory, 'SKILL.md'), 'Candidate skill\n');
  const settings = { seed, baseline, prompt: 'Use DWF for the project task.', skillDirectory };
  const attempt = await prepareCandidateTester(s, settings);
  assert.notEqual(attempt.workspace, seed);
  assert.equal(attempt.base.commit, baseline);
  assert.deepEqual(attempt.model, { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' });
  assert.equal(attempt.opencode.env.HOME, s.env.HOME);
  assert.equal(attempt.opencode.configDirectory, s.env.OPENCODE_CONFIG_DIR);
  assert.equal(attempt.candidateCli.resolved, attempt.candidateCli.wrapper);
  const actual = JSON.parse(execFileSync('/bin/sh', ['-c', 'dwf schema'], {
    cwd: attempt.workspace, env: s.env, encoding: 'utf8', stdio: 'pipe',
  }));
  assert(actual.implements, 'Resolved candidate CLI exposes the implement contract.');
  const saved = JSON.parse(await readFile(join(attempt.directory, 'attempt.json'), 'utf8'));
  assert.equal(saved.model.id, 'gpt-6.1-sol');
  assert.equal(saved.candidateCli.entry, attempt.candidateCli.entry);
  assert.equal(git(['status', '--porcelain']), '');
  await assert.rejects(prepareCandidateTester(s, { ...settings, baseline: 'wrong' }), /baseline/);
  await assert.rejects(prepareCandidateTester(s, { ...settings, skillDirectory: undefined }), /candidate launcher/);
});
