// Regression for the trial's real lifecycle interventions, with only model
// replies controlled. This fixture is NOT the independent three-function seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createSandbox, cliJson, readJson, writeJson, waitFor } from './harness.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { implementDefinition } from './implement-definition.mjs';
import { currentContext } from './context-delivery.mjs';
import { getWorkflow } from '../run-store.mjs';

const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const result = (outcome, extra = {}) => JSON.stringify({ outcome, summary: 'Controlled lifecycle regression', ...extra });

test('trial hooks kill only the controller, then public continue restores the same run and preserves successes after a later failure', { timeout: 120000 }, async t => {
  const s = await createSandbox();
  const provider = await createControlledHttpProvider({ directory: s.control, token: s.token, reply: ({ prompt, toolResults }) => {
    const context = currentContext(prompt);
    if (context.role === 'orchestrator') {
      const instances = context.implements.instances;
      if (instances.every(i => i.status === 'integrated')) return result('finish');
      return result('dispatch', { implements: instances.flatMap(i => i.status === 'pending'
        ? [{ action: 'admit', id: i.id, assignment: `Create ${i.id}.txt` }]
        : i.status === 'ready' ? [{ action: 'integrate', id: i.id }] : []) });
    }
    if (context.role === 'worker' && !toolResults.length) return { toolCalls: [{ name: 'shell', arguments: { command: `printf ${context.implement.id} > ${context.implement.id}.txt` } }] };
    return result(context.role === 'worker' ? 'done' : 'approve');
  } });
  t.after(async () => { await provider.close(); await s.cleanup(); });
  Object.assign(s.env, { DWF_CONTEXT_TRIAL_CONTROL: s.control,
    NODE_OPTIONS: `--import=${new URL('./context-implement-faults.mjs', import.meta.url).href}`,
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_FILEWATCHER: 'true', OPENCODE_DISABLE_FFF: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', OPENCODE_CONFIG: join(s.root, 'provider.json'),
    DWF_PLANNER_MODEL: JSON.stringify({ provider: 'dwf-acceptance', modelId: 'planner' }), DWF_PLANNER_REASONING: 'high' });
  await writeJson(s.env.OPENCODE_CONFIG, nativeProviderConfig(provider.baseURL));
  for (const args of [['init', '-qb', 'main'], ['config', 'user.name', 'DWF Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-qm', 'base']]) {
    execFileSync('git', args, { cwd: s.workspace, env: s.env, stdio: 'pipe' });
  }
  await writeJson(join(s.root, 'workflow.json'), implementDefinition());
  const command = args => cliJson(s.spawn(cli, args), 25000);
  const { runId } = await command(['start', '--file', join(s.root, 'workflow.json')]);
  // Release all native responses; both admissions are durably saved before the
  // hook kills the controller. Native work keeps running while its lease expires.
  await writeJson(join(s.control, 'release.json'), { token: s.token, all: true });
  const crash = await waitFor(() => readJson(join(s.control, 'crash.json')), 20000, 'real trial controller crash');
  assert.equal(crash.runId, runId);
  const before = await readJson(join(s.control, 'before-crash.json'));
  assert.equal(crash.inputIds.length, 2);
  await pause(Math.max(0, crash.at + 31000 - Date.now()));
  const continued = await command(['continue', runId]);
  assert.notEqual(continued.recovery?.status, 'blocked');
  await writeFile(join(s.control, 'crash-released'), '');
  const failed = await waitFor(() => { const state = getWorkflow(s.state, runId); return state.status === 'failed' && state; }, 30000, 'controlled later admission failure');
  assert.match(failed.error, /Controlled trial admission/);
  const successes = failed.visits.filter(v => v.implementId && v.verdict);
  assert(successes.length >= 6);
  await writeFile(join(s.control, 'failure-released'), '');
  await command(['continue', runId]);
  const final = await waitFor(() => { const state = getWorkflow(s.state, runId); return state.status === 'succeeded' && state; }, 30000, 'same run completes');
  for (const old of successes) assert.deepEqual(final.visits.find(v => v.inputId === old.inputId), old);
  for (const id of crash.inputIds) {
    const old = before.visits.find(v => v.inputId === id);
    const visit = final.visits.find(v => v.inputId === id);
    assert.equal(visit.sessionId, old.sessionId); assert.equal(visit.prompt, old.prompt);
  }
  assert.equal(final.visits.filter(v => v.implementId && v.node === 'work').length, 3);
  for (const id of ['alpha', 'beta', 'gamma']) assert.equal(await readFile(join(s.workspace, `${id}.txt`), 'utf8'), id);
  const count = final.visits.length; await command(['continue', runId]);
  assert.equal(getWorkflow(s.state, runId).visits.length, count);
});
