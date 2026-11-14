import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, waitFor, writeJson, transcript, readJson } from './harness.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { installAdmissionFault } from './admission-faults.mjs';
import { currentContext } from './context-delivery.mjs';
import { getWorkflow, getRun } from '../run-store.mjs';

const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const verdict = outcome => JSON.stringify({ outcome, summary: 'DWF test: verified continuation candidate' });
const definition = (merge = false) => ({ task: 'Create result.txt containing continued and verify it', entry: 'work', merge,
  nodes: { work: { role: 'worker', tools: ['shell'], skills: [] }, review: { role: 'reviewer', tools: ['read'], skills: [] },
    verify: { role: 'verifier', tools: ['shell'], skills: [] } },
  transitions: { work: { done: 'review' }, review: { approve: 'verify', changes: 'work' }, verify: { approve: null, changes: 'work' } } });

async function fixture(t, { graph = definition(), reject, reply, fault, held = false } = {}) {
  const s = await createSandbox();
  const provider = await createControlledHttpProvider({ directory: s.control, token: s.token, reject, reply: reply ?? (({ prompt, toolResults }) => {
    const context = currentContext(prompt);
    if (context.role === 'worker') return toolResults.length ? verdict('done') : { toolCalls: [{ name: 'shell', arguments: { command: 'printf continued > result.txt' } }] };
    if (context.role === 'verifier') return toolResults.length ? verdict('approve') : { toolCalls: [{ name: 'shell', arguments: { command: 'test "$(cat result.txt)" = continued' } }] };
    return verdict('approve');
  }) });
  t.after(async () => { await provider.close(); await s.cleanup(); });
  const isolated = join(s.root, 'isolated'); await mkdir(isolated);
  Object.assign(s.env, { OPENCODE_TEST_HOME: isolated, OPENCODE_CONFIG_DIR: join(isolated, 'config'),
    XDG_CONFIG_HOME: join(isolated, 'config'), XDG_DATA_HOME: join(isolated, 'data'), XDG_CACHE_HOME: join(isolated, 'cache'), XDG_STATE_HOME: join(isolated, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_FFF: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    DWF_PLANNER_MODEL: JSON.stringify({ provider: 'dwf-acceptance', modelId: 'planner' }), DWF_PLANNER_REASONING: 'high', OPENCODE_CONFIG: join(s.root, 'provider.json') });
  delete s.env.OPENCODE_CONFIG_CONTENT;
  await writeJson(s.env.OPENCODE_CONFIG, nativeProviderConfig(provider.baseURL));
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'base']]) {
    execFileSync('git', args, { cwd: s.workspace, env: s.env, stdio: 'pipe' });
  }
  await writeJson(join(s.root, 'workflow.json'), graph);
  if (!held) await writeJson(join(s.control, 'release.json'), { token: s.token, all: true });
  const injection = fault && installAdmissionFault(s, fault);
  const start = s.spawn(cli, ['start', '--file', join(s.root, 'workflow.json')]);
  let runId;
  if (fault) {
    const marker = await waitFor(async () => {
      const value = await readJson(injection.marker);
      if (value) return value;
      if (start.exited && start.outcome.code !== 0) throw new Error(`Fault start: ${start.stderr}`);
    }, 30000, `fault ${fault}`);
    runId = marker.id;
    await start.close;
  } else ({ runId } = await cliJson(start, 30000));
  const command = async args => { const child = s.spawn(cli, args); try { return await cliJson(child, 30000); } catch (error) { throw new Error(`${args[0]}: ${child.stderr}`, { cause: error }); } };
  const finish = status => waitFor(() => {
    const state = getWorkflow(s.state, runId) ?? getRun(s.state, runId);
    return (status ? state.status === status : state.status !== 'running') && state;
  }, 45000, `run ${runId} ${status ?? 'terminal'}`);
  return { ...s, runId, command, finish, injection, events: () => transcript(join(s.control, 'provider.jsonl')) };
}

test('public continue recovers HTTP 403 in the same run/session, retains history and independently verifies the files', { timeout: 90000 }, async t => {
  let deny = true;
  const s = await fixture(t, { reject: () => deny ? { status: 403, message: 'Acceptance permission denied' } : undefined });
  const failed = await s.finish('failed');
  assert.match(failed.error, /403/); assert.match(failed.error, /Acceptance permission denied/);
  const old = structuredClone(failed.visits[0]);
  deny = false;
  const continuing = await s.command(['continue', s.runId]);
  assert.equal(continuing.runId, s.runId);
  const final = await s.finish('succeeded');
  assert.equal(final.visits[1].sessionId, old.sessionId);
  assert.equal(final.visits[0].inputId, old.inputId); assert.equal(final.visits[0].prompt, old.prompt);
  assert.match(final.recoveryHistory[0].error, /403/);
  assert.equal(await readFile(join(final.workspace.path, 'result.txt'), 'utf8'), 'continued');
  execFileSync('sh', ['-c', 'test "$(cat result.txt)" = continued'], { cwd: final.workspace.path });
  const count = final.visits.length;
  await Promise.all([s.command(['continue', s.runId]), s.command(['continue', s.runId])]);
  assert.equal(getWorkflow(s.state, s.runId).visits.length, count);
});

test('public continue retries only the failed group member and preserves completed work', { timeout: 90000 }, async t => {
  let deny = true;
  const graph = definition();
  graph.groups = { checks: { members: ['review', 'verify'] } };
  graph.transitions.work.done = 'checks'; graph.transitions.checks = { done: null, failed: null, changes: 'work' };
  const s = await fixture(t, { graph, reject: ({ prompt }) => deny && currentContext(prompt).node === 'review' ? { status: 403 } : undefined });
  const failed = await s.finish('failed');
  const worker = structuredClone(failed.visits[0]);
  const group = failed.visits[1]; const success = structuredClone(group.children.find(c => c.node === 'verify'));
  deny = false;
  await s.command(['continue', s.runId]);
  const final = await s.finish('succeeded');
  assert.deepEqual(final.visits[0], worker);
  assert.deepEqual(final.visits[1].children.find(c => c.inputId === success.inputId), success);
  assert.equal(final.visits[1].children.length, 3);
  assert.equal(final.visits[1].children.at(-1).node, 'review');
});

for (const boundary of ['prepared', 'admission_started', 'accepted', 'result_read', 'transition', 'before_merge', 'after_merge']) {
  test(`public continue after real controller death at ${boundary} preserves frozen bytes without editing the database`, { timeout: 100000 }, async t => {
    const s = await fixture(t, { fault: boundary, graph: definition(boundary.includes('merge')) });
    const before = getWorkflow(s.state, s.runId); const input = before.visits[0];
    // The old lease is real. Do not rewrite expiry/owner/state to recover the run.
    await new Promise(resolve => setTimeout(resolve, 31000));
    const attempts = await Promise.all([s.command(['continue', s.runId]), s.command(['continue', s.runId])]);
    const blocked = attempts.find(a => a.recovery?.status === 'blocked');
    if (blocked) {
      const resolution = blocked.recovery.resolutionTemplate;
      assert(resolution, blocked.recovery.reason);
      for (const d of resolution.decisions) { d.action = 'retry'; d.evidence = 'Fault marker proves this test stopped before native session creation; explicitly authorize original admission replay.'; }
      const file = join(s.root, 'fault-resolution.json'); await writeJson(file, resolution);
      await s.command(['continue', s.runId, '--resolution-file', file]);
    }
    const final = await s.finish('succeeded');
    assert.equal(final.id, s.runId); assert.equal(final.workspace.path, before.workspace.path);
    assert.equal(final.visits[0].inputId, input.inputId); assert.equal(final.visits[0].prompt, input.prompt);
    assert.equal(final.visits.filter(v => v.node === 'work').length, 1);
    assert.equal(final.visits[0].sessionId, input.sessionId);
    if (boundary.includes('merge')) {
      assert.equal(await readFile(join(s.workspace, 'result.txt'), 'utf8'), 'continued');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.workspace, encoding: 'utf8' }).trim();
      assert.equal(final.result.commit, head);
      await s.command(['continue', s.runId]);
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: s.workspace, encoding: 'utf8' }).trim(), head);
    }
  });
}

test('public continue cannot undo stop or silently repeat an interrupted arbitrary command; confirm remains a witness, not an approval', { timeout: 90000 }, async t => {
  const s = await fixture(t, { reply: ({ prompt, toolResults }) => {
    const context = currentContext(prompt);
    if (context.role === 'worker') return context.recovery ? verdict('done') : { toolCalls: [{ name: 'shell', arguments: { command: 'printf effect >> effects.txt; sleep 60' } }] };
    if (context.role === 'verifier') return toolResults.length ? verdict('approve') : { toolCalls: [{ name: 'shell', arguments: { command: 'test "$(cat effects.txt)" = effect' } }] };
    return verdict('approve');
  } });
  await waitFor(async () => {
    const state = getWorkflow(s.state, s.runId);
    try { return await readFile(join(state.workspace.path, 'effects.txt'), 'utf8') === 'effect'; } catch { return false; }
  }, 15000, 'command external effect');
  const stopped = await s.command(['stop', s.runId]); assert.equal(stopped.status, 'cancelled');
  const rejected = s.spawn(cli, ['continue', s.runId]); await rejected.close; assert.notEqual((await rejected.exit).code, 0);
  const blocked = await s.command(['continue', s.runId, '--resume-cancelled']);
  assert.equal(blocked.recovery.status, 'blocked'); assert(blocked.recovery.problems.length);
  const file = join(s.root, 'decision.json'); const resolution = blocked.recovery.resolutionTemplate;
  for (const decision of resolution.decisions) { decision.action = 'confirm'; decision.evidence = 'Observed exactly one effect in effects.txt; do not repeat this command.'; }
  await writeJson(file, resolution);
  await s.command(['continue', s.runId, '--resume-cancelled', '--resolution-file', file]);
  const final = await s.finish('succeeded');
  assert.equal(await readFile(join(final.workspace.path, 'effects.txt'), 'utf8'), 'effect');
  assert.equal(final.visits.filter(v => v.node === 'review').length, 1);
  assert.equal(final.visits.filter(v => v.node === 'verify').length, 1);
  assert(final.controls.find(c => c.kind === 'stop').resumedBy);
});

for (const boundary of ['before_group', 'after_group']) {
  test(`public continue reconciles ${boundary} without rerunning successful parallel workers`, { timeout: 100000 }, async t => {
    const graph = definition();
    delete graph.nodes.work; delete graph.transitions.work;
    graph.entry = 'makers'; graph.nodes.left = { role: 'worker', tools: ['shell'], skills: [] }; graph.nodes.right = { ...graph.nodes.left };
    graph.transitions.left = { done: null }; graph.transitions.right = { done: null };
    graph.groups = { makers: { members: ['left', 'right'] } };
    graph.transitions.makers = { done: 'review', failed: null, changes: null }; graph.transitions.review.changes = 'makers'; graph.transitions.verify.changes = 'makers';
    const s = await fixture(t, { graph, fault: boundary, reply: ({ prompt, toolResults }) => {
      const c = currentContext(prompt);
      if (c.role === 'worker') return toolResults.length ? verdict('done') : { toolCalls: [{ name: 'shell', arguments: { command: `printf ${c.node} > ${c.node}.txt` } }] };
      return verdict('approve');
    } });
    const before = getWorkflow(s.state, s.runId); const ids = before.visits[0].children.map(v => v.inputId);
    await new Promise(resolve => setTimeout(resolve, 31000));
    await s.command(['continue', s.runId]);
    const final = await s.finish('succeeded');
    assert.deepEqual(final.visits[0].children.map(v => v.inputId), ids);
    for (const name of ['left', 'right']) assert.equal(await readFile(join(final.workspace.path, `${name}.txt`), 'utf8'), name);
  });
}

test('public continue rechecks changed workspace without rerunning the successful worker', { timeout: 90000 }, async t => {
  let deny = true;
  const s = await fixture(t, { reject: ({ prompt }) => deny && currentContext(prompt).node === 'verify' ? { status: 403 } : undefined });
  const failed = await s.finish('failed');
  await writeFile(join(failed.workspace.path, 'late.txt'), 'external change');
  deny = false; await s.command(['continue', s.runId]);
  const final = await s.finish('succeeded');
  assert.equal(final.visits.filter(v => v.node === 'work').length, 1);
  assert.equal(final.visits.filter(v => v.node === 'review').length, 2);
  const review = final.visits.findLast(v => v.node === 'review'); const verify = final.visits.findLast(v => v.node === 'verify');
  assert.equal(review.revision, verify.revision);
  assert.equal(await readFile(join(final.workspace.path, 'late.txt'), 'utf8'), 'external change');
});

test('public continue preserves a failed legacy planner and resumes its existing native session', { timeout: 90000 }, async t => {
  let deny = true;
  const s = await fixture(t, { graph: { planner: { task: 'Legacy exact planning task' } }, reject: () => deny ? { status: 403 } : undefined,
    reply: () => 'Legacy plan continued without losing original task.' });
  const failed = await waitFor(async () => { const x = await s.command(['inspect', s.runId]); return x.status === 'failed' && x; }, 15000, 'legacy failed result');
  assert.match(failed.error, /403/);
  const old = getRun(s.state, s.runId); deny = false;
  await s.command(['continue', s.runId]);
  const final = await s.finish('succeeded');
  assert.deepEqual(final.legacyPlanner, old);
  assert.equal(final.visits.at(-1).sessionId, old.sessionId);
  assert.equal(final.result, 'Legacy plan continued without losing original task.');
  assert.equal(getRun(s.state, s.runId).status, 'failed');
});

test('public continue requires a stale-safe decision for a missing session and supplies saved context to its replacement', { timeout: 90000 }, async t => {
  let deny = true;
  const s = await fixture(t, { reject: () => deny ? { status: 403 } : undefined });
  const failed = await s.finish('failed'); const old = failed.visits[0];
  const { OpenCode } = await import('@opencode/client'); const { Service } = await import('@opencode/client/service');
  const endpoint = await Service.discover({ file: failed.opencode.registration });
  const native = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  await native.session.remove({ sessionID: old.sessionId });
  deny = false;
  const blocked = await s.command(['continue', s.runId]); assert.equal(blocked.recovery.status, 'blocked');
  const file = join(s.root, 'resolution.json');
  const resolution = blocked.recovery.resolutionTemplate;
  for (const d of resolution.decisions) { d.action = 'retry'; d.evidence = 'Explicitly permit reentry with preserved files after native session loss.'; }
  await writeJson(file, resolution);
  await writeFile(join(failed.workspace.path, 'late.txt'), 'changed revision');
  const stale = s.spawn(cli, ['continue', s.runId, '--resolution-file', file]); await stale.close;
  assert.equal((await stale.exit).code, 1); assert.match(stale.stderr, /устарело/);
  const refreshed = await s.command(['continue', s.runId]); const fresh = refreshed.recovery.resolutionTemplate;
  for (const d of fresh.decisions) { d.action = 'retry'; d.evidence = 'Rechecked new revision and authorize recovery.'; }
  await writeJson(file, fresh); await s.command(['continue', s.runId, '--resolution-file', file]);
  const final = await s.finish('succeeded'); const replacement = final.visits[1];
  assert.notEqual(replacement.sessionId, old.sessionId);
  assert.equal(replacement.taskContext.task.requirements, old.taskContext.task.requirements);
  assert.match(replacement.prompt, /lost native messages cannot be restored/);
  assert.equal(final.visits[0].sessionId, old.sessionId);
});

for (const boundary of ['executing', 'during_tool']) {
  test(`public continue attaches to native work after controller death ${boundary}`, { timeout: 100000 }, async t => {
    const s = await fixture(t, { fault: boundary, held: boundary === 'executing', reply: ({ prompt, toolResults }) => {
      const c = currentContext(prompt);
      if (c.role === 'worker') return toolResults.length ? verdict('done') : { toolCalls: [{ name: 'shell', arguments: { command: `printf continued > result.txt; sleep ${boundary === 'during_tool' ? 40 : 3}` } }] };
      return verdict('approve');
    } });
    const before = getWorkflow(s.state, s.runId); const original = before.visits[0];
    await new Promise(resolve => setTimeout(resolve, 31000));
    await s.command(['continue', s.runId]);
    await writeJson(join(s.control, 'release.json'), { token: s.token, all: true });
    const final = await s.finish('succeeded');
    assert.equal(final.visits.filter(v => v.node === 'work').length, 1);
    assert.equal(final.visits[0].inputId, original.inputId);
    assert.equal(await readFile(join(final.workspace.path, 'result.txt'), 'utf8'), 'continued');
  });
}

async function implementGraph() {
  const graph = JSON.parse(await readFile(new URL('../workflows/parallel-implement.json', import.meta.url), 'utf8'));
  delete graph.implements.instances.gamma; graph.taskPackages = graph.taskPackages.filter(p => p.id !== 'gamma');
  for (const node of Object.values(graph.nodes)) { node.tools = ['read']; node.skills = []; }
  graph.nodes.work.tools = ['shell']; graph.nodes.verify.tools = ['shell']; graph.nodes.integrationVerify.tools = ['shell'];
  return graph;
}
function implementReply({ prompt, toolResults }) {
  const c = currentContext(prompt);
  if (c.role === 'orchestrator') {
    const instances = c.implements.instances;
    if (instances.every(i => i.status === 'integrated')) return JSON.stringify({ outcome: 'finish', summary: 'All candidates integrated' });
    const actions = instances.flatMap(i => i.status === 'pending' ? [{ action: 'admit', id: i.id, assignment: `Create ${i.id}.txt containing ${i.id}` }] :
      i.status === 'ready' ? [{ action: 'integrate', id: i.id }] : []);
    return JSON.stringify({ outcome: 'dispatch', summary: 'Advance independently verified candidates', implements: actions });
  }
  if (c.role === 'worker') return toolResults.length ? verdict('done') : { toolCalls: [{ name: 'shell', arguments: { command: `printf ${c.implement.id} > ${c.implement.id}.txt` } }] };
  if (c.role === 'verifier') {
    const check = c.implement ? `test "$(cat ${c.implement.id}.txt)" = ${c.implement.id}` : 'test "$(cat alpha.txt)" = alpha && test "$(cat beta.txt)" = beta';
    return toolResults.length ? verdict('approve') : { toolCalls: [{ name: 'shell', arguments: { command: check } }] };
  }
  return verdict('approve');
}
for (const boundary of ['before_implement', 'after_implement']) {
  test(`public continue reconciles ${boundary} without duplicate integration or lost implement evidence`, { timeout: 100000 }, async t => {
    const s = await fixture(t, { graph: await implementGraph(), reply: implementReply, fault: boundary });
    const before = getWorkflow(s.state, s.runId);
    const workers = before.visits.filter(v => v.implementId && v.node === 'work').map(v => v.inputId);
    await new Promise(resolve => setTimeout(resolve, 31000)); await s.command(['continue', s.runId]);
    const final = await s.finish('succeeded');
    assert.deepEqual(final.visits.filter(v => v.implementId && v.node === 'work').map(v => v.inputId), workers);
    for (const instance of Object.values(final.implements.instances)) {
      assert.equal(instance.status, 'integrated'); assert.equal(instance.resultVersion, 1);
      assert.equal(instance.integrations.length, 1);
      assert.equal(await readFile(join(final.workspace.path, `${instance.id}.txt`), 'utf8'), instance.id);
    }
  });
}

test('a live controller diagnoses a removed native session instead of polling it forever', { timeout: 90000 }, async t => {
  const s = await fixture(t, { held: true });
  const saved = getWorkflow(s.state, s.runId); const old = saved.visits[0];
  const { OpenCode } = await import('@opencode/client'); const { Service } = await import('@opencode/client/service');
  const endpoint = await Service.discover({ file: saved.opencode.registration });
  const native = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  await native.session.remove({ sessionID: old.sessionId });
  const failed = await s.finish('failed'); assert.match(failed.error, /сессия недоступна/);
  const blocked = await s.command(['continue', s.runId]); assert.equal(blocked.recovery.status, 'blocked');
  await writeJson(join(s.control, 'release.json'), { token: s.token, all: true });
  const resolution = blocked.recovery.resolutionTemplate;
  for (const d of resolution.decisions) { d.action = 'retry'; d.evidence = 'Authorize recovery after intentional test session removal'; }
  const file = join(s.root, 'lost-live-session.json'); await writeJson(file, resolution);
  await s.command(['continue', s.runId, '--resolution-file', file]); await s.finish('succeeded');
});

test('public continue on a running legacy planner neither migrates it nor creates a controller or input', { timeout: 90000 }, async t => {
  const s = await fixture(t, { graph: { planner: { task: 'Keep the accepted legacy input' } }, held: true, reply: () => 'Legacy finished' });
  const before = getRun(s.state, s.runId);
  await Promise.all([s.command(['continue', s.runId]), s.command(['continue', s.runId])]);
  assert.equal(getWorkflow(s.state, s.runId), undefined);
  assert.deepEqual(getRun(s.state, s.runId), before);
  await writeJson(join(s.control, 'release.json'), { token: s.token, all: true });
  const final = await waitFor(async () => { const x = await s.command(['inspect', s.runId]); return x.status === 'succeeded' && x; }, 15000, 'running legacy completion');
  assert.equal(final.result, 'Legacy finished');
});

for (const boundary of ['preparation_error', 'persistence_error']) {
  test(`public continue preserves the confirmed boundary after ${boundary}`, { timeout: 90000 }, async t => {
    const s = await fixture(t, { fault: boundary });
    const failed = await s.finish('failed'); assert.match(failed.error, /ENOSPC/);
    const completed = failed.visits.filter(v => v.verdict).map(v => v.inputId);
    await s.command(['continue', s.runId]); const final = await s.finish('succeeded');
    assert(final.recoveryHistory.some(r => /ENOSPC/.test(r.error)));
    for (const id of completed) assert(final.visits.some(v => v.inputId === id && v.verdict));
    assert.equal(final.visits.filter(v => v.node === 'work').length, 1);
    assert.equal(await readFile(join(final.workspace.path, 'result.txt'), 'utf8'), 'continued');
  });
}

test('public continue handles a network disconnect without duplicating accepted inputs', { timeout: 90000 }, async t => {
  let disconnect = true;
  const s = await fixture(t, { reject: () => { if (disconnect) { disconnect = false; return { disconnect: true }; } } });
  await s.command(['continue', s.runId]);
  let state = await s.finish();
  if (state.status === 'failed') { await s.command(['continue', s.runId]); state = await s.finish('succeeded'); }
  assert.equal(state.status, 'succeeded');
  assert.equal(await readFile(join(state.workspace.path, 'result.txt'), 'utf8'), 'continued');
  const { OpenCode } = await import('@opencode/client'); const { Service } = await import('@opencode/client/service');
  const endpoint = await Service.discover({ file: state.opencode.registration });
  const native = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const workers = state.visits.filter(v => v.node === 'work');
  const messages = await native.message.list({ sessionID: workers[0].sessionId, order: 'asc', limit: 100 });
  assert.deepEqual(messages.data.filter(m => m.type === 'user').map(m => m.id), workers.map(v => v.inputId));
  assert.equal(new Set(workers.map(v => v.inputId)).size, workers.length);
});

test('public continue preserves completed implements after a manager provider failure', { timeout: 90000 }, async t => {
  let deny = true;
  const s = await fixture(t, { graph: await implementGraph(), reply: implementReply, reject: ({ prompt }) => {
    const c = currentContext(prompt);
    if (deny && c.role === 'orchestrator' && c.implements.instances.some(i => i.status === 'ready')) return { status: 403 };
  } });
  const failed = await s.finish('failed'); const done = failed.visits.filter(v => v.implementId && v.node === 'work' && v.verdict).map(v => v.inputId);
  deny = false; const result = await s.command(['continue', s.runId]);
  if (result.recovery?.status === 'blocked') {
    const resolution = result.recovery.resolutionTemplate;
    for (const d of resolution.decisions) { d.action = 'retry'; d.evidence = 'Authorize retry of this isolated fixture verification after interruption'; }
    const file = join(s.root, 'implement-recovery.json'); await writeJson(file, resolution);
    await s.command(['continue', s.runId, '--resolution-file', file]);
  }
  const final = await s.finish('succeeded');
  for (const id of done) assert(final.visits.some(v => v.inputId === id && v.verdict.outcome === 'done'));
  for (const instance of Object.values(final.implements.instances)) { assert.equal(instance.resultVersion, 1); assert.equal(instance.integrations.length, 1); }
});

function checkingGroupGraph() {
  const graph = definition();
  graph.groups = { checks: { members: ['review'] } };
  graph.transitions.work.done = 'checks';
  graph.transitions.checks = { done: 'verify', failed: null, changes: 'work' };
  return graph;
}

test('review regression: stopped admitted group finishes after replacing interrupted members', { timeout: 90000 }, async t => {
  const graph = checkingGroupGraph(); graph.entry = 'checks';
  const s = await fixture(t, { graph, held: true, reply: () => verdict('approve') });
  const before = getWorkflow(s.state, s.runId); const group = before.visits[0];
  assert.equal(group.children[0].admitted, true);
  await s.command(['stop', s.runId]);
  await writeJson(join(s.control, 'release.json'), { token: s.token, all: true });
  await s.command(['continue', s.runId, '--resume-cancelled']);
  const final = await s.finish('succeeded');
  assert(final.visits[0].children[0].recoveredBy);
  assert.equal(final.visits[0].children.at(-1).verdict.outcome, 'approve');
});

test('review regression: a group member can recover from two consecutive provider failures', { timeout: 90000 }, async t => {
  let deny = true;
  const s = await fixture(t, { graph: checkingGroupGraph(), reject: ({ prompt }) => deny && currentContext(prompt).node === 'review' ? { status: 403 } : undefined });
  const first = await s.finish('failed');
  await s.command(['continue', s.runId]);
  const second = await s.finish('failed');
  assert.equal(second.visits[1].children.length, 2);
  deny = false; await s.command(['continue', s.runId]);
  const final = await s.finish('succeeded');
  assert.equal(final.visits[1].children.length, 3);
  assert.equal(final.visits[1].children.at(-1).sessionId, first.visits[1].children[0].sessionId);
  assert.equal(final.visits.filter(v => v.node === 'work').length, 1);
});

test('review regression: writer group retry retains the partially written workspace', { timeout: 90000 }, async t => {
  let deny = true;
  const graph = definition(); graph.entry = 'makers'; graph.groups = { makers: { members: ['work'] } };
  graph.transitions.makers = { done: 'review', failed: null, changes: null };
  const s = await fixture(t, { graph,
    reject: ({ prompt, toolResults }) => deny && currentContext(prompt).role === 'worker' && toolResults.length ? { status: 403 } : undefined,
    reply: ({ prompt, toolResults }) => {
      const c = currentContext(prompt);
      if (c.role !== 'worker') return verdict('approve');
      if (c.recovery) return toolResults.length > 1 ? verdict('done') : { toolCalls: [{ name: 'shell', arguments: { command: 'test "$(cat partial.txt)" = preserved; printf continued > result.txt' } }] };
      return { toolCalls: [{ name: 'shell', arguments: { command: 'printf preserved > partial.txt' } }] };
    } });
  const failed = await s.finish('failed'); const old = failed.visits[0].children[0];
  assert.equal(await readFile(join(old.workspace.path, 'partial.txt'), 'utf8'), 'preserved');
  deny = false; await s.command(['continue', s.runId]);
  const final = await s.finish('succeeded'); const replacement = final.visits[0].children.at(-1);
  assert.equal(replacement.workspace.path, old.workspace.path);
  assert.equal(await readFile(join(final.workspace.path, 'partial.txt'), 'utf8'), 'preserved');
  assert.equal(await readFile(join(final.workspace.path, 'result.txt'), 'utf8'), 'continued');
});

test('review regression: drift after a completed review group returns to that group before verifier', { timeout: 90000 }, async t => {
  let deny = true;
  const s = await fixture(t, { graph: checkingGroupGraph(), reject: ({ prompt }) => deny && currentContext(prompt).node === 'verify' ? { status: 403 } : undefined });
  const failed = await s.finish('failed');
  await writeFile(join(failed.workspace.path, 'late.txt'), 'new candidate');
  deny = false; await s.command(['continue', s.runId]);
  const final = await s.finish('succeeded');
  assert.equal(final.visits.filter(v => v.node === 'work').length, 1);
  const groups = final.visits.filter(v => v.node === 'checks'); assert.equal(groups.length, 2);
  const verify = final.visits.findLast(v => v.node === 'verify');
  assert.equal(groups.at(-1).children[0].revision, verify.revision);
  assert(groups[0].recoveredBy);
});

for (const failedRole of ['scientist', 'committee']) test(`review regression: research retries ${failedRole} without advancing the logical phase or replacing the report`, { timeout: 90000 }, async t => {
  const graph = JSON.parse(await readFile(new URL('../workflows/research-mid.json', import.meta.url), 'utf8'));
  for (const node of Object.values(graph.nodes)) { node.model = { provider: 'dwf-acceptance', modelId: 'planner' }; node.tools = []; node.skills = []; }
  let deny = true, scientistTurns = 0;
  const items = ids => ids.map(id => ({ id, instructions: `Inspect ${id}` }));
  const s = await fixture(t, { graph,
    reject: ({ prompt }) => deny && (failedRole === 'committee' ? prompt.startsWith('Original research request') : prompt.includes('Completed research rounds:')) ? { status: 403 } : undefined,
    reply: ({ prompt }) => {
      if (prompt.startsWith('Original research request')) return verdict('approve');
      if (!prompt.includes('Completed research rounds:')) return verdict('done');
      const turn = scientistTurns++;
      return JSON.stringify(turn === 0 ? { outcome: 'scout', summary: 'Scout assignments', items: items(['foundations', 'recent']) } :
        turn === 1 ? { outcome: 'research', summary: 'Research assignments', items: items(['a', 'b', 'c', 'd']) } : { outcome: 'report', summary: 'Exact research report retained across recovery.' });
    } });
  const failed = await s.finish('failed'); deny = false; await s.command(['continue', s.runId]);
  const final = await s.finish('succeeded');
  assert.deepEqual(final.result, { outcome: 'approve', summary: 'Exact research report retained across recovery.' });
  const retry = final.visits.find(v => v.recoveryOf);
  assert.equal(retry.node, failedRole);
  assert.equal(retry.sessionId, failed.visits.at(-1).sessionId);
  if (failedRole === 'scientist') { assert.match(retry.prompt, /Allowed outcomes this turn: scout/); assert.equal(retry.verdict.outcome, 'scout'); }
});

for (const interruption of ['failure', 'active']) test(`recheck revision: unfinished second worker remains current after ${interruption}`, { timeout: 120000 }, async t => {
  const seen = new Map(); let reviewChanges = true, deny = true;
  const s = await fixture(t, { fault: interruption === 'active' ? 'second_worker_tool' : undefined,
    reject: ({ prompt }) => {
      const c = currentContext(prompt);
      return interruption === 'failure' && deny && c.role === 'worker' && prompt.includes('REVIEW_REWORK_FOR_TEST') && seen.has(c.inputId) ? { status: 403 } : undefined;
    }, reply: ({ prompt }) => {
      const c = currentContext(prompt);
      if (c.role === 'reviewer') {
        if (reviewChanges) { reviewChanges = false; return JSON.stringify({ outcome: 'changes', summary: 'REVIEW_REWORK_FOR_TEST' }); }
        return verdict('approve');
      }
      if (c.role !== 'worker') return verdict('approve');
      if (seen.has(c.inputId)) return verdict('done');
      seen.set(c.inputId, true);
      const second = prompt.includes('REVIEW_REWORK_FOR_TEST');
      const command = second ? (c.recovery ? 'printf complete > completed.txt' : `printf second > result.txt; ${interruption === 'active' ? 'sleep 55; printf complete > completed.txt' : 'true'}`) : 'printf first > result.txt';
      return { toolCalls: [{ name: 'shell', arguments: { command } }] };
    } });
  const before = interruption === 'failure' ? await s.finish('failed') : getWorkflow(s.state, s.runId);
  const worker = before.visits.at(-1); assert.equal(worker.node, 'work');
  assert.equal(await readFile(join(before.workspace.path, 'result.txt'), 'utf8'), 'second');
  if (interruption === 'active') await new Promise(resolve => setTimeout(resolve, 31000));
  deny = false; const resumed = await s.command(['continue', s.runId]);
  const saved = getWorkflow(s.state, s.runId);
  assert.equal(saved.visits.at(-1).node, 'work', 'A historical recheck must not displace the worker');
  if (interruption === 'active') assert.equal(saved.visits.at(-1).inputId, worker.inputId);
  else assert.equal(saved.visits.at(-1).recoveryOf, worker.inputId);
  assert.equal(resumed.status, 'running');
  const final = await s.finish('succeeded');
  assert.equal(final.visits.filter(v => v.node === 'work' && v.verdict?.outcome === 'done').length, 2);
  assert.equal(await readFile(join(final.workspace.path, 'completed.txt'), 'utf8'), 'complete');
});

test('recheck revision: mixed group retains one writer execution through repeated rechecks in UI and context', { timeout: 90000 }, async t => {
  let deny = true;
  const graph = definition(); graph.entry = 'mixed'; graph.groups = { mixed: { members: ['work', 'review'] } };
  graph.transitions.mixed = { done: 'verify', changes: null, failed: null };
  const s = await fixture(t, { graph,
    reject: ({ prompt }) => deny && currentContext(prompt).node === 'verify' ? { status: 403 } : undefined,
    reply: ({ prompt, toolResults }) => currentContext(prompt).role === 'worker' ? toolResults.length ? verdict('done') :
      { toolCalls: [{ name: 'shell', arguments: { command: 'printf run >> executions.txt; printf continued > result.txt' } }] } : verdict('approve') });
  let failed = await s.finish('failed');
  const writer = structuredClone(failed.visits[0].children.find(c => c.node === 'work'));
  for (let round = 1; round <= 3; round++) {
    await writeFile(join(failed.workspace.path, 'late.txt'), `external drift ${round}`);
    if (round === 3) deny = false;
    await s.command(['continue', s.runId]);
    const current = getWorkflow(s.state, s.runId).visits.findLast(v => v.children);
    assert.deepEqual(current.children.find(c => c.node === 'work'), writer, 'retain the actual successful writer input/result');
    failed = await s.finish(round === 3 ? 'succeeded' : 'failed');
  }
  const final = failed;
  assert.equal(await readFile(join(final.workspace.path, 'executions.txt'), 'utf8'), 'run');
  assert.equal(await readFile(join(final.workspace.path, 'late.txt'), 'utf8'), 'external drift 3');
  const groups = final.visits.filter(v => v.node === 'mixed'); assert.equal(groups.length, 4);
  for (const group of groups) assert.equal(group.children.find(c => c.node === 'work').inputId, writer.inputId);
  const { workflowView } = await import('../ui-data.mjs');
  const view = workflowView(final, { root: s.state });
  const people = view.graph.nodes.find(n => n.id === 'mixed').participants;
  assert.deepEqual(people.find(p => p.id === 'work').invocations.map(c => c.id), [writer.inputId]);
  const checkingIds = groups.flatMap(v => v.children.filter(c => c.node === 'review').map(c => c.inputId));
  assert.equal(checkingIds.length, 4);
  assert.deepEqual(people.find(p => p.id === 'review').invocations.map(c => c.id), checkingIds);
  const verifierIds = final.visits.filter(v => v.node === 'verify').map(v => v.inputId);
  assert.equal(verifierIds.length, 4);
  assert.deepEqual(view.graph.nodes.find(n => n.id === 'verify').participants[0].invocations.map(c => c.id), verifierIds);
  const history = await readJson(final.visits.at(-1).taskContext.history.path);
  assert.deepEqual(history.filter(r => r.node === 'work').map(r => r.inputId), [writer.inputId]);
  assert.deepEqual(history.filter(r => r.node === 'review').map(r => r.inputId), checkingIds);
  assert.deepEqual(history.filter(r => r.node === 'verify').map(r => r.inputId), verifierIds.slice(0, -1));
  assert.equal(history.filter(r => r.role === 'group').length, 4, 'all group memberships/outcomes remain auditable');
});
