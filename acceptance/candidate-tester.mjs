// Preparation for the independent context/implement trial, not a substitute for
// its tester, fault interventions or acceptance assertions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttempt, connectTester, authorizeTester, checkTester } from './tester.mjs';
import { writeJson, waitFor } from './harness.mjs';
import { openCodeProfile } from '../opencode-runtime.mjs';

const cli = fileURLToPath(new URL('../dwf.mjs', import.meta.url));
// Temporary selection for this acceptance series only. Product defaults stay unchanged.
const model = { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' };
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";

export async function prepareCandidateTester(sandbox, { seed, baseline, prompt, skillDirectory }) {
  assert(baseline, 'The agreed seed baseline is required.');
  assert(skillDirectory, 'An explicit candidate launcher is required.');
  const attempt = await createAttempt(sandbox.root, seed, prompt, sandbox.state);
  assert.equal(attempt.base.commit, baseline, 'Seed is not at the agreed baseline; do not test another revision.');
  attempt.model = { ...model }; // Override createAttempt's historical ultrafast helper default.
  attempt.skillDirectory = await realpath(skillDirectory);
  const bin = join(attempt.directory, 'bin');
  await mkdir(bin, { mode: 0o700 });
  const wrapper = join(bin, 'dwf');
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o700 });
  sandbox.env.PATH = bin + delimiter + sandbox.env.PATH;
  Object.assign(sandbox.env, { OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_FILEWATCHER: 'false' });
  // The CLI's implicit planner must use the same temporary choice. The tester
  // still specifies the requested models explicitly for the workflow roles.
  sandbox.env.DWF_PLANNER_MODEL = JSON.stringify({ provider: 'openai', modelId: model.id });
  sandbox.env.DWF_PLANNER_REASONING = model.variant;
  const resolved = execFileSync('/bin/sh', ['-c', 'command -v dwf'], {
    cwd: attempt.workspace, env: sandbox.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(await realpath(resolved), await realpath(wrapper), 'PATH did not resolve the explicit candidate wrapper.');
  attempt.candidateCli = { wrapper, resolved, node: process.execPath, entry: cli };
  attempt.opencode = openCodeProfile(sandbox.env);
  await writeJson(join(attempt.directory, 'attempt.json'), attempt);
  await writeJson(join(attempt.directory, 'candidate-cli.json'), attempt.candidateCli);
  return attempt;
}

export async function connectCandidateTester(sandbox, attempt) {
  const client = await connectTester(attempt.root, attempt.stateDirectory, true, {
    env: sandbox.env, profile: attempt.opencode, skillDirectory: attempt.skillDirectory,
  });
  await checkCandidateCli(client, attempt);
  // Native credential transfer only. Never put exported credentials in evidence.
  await authorizeTester(client);
  assert.deepEqual(client.dwfProfile, attempt.opencode, 'Tester connected to a different OpenCode profile.');
  await checkTester(client, attempt); // Includes native launcher path/body and full copied-tree hash.
  return client;
}


export async function checkCandidateCli(client, attempt) {
  const location = { directory: attempt.workspace };
  const { data: shell } = await client.shell.create({ location, command: 'command -v dwf', timeout: 5000 });
  const final = await waitFor(async () => {
    const { data } = await client.shell.get({ location, id: shell.id });
    return data.status !== 'running' && data;
  }, 10000, 'native tester shell command resolution');
  assert.equal(final.status, 'exited', 'Native command-resolution shell did not finish.');
  assert.equal(final.exit, 0, 'Native tester shell cannot resolve dwf.');
  const { data: output } = await client.shell.output({ location, id: shell.id });
  assert.equal(output.truncated, false);
  const resolved = output.output.trim();
  assert.equal(await realpath(resolved), await realpath(attempt.candidateCli.wrapper),
    'Native tester shell resolved another dwf instead of the candidate wrapper.');
  const evidence = { ...attempt.candidateCli, nativeResolved: resolved, shellId: shell.id };
  await writeJson(join(attempt.directory, 'candidate-cli.json'), evidence);
  return evidence;
}
