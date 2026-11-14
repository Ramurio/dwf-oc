import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Preserve every byte of every original test. Append-only stronger tests are
// allowed by the seed's "do not remove or weaken" contract. Execute the pristine
// suite separately so appended code cannot mask/disable the original checks.
export async function verifyOriginalTrialTests(seed, workspace, evidenceDirectory) {
  const directory = await mkdtemp(join(evidenceDirectory, 'original-suite-'));
  await mkdir(join(directory, 'test'));
  for (const name of ['label', 'duration', 'report']) {
    const original = await readFile(join(seed, 'test', `${name}.test.mjs`));
    const actual = await readFile(join(workspace, 'test', `${name}.test.mjs`));
    assert(actual.subarray(0, original.length).equals(original), `Original ${name} acceptance test was removed, rewritten or weakened.`);
    await copyFile(join(seed, 'test', `${name}.test.mjs`), join(directory, 'test', `${name}.test.mjs`));
  }
  for (const name of ['src', 'registry.json', 'cli.mjs']) await symlink(resolve(workspace, name), join(directory, name));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ['--test'], { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await writeFile(join(evidenceDirectory, 'original-acceptance-tests.log'), output, { mode: 0o600 });
  return { directory, output };
}
