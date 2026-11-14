import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyOriginalTrialTests } from './original-trial-tests.mjs';

test('original acceptance bytes cannot change; appended tests cannot hide the independently run pristine suite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dwf-original-tests-')); t.after(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, 'seed'), workspace = join(root, 'candidate');
  await mkdir(join(seed, 'test'), { recursive: true });
  for (const name of ['label', 'duration', 'report']) await writeFile(join(seed, 'test', `${name}.test.mjs`),
    `import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/index.mjs';\ntest('${name}',()=>assert.equal(value,42));\n`);
  await cp(seed, workspace, { recursive: true }); await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src/index.mjs'), 'export const value = 42;\n');
  await writeFile(join(workspace, 'registry.json'), '{}\n'); await writeFile(join(workspace, 'cli.mjs'), '// fixture\n');
  const path = join(workspace, 'test/duration.test.mjs'), original = await readFile(path, 'utf8');
  await writeFile(path, original + "\n// additional tests belong to the full candidate suite\n");
  const first = await verifyOriginalTrialTests(seed, workspace, root);
  assert.equal(await readFile(join(first.directory, 'test/duration.test.mjs'), 'utf8'), original);
  await writeFile(path, original.replace('42', '0'));
  await assert.rejects(verifyOriginalTrialTests(seed, workspace, root), /rewritten or weakened/);
  await writeFile(path, original + '\nprocess.exit(0);\n');
  await writeFile(join(workspace, 'src/index.mjs'), 'export const value = 0;\n');
  await assert.rejects(verifyOriginalTrialTests(seed, workspace, root));
});
