import { currentContext, wireContext } from './context-delivery.mjs';
// Controlled model only; real candidate CLI, native OpenCode inbox/tools/storage,
// separate service profile and Git repositories. Never use the developer service.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { createSandbox, cliJson, transcript, waitFor, writeJson, taggedProcesses } from './harness.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { implementDefinition } from './implement-definition.mjs';
import { installAdmissionFault } from './admission-faults.mjs';
import { getWorkflow } from '../run-store.mjs';

const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const taskContext = currentContext;
const context = (prompt, name) => {
  const data = taskContext(prompt);
  if (name === 'Implement control context') return data.implements;
  assert.equal(name, 'Implement execution context');
  return { ...data.implement, assignment: data.assignment.implement.text, previous: data.otherReports?.handoff };
};
const result = (outcome, summary = 'Checked the candidate', extra = {}) => JSON.stringify({ outcome, summary, ...extra });
const stage = (prompt, id) => taskContext(prompt).assignment.instructions === 'native-stage=' + id;
const callsOf = events => events.filter(event => event.type === 'received');

async function fixture(t, reply, definition = implementDefinition(), options = {}) {
  const sandbox = await createSandbox();
  const provider = await createControlledHttpProvider({ directory: sandbox.control, token: sandbox.token, reply });
  t.after(async () => { await provider.close(); await sandbox.cleanup(); });
  const isolated = join(sandbox.root, 'isolated');
  await mkdir(isolated);
  Object.assign(sandbox.env, {
    OPENCODE_TEST_HOME: isolated, OPENCODE_CONFIG_DIR: join(isolated, 'config'),
    XDG_CONFIG_HOME: join(isolated, 'config'), XDG_DATA_HOME: join(isolated, 'data'),
    XDG_CACHE_HOME: join(isolated, 'cache'), XDG_STATE_HOME: join(isolated, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_FFF: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    DWF_PLANNER_MODEL: JSON.stringify({ provider: 'dwf-acceptance', modelId: 'planner' }),
    DWF_PLANNER_REASONING: 'high', OPENCODE_CONFIG: join(sandbox.root, 'provider.json'),
  });
  delete sandbox.env.OPENCODE_CONFIG_CONTENT;
  Object.assign(sandbox.env, options.env);
  await writeJson(sandbox.env.OPENCODE_CONFIG, nativeProviderConfig(provider.baseURL));
  definition.nodes.integrationVerify.tools ??= ['shell'];
  definition.nodes.verify.tools ??= ['shell'];
  for (const [id, node] of Object.entries(definition.nodes)) node.instructions = `native-stage=${id}`;
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'base']]) {
    execFileSync('git', args, { cwd: sandbox.workspace, env: sandbox.env, stdio: 'pipe' });
  }
  const file = join(sandbox.root, 'workflow.json');
  await writeJson(file, definition);
  if (options.beforeStart) await options.beforeStart(sandbox);
  const fault = options.fault && installAdmissionFault(sandbox, options.fault.boundary, options.fault.index);
  const start = sandbox.spawn(cli, ['start', '--file', file]);
  const { runId } = await cliJson(start, 20000);
  const command = async args => {
    const process = sandbox.spawn(cli, args);
    try { return await cliJson(process, 20000); }
    catch (error) { throw new Error(`${error.message}: ${process.stderr}`); }
  };
  const state = () => getWorkflow(sandbox.state, runId);
  const events = () => transcript(join(sandbox.control, 'provider.jsonl'));
  const released = new Set();
  return { ...sandbox, stateRoot: sandbox.state, runId, state, command, events, fault,
    calls: async () => callsOf(await events()),
    release: async selected => {
      for (const call of selected) released.add(call.callId);
      await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [...released] });
    },
    releaseAll: () => writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, all: true }),
    finish: () => waitFor(() => state().status !== 'running' && state(), 40000, 'implement workflow completion'),
  };
}

function reply({ prompt, toolResults }, changes = false) {
  if (stage(prompt, 'manage')) {
    const control = context(prompt, 'Implement control context');
    const pending = control.instances.filter(instance => instance.status === 'pending');
    const corrections = control.instances.filter(instance => instance.status === 'changes_requested');
    const ready = control.instances.filter(instance => instance.status === 'ready');
    if (control.instances.every(instance => instance.status === 'integrated')) return result('finish');
    return result('dispatch', 'Dispatch concrete implement tasks', { implements: [
      ...pending.map(instance => ({ action: 'admit', id: instance.id, assignment: `Create ${instance.id}.txt with ${instance.id}` })),
      ...corrections.map(instance => ({ action: 'revise', id: instance.id, assignment: 'Correct alpha and add revision.txt' })),
      ...ready.map(instance => ({ action: 'integrate', id: instance.id })),
    ] });
  }
  if (stage(prompt, 'integrationVerify')) {
    if (!toolResults.some(text => text.includes('combined-ok'))) return { toolCalls: [{ name: 'shell', arguments: {
      command: 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta && test "$(cat gamma.txt)" = gamma && echo combined-ok',
    } }] };
    return result('approve', 'DWF feat: combine independent implement results\n\nVerified the combined files with native shell checks.');
  }
  if (stage(prompt, 'integrationReview')) return result('approve');
  const implement = context(prompt, 'Implement execution context');
  if (stage(prompt, 'work')) {
    const revision = implement.assignment.includes('revision.txt') ||
      (implement.previous?.outcome === 'changes' && implement.previous.summary.includes('revision.txt'));
    const marker = `written-${implement.id}-${revision}`;
    if (!toolResults.some(text => text.includes(marker))) return { toolCalls: [{ name: 'shell', arguments: {
      command: `printf '${implement.id}' > ${implement.id}.txt; ${revision ? 'printf revised > revision.txt; ' : ''}echo ${marker}`,
    } }] };
    return result('done', `Created ${implement.id}.txt${revision ? ' and revision.txt' : ''}`);
  }
  if (changes && stage(prompt, 'review') && implement.id === 'alpha' && implement.cycle === 1) return result('changes', 'Add revision.txt');
  if (stage(prompt, 'verify')) {
    const marker = `verified-${implement.id}-${implement.cycle}-${implement.candidateRevision}`;
    if (!toolResults.some(text => text.includes(marker))) return { toolCalls: [{ name: 'shell', arguments: {
      command: `test "$(cat ${implement.id}.txt)" = ${implement.id} && echo ${marker}`,
    } }] };
  }
  return result('approve');
}

// Real Git completes the selected side effect, then kills only this test's
// controller before its SQLite transaction can commit. No product fault switches.
async function installGitCrash(sandbox, boundary) {
  if (!boundary) return;
  const bin = join(sandbox.root, 'bin');
  await mkdir(bin);
  const wrapper = join(bin, 'git');
  await writeFile(wrapper, `#!/bin/sh
/usr/bin/git "$@"
result=$?
if [ "$result" -eq 0 ] && [ ! -e "$DWF_TEST_GIT_CRASH" ]; then
  matched=no
  case "$DWF_TEST_GIT_BOUNDARY:$PWD:$1 $2 $3" in
    scratch-apply:*/verification/integration_*:"apply --3way --index") matched=yes ;;
    parent-*-reset:*/workflows/*/worktree:"read-tree --reset -u"|candidate-reset:*/verification/implement_beta:"read-tree --reset -u"|conflict-reset:*/verification/implement_beta:"read-tree --reset -u")
      case "$DWF_TEST_GIT_BOUNDARY" in
        parent-base-reset|candidate-reset) matched=yes ;;
        *) if [ -e "$DWF_TEST_GIT_CRASH.armed" ]; then matched=yes; else : > "$DWF_TEST_GIT_CRASH.armed"; fi ;;
      esac ;;
  esac
  if [ "$matched" = yes ]; then
    echo "$PPID" > "$DWF_TEST_GIT_CRASH"
    kill -KILL "$PPID"
  fi
fi
exit "$result"
`);
  await chmod(wrapper, 0o700);
  sandbox.env.PATH = bin + ':' + sandbox.env.PATH;
  sandbox.env.DWF_TEST_GIT_CRASH = join(sandbox.control, 'git-crash');
  sandbox.env.DWF_TEST_GIT_BOUNDARY = boundary;
}

test('one native workflow runs isolated full cycles in parallel, revises one session, waits for dependencies and checks integration', { timeout: 90000 }, async t => {
  const sandbox = await fixture(t, call => reply(call, true));
  await sandbox.release(await waitFor(async () => { const calls = await sandbox.calls(); return calls.length && calls; }, 15000, 'initial manager')); 
  let pair = await waitFor(async () => {
    const calls = (await sandbox.calls()).filter(call => stage(call.prompt, 'work'));
    if (sandbox.state().status !== 'running') throw new Error(sandbox.state().error);
    return calls.length === 2 && calls;
  }, 15000, 'two simultaneously held workers');
  for (const call of pair) {
    const data = taskContext(call.prompt);
    assert.equal(data.participant, `${data.implement.id}/worker`);
    assert.equal(data.task.id, data.implement.id);
    assert.equal(data.task.requirements, `Create ${data.implement.id}.txt`);
    assert(!call.prompt.includes('Implement execution context:'));
  }
  const inspect = await sandbox.command(['inspect', sandbox.runId]);
  assert.equal(inspect.implements.instances.length, 3);
  assert.equal(inspect.implements.instances[2].status, 'queued');
  assert.equal(inspect.implements.instances[2].waitingReason, 'dependencies');
  assert.deepEqual(inspect.implements.instances[2].waitingFor, ['alpha', 'beta']);
  assert.notEqual(inspect.implements.instances[0].workspace.path, inspect.implements.instances[1].workspace.path);
  await pause(700);
  assert.equal((await sandbox.calls()).filter(call => stage(call.prompt, 'manage')).length, 1, 'No model polling while workers are held');
  await sandbox.release(pair); // tools
  pair = await waitFor(async () => {
    const calls = (await sandbox.calls()).filter(call => stage(call.prompt, 'work'));
    return calls.length === 4 && calls.slice(2);
  }, 15000, 'both worker tool continuations');
  await sandbox.release(pair);
  pair = await waitFor(async () => {
    const calls = (await sandbox.calls()).filter(call => stage(call.prompt, 'review'));
    return calls.length === 2 && calls;
  }, 15000, 'two simultaneously held reviewers');
  await sandbox.release(pair);
  await waitFor(async () => (await sandbox.calls()).some(call => stage(call.prompt, 'verify')), 15000, 'beta verifier');
  await waitFor(async () => (await sandbox.calls()).filter(call => stage(call.prompt, 'manage')).length === 2, 15000, 'addressed alpha feedback');
  // Keep beta's verifier held while alpha traverses its corrected full cycle.
  // Do not release that manager request: the original cycle must continue itself.
  await waitFor(async () => (await sandbox.calls()).filter(call => stage(call.prompt, 'work')).length === 5, 15000, 'same-session alpha correction');
  await sandbox.release((await sandbox.calls()).filter(call => !stage(call.prompt, 'verify') && !stage(call.prompt, 'manage')));
  await waitFor(async () => (await sandbox.calls()).filter(call => stage(call.prompt, 'work')).length === 6, 15000, 'corrected worker continuation');
  await sandbox.release((await sandbox.calls()).filter(call => !stage(call.prompt, 'verify') && !stage(call.prompt, 'manage')));
  await waitFor(async () => (await sandbox.calls()).filter(call => stage(call.prompt, 'review')).length === 3, 15000, 'corrected alpha review');
  await sandbox.release((await sandbox.calls()).filter(call => !stage(call.prompt, 'verify') && !stage(call.prompt, 'manage')));
  const verifiers = await waitFor(async () => {
    const calls = (await sandbox.calls()).filter(call => stage(call.prompt, 'verify'));
    return calls.length === 2 && calls;
  }, 15000, 'two simultaneously held verifiers');
  assert.deepEqual(verifiers.map(call => context(call.prompt, 'Implement execution context').id).sort(), ['alpha', 'beta']);
  assert.equal(sandbox.state().visits.filter(visit => visit.node === 'manage' && visit.verdict).length, 1,
    'correction completes while the second manager input remains unanswered');
  assert.equal(sandbox.state().visits.filter(visit => visit.node === 'manage').length, 2);
  const beforeMerge = sandbox.state();
  const workers = beforeMerge.visits.filter(visit => visit.participant === 'alpha/worker');
  assert.equal(workers.length, 2);
  assert.equal(workers[0].sessionId, workers[1].sessionId);
  assert.notEqual(workers[0].inputId, workers[1].inputId);
  assert.equal(beforeMerge.implements.instances.gamma.status, 'queued');
  // Neither individual approval nor the manager can merge before the global checks.
  await assert.rejects(readFile(join(sandbox.workspace, 'alpha.txt')), { code: 'ENOENT' });
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  assert(Object.values(final.implements.instances).every(instance => instance.status === 'integrated'));
  for (const id of ['alpha', 'beta', 'gamma']) assert.equal(await readFile(join(sandbox.workspace, `${id}.txt`), 'utf8'), id);
  assert.equal(await readFile(join(sandbox.workspace, 'revision.txt'), 'utf8'), 'revised');
  const globalChecks = final.visits.filter(visit => ['integrationReview', 'integrationVerify'].includes(visit.node));
  assert.equal(globalChecks.length, 2);
  assert.equal(globalChecks[0].revision, globalChecks[1].revision);
  assert.notEqual(globalChecks[0].revision, final.implements.instances.alpha.candidateRevision);
  const gammaWorker = final.visits.find(visit => visit.participant === 'gamma/worker');
  assert.equal(await readFile(join(gammaWorker.workspace.path, 'beta.txt'), 'utf8'), 'beta');
});

function expireLease(sandbox) {
  const db = new DatabaseSync(join(sandbox.stateRoot, 'dwf.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(sandbox.runId);
  } finally { db.close(); }
}
function controllerOf(sandbox) {
  return taggedProcesses(sandbox.token).find(item =>
    execFileSync('ps', ['-p', String(item.pid), '-o', 'command='], { encoding: 'utf8' }).includes('workflow-runtime.mjs'));
}
async function initialWorkers(sandbox) {
  await sandbox.release(await waitFor(async () => { const calls = await sandbox.calls(); return calls.length && calls; }, 15000, 'initial manager'));
  return waitFor(async () => {
    const calls = (await sandbox.calls()).filter(call => stage(call.prompt, 'work'));
    return calls.length === 2 && calls;
  }, 15000, 'both native workers');
}

test('live takeover preserves ready, active and dependent instances, session/input identity and addressed steering', { timeout: 90000 }, async t => {
  const sandbox = await fixture(t, reply);
  await initialWorkers(sandbox);
  await waitFor(async () => {
    await sandbox.release((await sandbox.calls()).filter(call => Boolean(taskContext(call.prompt).implement) &&
      context(call.prompt, 'Implement execution context').id === 'alpha'));
    return sandbox.state().implements.instances.alpha.status === 'ready';
  }, 20000, 'alpha ready with beta still active');
  await waitFor(async () => (await sandbox.calls()).filter(call => stage(call.prompt, 'manage')).length === 2, 10000, 'held manager sees alpha result');
  const before = sandbox.state();
  assert.equal(before.implements.instances.beta.status, 'running');
  assert.equal(before.implements.instances.gamma.status, 'queued');
  const inputs = before.visits.filter(visit => visit.implementId).map(visit => [visit.inputId, visit.sessionId]);
  const oldController = controllerOf(sandbox);
  assert(oldController);
  expireLease(sandbox); // Do not kill the old owner: prove exclusion on takeover.
  const inspected = await sandbox.command(['inspect', sandbox.runId]);
  assert.equal(inspected.status, 'running');
  await waitFor(() => !taggedProcesses(sandbox.token).some(item => item.pid === oldController.pid), 10000, 'old controller relinquishes ownership');
  assert.deepEqual(sandbox.state().visits.filter(visit => visit.implementId).map(visit => [visit.inputId, visit.sessionId]), inputs);
  const count = (await sandbox.calls()).length;
  await pause(700);
  assert.equal((await sandbox.calls()).length, count, 'takeover does not resend a native model input');
  const message = join(sandbox.root, 'steering.txt');
  await writeFile(message, 'Correct beta and add revision.txt');
  await sandbox.command(['steer', sandbox.runId, 'beta', '--message-file', message]);
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  const betaWorkers = final.visits.filter(visit => visit.participant === 'beta/worker');
  assert.equal(betaWorkers.length, 2);
  assert.equal(betaWorkers[0].sessionId, betaWorkers[1].sessionId);
  assert.deepEqual(betaWorkers.map(visit => visit.taskVersion), [1, 2]);
  assert.equal(betaWorkers[1].taskContext.assignment.steering.text, 'Correct beta and add revision.txt');
  assert.equal(betaWorkers[1].taskContext.assignment.implement.controllerInputId, undefined);
  assert.equal(final.controls[0].status, 'applied');
  assert.equal(final.taskRevisions[0].taskId, 'beta');
  assert.equal(await readFile(join(sandbox.workspace, 'revision.txt'), 'utf8'), 'revised');
  const received = await sandbox.calls();
  assert.equal(received.filter(call => stage(call.prompt, 'work') && context(call.prompt, 'Implement execution context').id === 'alpha').length, 2);
});

test('crash after native admission replays saved implement operations without duplicate model inputs', { timeout: 90000 }, async t => {
  const sandbox = await fixture(t, reply, implementDefinition(), { fault: { boundary: 'accepted', index: 2 } });
  await sandbox.release(await waitFor(async () => { const calls = await sandbox.calls(); return calls.length && calls; }, 15000, 'initial manager'));
  await waitFor(() => readFile(sandbox.fault.marker).catch(() => false), 15000, 'accepted implement admission crash');
  const before = sandbox.state();
  const frozen = before.visits.filter(visit => visit.implementId);
  assert.equal(frozen.length, 2);
  assert(frozen.every(visit => visit.admissionStarted));
  expireLease(sandbox);
  await sandbox.command(['inspect', sandbox.runId]);
  await waitFor(async () => (await sandbox.calls()).filter(call => stage(call.prompt, 'work')).length === 2, 15000, 'both original worker inputs observed after restart');
  await pause(700);
  assert.equal((await sandbox.calls()).filter(call => stage(call.prompt, 'work')).length, 2);
  const retried = await transcript(sandbox.fault.calls);
  for (const visit of frozen) {
    const attempts = retried.filter(attempt => attempt.inputId === visit.inputId);
    assert(attempts.length >= 1);
    for (const attempt of attempts) {
      assert.equal(attempt.sessionId, visit.sessionId);
      assert.equal(attempt.request.text, visit.prompt);
      assert.deepEqual(taskContext(attempt.request.text), visit.taskContext);
      assert.equal(taskContext(attempt.request.text).inputId, visit.inputId);
      assert.equal(attempt.request.session.metadata.dwfImplementId, visit.implementId);
      assert.equal(attempt.request.session.metadata.dwfTaskId, visit.taskId);
      assert.equal(attempt.request.session.metadata.dwfParticipant, visit.participant);
    }
  }
  assert(retried.filter(attempt => attempt.inputId === frozen[0].inputId).length >= 2, 'native acknowledgement is genuinely retried');
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  assert.equal(final.visits.filter(visit => visit.participant === 'alpha/worker').length, 1);
  for (const id of ['alpha', 'beta', 'gamma']) {
    assert.equal((await sandbox.calls()).filter(call => stage(call.prompt, 'work') && context(call.prompt, 'Implement execution context').id === id).length, 2);
  }
});

test('stop confirms both resistant implement shells and their children have actually stopped', { timeout: 60000 }, async t => {
  let sandbox;
  sandbox = await fixture(t, call => {
    if (stage(call.prompt, 'work')) {
      const { id } = context(call.prompt, 'Implement execution context');
      return { toolCalls: [{ name: 'shell', arguments: { background: true,
        command: `trap '' TERM; echo $$ > '${sandbox.root}/${id}.pid'; sh -c 'trap "" TERM; echo $$ > "${sandbox.root}/${id}.child.pid"; while :; do sleep 1; done' & while :; do echo tick >> '${sandbox.root}/${id}.heartbeat'; sleep 0.05; done`,
      } }] };
    }
    return reply(call);
  });
  await sandbox.release(await initialWorkers(sandbox));
  const pids = await waitFor(async () => {
    const ids = await Promise.all(['alpha', 'beta', 'alpha.child', 'beta.child'].map(id => readFile(join(sandbox.root, `${id}.pid`), 'utf8').then(Number).catch(() => false)));
    return ids.every(Boolean) && ids;
  }, 15000, 'both real native shell PIDs');
  for (const pid of pids) process.kill(pid, 0);
  const stopped = await sandbox.command(['stop', sandbox.runId]);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(sandbox.state().status, 'cancelled');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const heartbeat = await Promise.all(['alpha', 'beta'].map(id => readFile(join(sandbox.root, `${id}.heartbeat`), 'utf8')));
  await pause(300);
  assert.deepEqual(await Promise.all(['alpha', 'beta'].map(id => readFile(join(sandbox.root, `${id}.heartbeat`), 'utf8'))), heartbeat);
  assert.equal(stopped.implements.instances[2].status, 'queued');
  assert(stopped.implements.instances.every(instance => instance.executionStatus === 'cancelled'));
  await assert.rejects(readFile(join(sandbox.workspace, 'alpha.txt')), { code: 'ENOENT' });
});

for (const boundary of [undefined, 'candidate-reset', 'conflict-reset']) {
  test(`native conflict preserves late edits and resolves in the same session${boundary ? ' after crash at ' + boundary : ''}`, { timeout: 90000 }, async t => {
    const sandbox = await fixture(t, call => {
      const { prompt, toolResults } = call;
      if (stage(prompt, 'manage')) {
        const { instances } = context(prompt, 'Implement control context');
        const byId = Object.fromEntries(instances.map(instance => [instance.id, instance]));
        if (byId.beta.status === 'conflict') return result('dispatch', 'Resolve the beta integration conflict', {
          implements: [{ action: 'revise', id: 'beta', assignment: 'Resolve shared.txt to alpha and beta; keep beta.txt' }],
        });
        if (instances.some(instance => instance.status === 'pending') || instances.every(instance => instance.status === 'integrated')) return reply(call);
        const id = byId.alpha.status === 'ready' ? 'alpha' : byId.alpha.status === 'integrated' && byId.beta.status === 'ready' ? 'beta' :
          byId.beta.status === 'integrated' && byId.gamma.status === 'ready' ? 'gamma' : undefined;
        return result('dispatch', 'Integrate in dependency order', { implements: id ? [{ action: 'integrate', id }] : [] });
      }
      if (stage(prompt, 'work')) {
        const { id, assignment, conflict } = context(prompt, 'Implement execution context');
        if (id !== 'gamma') {
          const resolution = assignment.includes('Resolve shared.txt');
          const marker = resolution ? 'conflict-resolved' : `conflict-written-${id}`;
          if (!toolResults.some(text => text.includes(marker))) return { toolCalls: [{ name: 'shell', arguments: {
            command: `set -e; ${resolution ? `cat '${conflict.candidateWorkspace.path}/shared.txt' > preserved.txt; cat '${conflict.resolution.candidateWorkspace.path}/shared.txt' > late-preserved.txt; cp '${conflict.resolution.candidateWorkspace.path}/late.bin' restored.bin; ` : ''}printf ${id} > ${id}.txt; printf '${resolution ? 'alpha and beta' : id}' > shared.txt; echo ${marker}`,
          } }] };
          return result('done', resolution ? 'Resolved shared.txt and preserved beta.txt' : `Created ${id}.txt and changed shared.txt`);
        }
      }
      if (stage(prompt, 'integrationVerify') && !toolResults.some(text => text.includes('combined-ok'))) return { toolCalls: [{ name: 'shell', arguments: {
        command: 'test "$(cat shared.txt)" = "alpha and beta" && test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta && test "$(cat gamma.txt)" = gamma && echo combined-ok',
      } }] };
      return reply(call);
    }, implementDefinition(), { beforeStart: sandbox => installGitCrash(sandbox, boundary) });
    await initialWorkers(sandbox);
    const conflictCall = await waitFor(async () => {
      const calls = await sandbox.calls();
      const conflict = calls.find(call => stage(call.prompt, 'manage') && context(call.prompt, 'Implement control context').instances.some(instance => instance.status === 'conflict'));
      if (conflict) return conflict;
      await sandbox.release(calls);
      return false;
    }, 25000, 'manager receives actual beta conflict');
    const before = sandbox.state();
    const alpha = before.implements.instances.alpha;
    const beta = before.implements.instances.beta;
    assert.equal(alpha.status, 'integrated');
    assert.equal(beta.status, 'conflict');
    assert.equal(await readFile(join(before.workspace.path, 'shared.txt'), 'utf8'), 'alpha');
    assert.equal(await readFile(join(beta.workspace.path, 'shared.txt'), 'utf8'), 'beta');
    assert.equal(await readFile(join(beta.integration.candidateWorkspace.path, 'shared.txt'), 'utf8'), 'beta');
    assert.match(await readFile(join(beta.integration.workspace.path, 'shared.txt'), 'utf8'), /<<<<<<<[\s\S]*alpha[\s\S]*beta/);
    assert.deepEqual(beta.integration.conflicts, ['shared.txt']);
    assert((await readFile(beta.integration.patch.path, 'utf8')).includes('shared.txt'));
    await assert.rejects(readFile(join(sandbox.workspace, 'alpha.txt')), { code: 'ENOENT' });
    await writeFile(join(beta.workspace.path, 'shared.txt'), 'late beta edit');
    await writeFile(join(beta.workspace.path, 'late.bin'), Buffer.from([0, 1, 255]));
    await sandbox.release([conflictCall]);
    if (boundary) {
      const marker = join(sandbox.control, 'git-crash');
      const pid = await waitFor(() => readFile(marker, 'utf8').then(Number).catch(() => false), 15000, 'crash during conflict replacement');
      await waitFor(() => !taggedProcesses(sandbox.token).some(item => item.pid === pid), 5000, 'crashed controller exits');
      const interrupted = sandbox.state();
      const intent = interrupted.implements.instances.beta.integration.resolution;
      assert.equal(intent.status, 'prepared', 'replacement intent survives SQLite rollback');
      assert.equal(interrupted.implements.instances.beta.status, 'queued');
      assert.equal(await readFile(join(intent.candidateWorkspace.path, 'shared.txt'), 'utf8'), 'late beta edit');
      assert.deepEqual(await readFile(join(intent.candidateWorkspace.path, 'late.bin')), Buffer.from([0, 1, 255]));
      expireLease(sandbox);
      await sandbox.command(['inspect', sandbox.runId]);
    }
    await sandbox.releaseAll();
    const final = await sandbox.finish();
    assert.equal(final.status, 'succeeded', final.error);
    assert.equal(await readFile(join(sandbox.workspace, 'shared.txt'), 'utf8'), 'alpha and beta');
    assert.equal(final.implements.instances.beta.conflictHistory.length, 1);
    assert.equal(await readFile(join(sandbox.workspace, 'preserved.txt'), 'utf8'), 'beta');
    assert.equal(await readFile(join(sandbox.workspace, 'late-preserved.txt'), 'utf8'), 'late beta edit');
    assert.deepEqual(await readFile(join(sandbox.workspace, 'restored.bin')), Buffer.from([0, 1, 255]));
    const betaWorkers = final.visits.filter(visit => visit.participant === 'beta/worker');
    assert.equal(betaWorkers.length, 2);
    assert.equal(betaWorkers[0].sessionId, betaWorkers[1].sessionId);
    assert.equal(final.implements.instances.alpha.candidateRevision, alpha.candidateRevision, 'neighbour conflict does not invalidate alpha approvals');
    assert.equal(final.visits.filter(visit => visit.participant === 'alpha/reviewer').length, 1);
  });
}

for (const boundary of ['scratch-apply', 'parent-base-reset', 'parent-result-reset']) {
  test(`integration operation recovers a controller crash at ${boundary}`, { timeout: 90000 }, async t => {
    const sandbox = await fixture(t, reply, implementDefinition(), { beforeStart: sandbox => installGitCrash(sandbox, boundary) });
    const marker = join(sandbox.control, 'git-crash');
    await sandbox.releaseAll();
    const pid = await waitFor(() => readFile(marker, 'utf8').then(Number).catch(() => false), 25000, 'crash after selected real Git side effect');
    await waitFor(() => !taggedProcesses(sandbox.token).some(item => item.pid === pid), 5000, 'crashed controller exits');
    const interrupted = sandbox.state();
    assert.equal(interrupted.status, 'running');
    const operation = Object.values(interrupted.implements.instances).find(instance => instance.status === 'integrating').integration;
    assert(operation.baseRevision, 'the expected parent was durably saved before Git mutation');
    assert(operation.id);
    assert.equal(operation.resultRevision, undefined, 'Git side effect was not committed to SQLite');
    assert.equal(await readFile(join(operation.workspace.path, 'alpha.txt'), 'utf8'), 'alpha');
    if (boundary === 'parent-result-reset') {
      assert.equal(await readFile(join(interrupted.workspace.path, 'alpha.txt'), 'utf8'), 'alpha');
    } else {
      await assert.rejects(readFile(join(interrupted.workspace.path, 'alpha.txt')), { code: 'ENOENT' });
    }
    await assert.rejects(readFile(join(sandbox.workspace, 'alpha.txt')), { code: 'ENOENT' });
    expireLease(sandbox);
    await sandbox.command(['inspect', sandbox.runId]);
    const final = await sandbox.finish();
    assert.equal(final.status, 'succeeded', final.error);
    assert(Object.values(final.implements.instances).every(instance => instance.status === 'integrated'));
    assert(!final.implements.events.some(event => event.type === 'conflict' || event.type === 'invalidated'));
    for (const id of ['alpha', 'beta', 'gamma']) assert.equal(final.visits.filter(visit => visit.participant === `${id}/worker`).length, 1);
  });
}

test('stop after uncertain native implement admission cancels original sessions without restarting work', { timeout: 60000 }, async t => {
  const sandbox = await fixture(t, reply, implementDefinition(), { fault: { boundary: 'accepted', index: 2 } });
  await sandbox.release(await waitFor(async () => { const calls = await sandbox.calls(); return calls.length && calls; }, 15000, 'initial manager'));
  await waitFor(() => readFile(sandbox.fault.marker).catch(() => false), 15000, 'uncertain admitted worker');
  expireLease(sandbox);
  const stopped = await sandbox.command(['stop', sandbox.runId]);
  assert.equal(stopped.status, 'cancelled');
  const count = (await sandbox.calls()).length;
  await pause(500);
  assert.equal((await sandbox.calls()).length, count);
  assert.equal((await sandbox.command(['inspect', sandbox.runId])).status, 'cancelled');
  assert.equal(sandbox.state().controls[0].status, 'applied');
  assert(Object.values(sandbox.state().implements.instances).every(instance => instance.status !== 'integrated'));
});

test('an idle manager wakes only for a user action or a real implement question and returns the answer to that worker', { timeout: 90000 }, async t => {
  let initial = true;
  let observedQuestion = false;
  const sandbox = await fixture(t, call => {
    if (stage(call.prompt, 'manage')) {
      if (initial) { initial = false; return result('dispatch', 'Wait for the user before admitting tasks', { implements: [] }); }
      const control = context(call.prompt, 'Implement control context');
      if (control.instances.some(instance => instance.id === 'alpha' && instance.status === 'blocked')) {
        observedQuestion = control.events.some(event => event.type === 'blocked' && event.result.summary === 'Confirm the alpha filename from the package');
        return result('dispatch', 'Use the already specified alpha.txt filename', { implements: [{ action: 'revise', id: 'alpha',
          assignment: 'Question answered: use alpha.txt as specified in the package' }] });
      }
    }
    if (stage(call.prompt, 'work')) {
      const implement = context(call.prompt, 'Implement execution context');
      if (implement.id === 'alpha' && !implement.assignment.includes('Question answered')) return result('blocked', 'Confirm the alpha filename from the package');
    }
    return reply(call);
  });
  await sandbox.release(await waitFor(async () => { const calls = await sandbox.calls(); return calls.length && calls; }, 15000, 'initial manager'));
  await waitFor(() => sandbox.state().visits.some(visit => visit.kind === 'implements'), 10000, 'idle event wait');
  await pause(700);
  assert.equal((await sandbox.calls()).length, 1);
  assert(Object.values(sandbox.state().implements.instances).every(instance => instance.status === 'pending'));
  const message = join(sandbox.root, 'start-now.txt');
  await writeFile(message, 'Start the ready tasks now');
  await sandbox.command(['steer', sandbox.runId, 'manage', '--message-file', message]);
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  assert(observedQuestion);
  const alpha = final.visits.filter(visit => visit.participant === 'alpha/worker');
  assert.equal(alpha.length, 2);
  assert.equal(alpha[0].verdict.outcome, 'blocked');
  assert.equal(alpha[0].sessionId, alpha[1].sessionId);
  assert.equal(final.controls[0].status, 'applied');
});

test('combined verifier feedback returns to an integrated worker, refreshes dependent candidates and requires new combined checks', { timeout: 90000 }, async t => {
  let requestedFix = false;
  let combinedChecks = 0;
  const sandbox = await fixture(t, call => {
    const { prompt, toolResults } = call;
    if (stage(prompt, 'manage')) {
      const control = context(prompt, 'Implement control context');
      const alpha = control.instances.find(instance => instance.id === 'alpha');
      const gamma = control.instances.find(instance => instance.id === 'gamma');
      if (requestedFix && alpha.resultVersion === 1 && alpha.status === 'integrated') return result('dispatch', 'Correct alpha and recheck its dependent gamma', { implements: [
        { action: 'revise', id: 'alpha', assignment: 'Fix integration issue; add post-integration.txt' },
        { action: 'revise', id: 'gamma', assignment: 'Recheck dependency update' },
      ] });
      assert(!requestedFix || gamma.status !== 'running' || alpha.status === 'integrated', 'dependent gamma must wait for corrected alpha');
    }
    if (stage(prompt, 'work')) {
      const implement = context(prompt, 'Implement execution context');
      if (implement.assignment.includes('post-integration.txt') || implement.assignment.includes('Recheck dependency update')) {
        const marker = `reworked-${implement.id}`;
        if (!toolResults.some(text => text.includes(marker))) return { toolCalls: [{ name: 'shell', arguments: {
          command: implement.id === 'alpha' ? `printf fixed > post-integration.txt; echo ${marker}` :
            `test "$(cat post-integration.txt)" = fixed && test "$(cat gamma.txt)" = gamma && echo ${marker}`,
        } }] };
        return result('done', `Reworked ${implement.id} after integration feedback`);
      }
    }
    if (stage(prompt, 'integrationVerify')) {
      if (!requestedFix) {
        requestedFix = true;
        combinedChecks++;
        return result('changes', 'Alpha must add post-integration.txt; gamma must be checked against that corrected dependency');
      }
      if (!toolResults.some(text => text.includes('fixed-combined-ok'))) return { toolCalls: [{ name: 'shell', arguments: {
        command: 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta && test "$(cat gamma.txt)" = gamma && test "$(cat post-integration.txt)" = fixed && echo fixed-combined-ok',
      } }] };
      combinedChecks++;
      return result('approve', 'DWF feat: verify corrected implement integration\n\nChecked corrected alpha, dependent gamma and combined files.');
    }
    return reply(call);
  });
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  assert.equal(combinedChecks, 2);
  assert.equal(final.implements.instances.alpha.resultVersion, 2);
  assert.equal(final.implements.instances.gamma.resultVersion, 2);
  assert.equal(final.implements.instances.beta.resultVersion, 1);
  for (const id of ['alpha', 'gamma']) {
    const visits = final.visits.filter(visit => visit.participant === `${id}/worker`);
    assert.equal(visits.length, 2);
    assert.equal(visits[0].sessionId, visits[1].sessionId);
  }
  const checks = final.visits.filter(visit => visit.node === 'integrationVerify');
  assert.equal(checks.length, 2);
  assert.equal(checks[0].verdict.outcome, 'changes');
  assert.notEqual(checks[0].revision, checks[1].revision);
  assert.equal(await readFile(join(sandbox.workspace, 'post-integration.txt'), 'utf8'), 'fixed');
});

test('a manager decision made obsolete by scoped steering is rejected as an event without killing independent cycles', { timeout: 90000 }, async t => {
  const sandbox = await fixture(t, reply);
  await initialWorkers(sandbox);
  await waitFor(async () => {
    await sandbox.release((await sandbox.calls()).filter(call => Boolean(taskContext(call.prompt).implement) &&
      context(call.prompt, 'Implement execution context').id === 'alpha'));
    return sandbox.state().implements.instances.alpha.status === 'ready';
  }, 20000, 'alpha ready');
  const manager = await waitFor(async () => {
    const calls = (await sandbox.calls()).filter(call => stage(call.prompt, 'manage'));
    return calls.length === 2 && calls[1];
  }, 10000, 'held manager with now-obsolete ready snapshot');
  const message = join(sandbox.root, 'late-correction.txt');
  await writeFile(message, 'Correct alpha and add revision.txt');
  await sandbox.command(['steer', sandbox.runId, 'alpha', '--message-file', message]);
  await waitFor(() => sandbox.state().implements.instances.alpha.status === 'running', 10000, 'addressed correction starts before old manager answer');
  await sandbox.release([manager]);
  await waitFor(() => sandbox.state().implements.events.some(event => event.type === 'decision_rejected'), 10000, 'obsolete integration rejected as new evidence');
  assert.equal(sandbox.state().status, 'running');
  assert.equal(sandbox.state().implements.instances.beta.status, 'running');
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  assert.equal(await readFile(join(sandbox.workspace, 'revision.txt'), 'utf8'), 'revised');
});

test('a failed manager cannot bypass integration gates or leave concurrent native shells running', { timeout: 60000 }, async t => {
  let sandbox;
  sandbox = await fixture(t, call => {
    if (stage(call.prompt, 'manage')) {
      const control = context(call.prompt, 'Implement control context');
      if (control.instances.some(instance => instance.status === 'ready')) return result('done', 'Attempt an early finish without combined checks');
    }
    if (stage(call.prompt, 'work') && context(call.prompt, 'Implement execution context').id === 'beta') return call.toolResults.length ? result('done', 'Await background completion') : { toolCalls: [{ name: 'shell', arguments: {
      background: true, command: `trap '' TERM; echo $$ > '${sandbox.root}/failed-manager.pid'; while :; do echo tick >> '${sandbox.root}/failed-manager.heartbeat'; sleep 0.05; done`,
    } }] };
    return reply(call);
  });
  const workers = await initialWorkers(sandbox);
  await sandbox.release(workers.filter(call => context(call.prompt, 'Implement execution context').id === 'beta'));
  const pid = await waitFor(() => readFile(join(sandbox.root, 'failed-manager.pid'), 'utf8').then(Number).catch(() => false), 10000, 'real concurrent resistant shell');
  process.kill(pid, 0);
  await waitFor(async () => {
    await sandbox.release((await sandbox.calls()).filter(call => Boolean(taskContext(call.prompt).implement) &&
      context(call.prompt, 'Implement execution context').id === 'alpha'));
    return sandbox.state().implements.instances.alpha.status === 'ready';
  }, 20000, 'alpha ready before rejected early finish');
  await sandbox.release((await sandbox.calls()).filter(call => stage(call.prompt, 'manage')));
  // The actual manager request may be sent just after the state change.
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'failed');
  assert.match(final.error, /implement/);
  assert.equal(final.executionStopped, true);
  assert.equal(final.pendingFailure, undefined);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const heartbeat = await readFile(join(sandbox.root, 'failed-manager.heartbeat'), 'utf8');
  await pause(300);
  assert.equal(await readFile(join(sandbox.root, 'failed-manager.heartbeat'), 'utf8'), heartbeat);
  assert.equal((await sandbox.command(['inspect', sandbox.runId])).implements.instances[1].executionStatus, 'stopped');
  await assert.rejects(readFile(join(sandbox.workspace, 'alpha.txt')), { code: 'ENOENT' });
});

test('implement participants read pinned context links, retain scoped findings and use structured UI data across reentry', { timeout: 90000 }, async t => {
  const definition = implementDefinition();
  definition.roles.worker.tools = ['shell', 'read'];
  definition.roles.reviewer.tools = ['read'];
  definition.nodes.verify.tools = ['shell', 'read'];
  const reads = new Map();
  const sandbox = await fixture(t, call => {
    const data = taskContext(call.prompt);
    if (data.implement) {
      assert.equal(data.task.id, data.implement.id);
      assert.equal(data.sources.task.access, 'read');
      assert.equal(data.participant, `${data.implement.id}/${data.role}`);
      assert(call.tools.some(tool => tool.function?.name === 'read'));
      if (data.role === 'reviewer') assert(!call.tools.some(tool => tool.function?.name === 'shell'));
      if (!reads.has(data.inputId)) {
        reads.set(data.inputId, call.toolResults.length);
        return { toolCalls: [{ name: 'read', arguments: { path: data.sources.task.path } }] };
      }
      assert(call.toolResults.slice(reads.get(data.inputId)).some(text => text.includes(data.task.requirements)),
        'Native read must return the exact pinned implement requirement');
    }
    return reply(call, true);
  }, definition);
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  const alphaWorkers = final.visits.filter(v => v.participant === 'alpha/worker');
  assert.equal(alphaWorkers.length, 2);
  assert.equal(alphaWorkers[0].sessionId, alphaWorkers[1].sessionId);
  assert.equal(alphaWorkers[0].delivery.mode, 'snapshot');
  assert.equal(alphaWorkers[1].delivery.mode, 'delta');
  assert.equal(alphaWorkers[1].delivery.baseInputId, alphaWorkers[0].inputId);
  assert.equal(alphaWorkers[1].delivery.acknowledged, true);
  assert.equal(wireContext(alphaWorkers[1].prompt).delivery.mode, 'delta');
  assert(!alphaWorkers[1].prompt.includes('Create alpha.txt'));
  assert(alphaWorkers[1].prompt.includes('Add revision.txt'));
  const corrected = alphaWorkers[1].taskContext;
  assert.equal(corrected.otherReports.handoff.summary, 'Add revision.txt');
  assert.equal(corrected.otherReports.handoffSource.participant, 'alpha/reviewer');
  assert.equal(corrected.otherReports.handoffSource.inputId, final.visits.find(v => v.participant === 'alpha/reviewer').inputId);
  assert.equal(final.visits.filter(v => v.implementId).length, reads.size);
  const { workflowView } = await import('../ui-data.mjs');
  const view = workflowView(final, { root: sandbox.stateRoot });
  const worker = view.graph.nodes.find(node => node.id === 'implements').participants.find(p => p.id === 'alpha/worker');
  assert.equal(worker.invocations[1].taskSource, 'structured');
  assert.deepEqual(worker.invocations[1].taskData, corrected);
  assert.equal(worker.invocations[1].contextDelivery.baseInputId, alphaWorkers[0].inputId);
  assert.equal(worker.invocations[1].contextDelivery.acknowledged, true);
  assert.equal(worker.invocations[1].promptRaw, alphaWorkers[1].prompt);
});

test('restart admits saved prepared implement contexts unchanged instead of rebuilding them from interleaved visits', { timeout: 90000 }, async t => {
  const sandbox = await fixture(t, reply);
  await initialWorkers(sandbox);
  const { randomUUID } = await import('node:crypto');
  const { createWorkflow } = await import('../run-store.mjs');
  const { prepareWorkspace, snapshot } = await import('../workflow-git.mjs');
  const { initializeImplements, applyImplementDecision, advanceImplementState } = await import('../workflow-implements.mjs');
  const state = { ...sandbox.state(), id: randomUUID(), status: 'running', sessions: {}, visits: [], controls: [], taskRevisions: [] };
  delete state.implements;
  state.workspace = prepareWorkspace(sandbox.stateRoot, sandbox.workspace, state.id);
  initializeImplements(state);
  const manager = { node: 'manage', participant: 'manage', inputId: 'msg_' + randomUUID(), revision: snapshot(state.workspace),
    verdict: { outcome: 'dispatch', summary: 'Saved explicit assignments', implements: ['alpha', 'beta', 'gamma'].map(id =>
      ({ action: 'admit', id, assignment: `Create ${id}.txt with ${id}` })) } };
  state.visits.push(manager);
  applyImplementDecision(state, manager);
  advanceImplementState(sandbox.stateRoot, state);
  const prepared = structuredClone(state.visits.filter(v => v.implementId));
  assert.equal(prepared.length, 2);
  assert(prepared.every(v => v.admissionStarted === false && v.taskContext));
  createWorkflow(sandbox.stateRoot, state);
  await sandbox.command(['stop', sandbox.runId]);
  await sandbox.command(['inspect', state.id]);
  const requests = await waitFor(async () => {
    const calls = (await sandbox.calls()).filter(call => prepared.some(v => taskContext(call.prompt).inputId === v.inputId));
    return calls.length === 2 && calls;
  }, 15000, 'original prepared implement inputs admitted after restart');
  for (const visit of prepared) {
    const call = requests.find(call => taskContext(call.prompt).inputId === visit.inputId);
    assert.equal(call.prompt, visit.prompt);
    assert.deepEqual(taskContext(call.prompt), visit.taskContext);
    const restored = getWorkflow(sandbox.stateRoot, state.id).visits.find(v => v.inputId === visit.inputId);
    assert.equal(restored.sessionId, visit.sessionId);
    assert.deepEqual(restored.taskContext, visit.taskContext);
  }
  await sandbox.releaseAll();
  const final = await waitFor(() => { const saved = getWorkflow(sandbox.stateRoot, state.id); return saved.status !== 'running' && saved; },
    40000, 'prepared implement workflow completes');
  assert.equal(final.status, 'succeeded', final.error);
  for (const visit of prepared) {
    assert.equal((await sandbox.calls()).filter(call => taskContext(call.prompt).inputId === visit.inputId).length, 2,
      'one tool continuation, not a duplicate input');
  }
});

for (const replacement of ['refresh', 'conflict']) {
  test(`native mixed integrate and ${replacement} revision recovers replacement crash without losing independent work`, { timeout: 90000 }, async t => {
    const definition = implementDefinition();
    definition.taskPackages.find(task => task.id === 'gamma').dependencies = [];
    const combined = instances => {
      const { alpha, beta, gamma } = Object.fromEntries(instances.map(instance => [instance.id, instance]));
      return !beta.assignment?.includes('Correct beta in combined decision') &&
        (replacement === 'refresh' ? beta.status === 'integrated' && gamma.status === 'integrated' && alpha.status === 'ready' : beta.status === 'conflict' && gamma.status === 'ready');
    };
    const sandbox = await fixture(t, call => {
      const { prompt, toolResults } = call;
      if (stage(prompt, 'manage')) {
        const { instances } = context(prompt, 'Implement control context');
        const { alpha, beta, gamma } = Object.fromEntries(instances.map(instance => [instance.id, instance]));
        if (instances.some(instance => instance.status === 'pending') || instances.every(instance => instance.status === 'integrated')) return reply(call);
        if (combined(instances)) return result('dispatch', 'Integrate independent work and correct beta together', { implements: [
          { action: 'integrate', id: replacement === 'refresh' ? 'alpha' : 'gamma' },
          { action: 'revise', id: 'beta', assignment: 'Correct beta in combined decision; preserve late.bin' },
        ] });
        const ids = beta.assignment.includes('Correct beta in combined decision') ? instances.filter(instance => instance.status === 'ready').map(instance => instance.id) :
          replacement === 'refresh' ? beta.status === 'ready' ? ['beta'] : beta.status === 'integrated' && gamma.status === 'ready' ? ['gamma'] : [] : alpha.status === 'ready' && beta.status === 'ready' ? ['alpha', 'beta'] : [];
        return result('dispatch', 'Wait for actual readiness or integrate initial beta result', { implements: ids.map(id => ({ action: 'integrate', id })) });
      }
      if (stage(prompt, 'work')) {
        const { id, cycle, assignment, conflict } = context(prompt, 'Implement execution context');
        const corrected = assignment.includes('Correct beta in combined decision');
        const marker = `mixed-written-${id}-${cycle}`;
        if (!toolResults.some(text => text.includes(marker))) return { toolCalls: [{ name: 'shell', arguments: {
          command: `set -e; printf ${id} > ${id}.txt; ` +
            (replacement === 'conflict' && id !== 'gamma' ? `printf '${corrected ? 'alpha and beta' : id}' > shared.txt; ` : '') +
            (corrected ? (replacement === 'conflict' ? `cp '${conflict.resolution.candidateWorkspace.path}/late.bin' late.bin; ` : '') + 'test -f late.bin; ' : '') +
            `echo ${marker}`,
        } }] };
        return result('done', `Created ${id}.txt and preserved correction artifacts`);
      }
      if (stage(prompt, 'integrationVerify') && !toolResults.some(text => text.includes('combined-ok'))) return { toolCalls: [{ name: 'shell', arguments: {
        command: 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta && test "$(cat gamma.txt)" = gamma && test -f late.bin' +
          (replacement === 'conflict' ? ' && test "$(cat shared.txt)" = "alpha and beta"' : '') + ' && echo combined-ok',
      } }] };
      return reply(call);
    }, definition, { beforeStart: sandbox => installGitCrash(sandbox, 'candidate-reset') });
    const mixedCall = await waitFor(async () => {
      const calls = await sandbox.calls();
      const mixed = calls.find(call => stage(call.prompt, 'manage') && combined(context(call.prompt, 'Implement control context').instances));
      if (mixed) return mixed;
      await sandbox.release(calls);
      return false;
    }, 30000, 'manager can issue independent integration and addressed revision together');
    const before = sandbox.state();
    const independentId = replacement === 'refresh' ? 'alpha' : 'gamma';
    const independentRevision = before.implements.instances[independentId].candidateRevision;
    const commonRevision = (await import('../workflow-git.mjs')).snapshot(before.workspace);
    await writeFile(join(before.implements.instances.beta.workspace.path, 'late.bin'), Buffer.from([0, 255, 2]));
    await sandbox.release([mixedCall]);
    const pid = await waitFor(() => readFile(join(sandbox.control, 'git-crash'), 'utf8').then(Number).catch(() => false), 15000, 'crash inside replacement with independent integration pending');
    await waitFor(() => !taggedProcesses(sandbox.token).some(item => item.pid === pid), 5000, 'crashed controller exits');
    const interrupted = sandbox.state();
    assert.equal(interrupted.status, 'running');
    assert.equal((await import('../workflow-git.mjs')).snapshot(interrupted.workspace), commonRevision);
    assert.equal(interrupted.implements.instances[independentId].status, 'integrating');
    const intent = replacement === 'refresh' ? interrupted.implements.instances.beta.refresh : interrupted.implements.instances.beta.integration.resolution;
    assert.equal(intent.status, 'prepared');
    expireLease(sandbox);
    await sandbox.command(['inspect', sandbox.runId]);
    await sandbox.releaseAll();
    const final = await sandbox.finish();
    assert.equal(final.status, 'succeeded', final.error);
    assert(Object.values(final.implements.instances).every(instance => instance.status === 'integrated'));
    assert.deepEqual(await readFile(join(sandbox.workspace, 'late.bin')), Buffer.from([0, 255, 2]));
    assert.equal(final.implements.instances[independentId].candidateRevision, independentRevision);
    assert.equal(final.visits.filter(v => v.participant === `${independentId}/reviewer`).length, 1);
    const betaWorkers = final.visits.filter(v => v.participant === 'beta/worker');
    assert.equal(betaWorkers.length, 2);
    assert.equal(betaWorkers[0].sessionId, betaWorkers[1].sessionId);
    for (const node of ['integrationReview', 'integrationVerify']) assert.equal(final.visits.filter(v => v.node === node && v.verdict?.outcome === 'approve').length, 1);
  });
}

test('native dependency refresh retires the old integration conflict and replays the new dependency tree before worker admission', { timeout: 90000 }, async t => {
  const definition = implementDefinition();
  definition.taskPackages.find(task => task.id === 'beta').dependencies = ['gamma'];
  definition.taskPackages.find(task => task.id === 'gamma').dependencies = [];
  const sandbox = await fixture(t, call => {
    const { prompt, toolResults } = call;
    if (stage(prompt, 'manage')) {
      const { instances } = context(prompt, 'Implement control context');
      const { alpha, beta, gamma } = Object.fromEntries(instances.map(instance => [instance.id, instance]));
      if (instances.some(instance => instance.status === 'pending') || instances.every(instance => instance.status === 'integrated')) return reply(call);
      if (beta.status === 'conflict' && gamma.resultVersion === 1) return result('dispatch', 'Update gamma and resolve beta on its new version', { implements: [
        { action: 'revise', id: 'gamma', assignment: 'Update gamma.txt to gamma-v2' },
        { action: 'revise', id: 'beta', assignment: 'Resolve shared.txt after gamma-v2; preserve late.bin' },
      ] });
      const ids = gamma.status === 'ready' ? ['gamma'] : alpha.status === 'ready' && beta.status === 'ready' ? ['alpha', 'beta'] :
        beta.status === 'ready' && gamma.resultVersion === 2 ? ['beta'] : [];
      return result('dispatch', 'Integrate checked results or wait for the updated dependency', { implements: ids.map(id => ({ action: 'integrate', id })) });
    }
    if (stage(prompt, 'work')) {
      const { id, cycle } = context(prompt, 'Implement execution context');
      const marker = `dependency-written-${id}-${cycle}`;
      const version = cycle === 1 ? 'gamma-v1' : 'gamma-v2';
      if (!toolResults.some(text => text.includes(marker))) return { toolCalls: [{ name: 'shell', arguments: {
        command: 'set -e; ' + (id === 'beta' ? `test "$(cat gamma.txt)" = ${version}; ` : '') +
          `printf '${id === 'gamma' ? version : id}' > ${id}.txt; ` +
          (id === 'gamma' ? '' : `printf '${id === 'beta' && cycle > 1 ? 'alpha and beta' : id}' > shared.txt; `) +
          (id === 'beta' && cycle > 1 ? 'test -f late.bin; ' : '') + `echo ${marker}`,
      } }] };
      return result('done', `Created ${id} on ${version}`);
    }
    if (stage(prompt, 'verify')) {
      const { id, cycle } = context(prompt, 'Implement execution context');
      const marker = `dependency-verified-${id}-${cycle}`;
      if (!toolResults.some(text => text.includes(marker))) return { toolCalls: [{ name: 'shell', arguments: {
        command: `test "$(cat ${id}.txt)" = ${id === 'gamma' ? cycle === 1 ? 'gamma-v1' : 'gamma-v2' : id} && ` +
          (id === 'beta' ? `test "$(cat gamma.txt)" = ${cycle === 1 ? 'gamma-v1' : 'gamma-v2'} && ` : '') + `echo ${marker}`,
      } }] };
      return result('approve');
    }
    if (stage(prompt, 'integrationVerify') && !toolResults.some(text => text.includes('combined-ok'))) return { toolCalls: [{ name: 'shell', arguments: {
      command: 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta && test "$(cat gamma.txt)" = gamma-v2 && test "$(cat shared.txt)" = "alpha and beta" && test -f late.bin && echo combined-ok',
    } }] };
    return reply(call);
  }, definition, { beforeStart: sandbox => installGitCrash(sandbox, 'conflict-reset') });
  await waitFor(async () => {
    const calls = await sandbox.calls();
    const pending = calls.find(call => stage(call.prompt, 'manage') && context(call.prompt, 'Implement control context').instances.some(instance => instance.id === 'beta' && instance.status === 'conflict'));
    if (pending) return pending;
    await sandbox.release(calls);
    return false;
  }, 30000, 'beta conflict on gamma-v1 reaches manager');
  const oldConflict = sandbox.state().implements.instances.beta.integration;
  assert.equal(await readFile(join(oldConflict.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v1');
  await writeFile(join(sandbox.state().implements.instances.beta.workspace.path, 'late.bin'), Buffer.from([0, 1, 255]));
  await sandbox.releaseAll();
  const pid = await waitFor(() => readFile(join(sandbox.control, 'git-crash'), 'utf8').then(Number).catch(() => false), 20000, 'crash after installing refreshed candidate');
  await waitFor(() => !taggedProcesses(sandbox.token).some(item => item.pid === pid), 5000, 'crashed controller exits');
  const interrupted = sandbox.state();
  assert.equal(interrupted.status, 'running');
  assert.equal(interrupted.implements.instances.beta.refresh.status, 'prepared');
  assert.equal(interrupted.implements.instances.beta.integration.status, 'conflict');
  assert.equal(await readFile(join(interrupted.implements.instances.beta.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v2', 'Git replaced the files before SQLite could commit');
  await writeJson(join(sandbox.control, 'release.json'), { token: sandbox.token, callIds: [] });
  expireLease(sandbox);
  await sandbox.command(['inspect', sandbox.runId]);
  const worker = await waitFor(async () => (await sandbox.calls()).find(call => stage(call.prompt, 'work') &&
    taskContext(call.prompt).implement.id === 'beta' && taskContext(call.prompt).implement.cycle === 2), 15000, 'correcting beta worker admitted after recovery');
  const input = taskContext(worker.prompt);
  const resumed = sandbox.state().implements.instances.beta;
  assert.equal(await readFile(join(resumed.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v2');
  assert.equal(input.dependencies[0].resultVersion, 2);
  assert.equal(input.implement.conflict.id, resumed.refresh.id);
  assert.equal(resumed.integration.status, 'superseded');
  assert.equal(resumed.integration.supersededBy, resumed.refresh.id);
  assert.equal(resumed.conflictHistory.filter(op => op.id === oldConflict.id).length, 1);
  assert.equal(await readFile(join(oldConflict.workspace.path, 'gamma.txt'), 'utf8'), 'gamma-v1');
  assert.deepEqual(await readFile(join(resumed.workspace.path, 'late.bin')), Buffer.from([0, 1, 255]));
  assert.equal(sandbox.state().visits.filter(v => v.node === 'integrationVerify').length, 0);
  await sandbox.releaseAll();
  const final = await sandbox.finish();
  assert.equal(final.status, 'succeeded', final.error);
  assert.equal(await readFile(join(sandbox.workspace, 'gamma.txt'), 'utf8'), 'gamma-v2');
  assert.deepEqual(await readFile(join(sandbox.workspace, 'late.bin')), Buffer.from([0, 1, 255]));
  const betaWorkers = final.visits.filter(v => v.participant === 'beta/worker');
  assert.equal(betaWorkers.length, 2);
  assert.equal(betaWorkers[0].sessionId, betaWorkers[1].sessionId);
  assert.equal(final.visits.filter(v => v.participant === 'alpha/reviewer').length, 1);
  assert(final.visits.some(v => v.node === 'integrationVerify' && v.verdict?.outcome === 'approve'));
});
