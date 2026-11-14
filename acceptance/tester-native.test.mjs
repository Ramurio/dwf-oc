import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox, writeJson } from './harness.mjs';
import { connectTester, checkTester } from './tester.mjs';
import { checkCandidateCli } from './candidate-tester.mjs';
import { nativeProviderConfig } from './controlled-http-provider.mjs';

test('native fresh tester profile loads precisely the supplied candidate skill without model calls', { timeout: 45000 }, async t => {
  const s = await createSandbox(); t.after(() => s.cleanup());
  const candidate = join(s.root, 'candidate'); await mkdir(candidate);
  await writeFile(join(candidate, 'SKILL.md'), '---\nname: dwf-oc\ndescription: native loading fixture\n---\nNative candidate launcher body\n');
  Object.assign(s.env, { OPENCODE_CONFIG: join(s.root, 'provider.json'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_FILEWATCHER: 'false' });
  // Catalog only: no request is sent to this intentionally non-serving endpoint.
  await writeJson(s.env.OPENCODE_CONFIG, nativeProviderConfig('http://127.0.0.1:1'));
  const bin = join(s.root, 'bin'); await mkdir(bin);
  const wrapper = join(bin, 'dwf'); await writeFile(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  s.env.PATH = bin + ':' + s.env.PATH;
  const client = await connectTester(s.root, s.state, true, { env: s.env, skillDirectory: candidate, authorize: false });
  assert.equal(client.dwfProfile.configDirectory, s.env.OPENCODE_CONFIG_DIR);
  assert.equal(client.dwfProfile.env.HOME, s.env.HOME);
  const attempt = { directory: s.root, workspace: s.workspace, candidateCli: { wrapper },
    model: { providerID: 'dwf-acceptance', id: 'planner', variant: 'high' } };
  const cliEvidence = await checkCandidateCli(client, attempt);
  assert.equal(cliEvidence.nativeResolved, wrapper);
  await assert.rejects(checkCandidateCli(client, { ...attempt, candidateCli: { wrapper: process.execPath } }), /another dwf/);
  await checkTester(client, attempt);
  const evidence = JSON.parse(await readFile(join(s.root, 'skill-evidence.json'), 'utf8'));
  assert.equal(evidence.sha256, client.dwfTesterSkill.sha256);
  assert.equal(evidence.loadedPath, join(s.env.OPENCODE_CONFIG_DIR, 'skills/dwf-oc/SKILL.md'));
  await writeFile(join(candidate, 'SKILL.md'), 'Different candidate');
  await assert.rejects(connectTester(s.root, s.state, true, { env: s.env, skillDirectory: candidate, authorize: false }), /fresh/);
});
