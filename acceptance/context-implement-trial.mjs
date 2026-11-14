// Independent live tester trial. The tester authors the graph; DWF participants
// author the project functions. This harness only observes, injects lifecycle
// faults, invokes public recovery and checks the resulting artifacts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { createSandbox, cliJson, readJson, writeJson, within, waitFor } from './harness.mjs';
import { prepareCandidateTester, connectCandidateTester } from './candidate-tester.mjs';
import { admitTester, inspectTester } from './tester.mjs';
import { getWorkflow, savedRuns } from '../run-store.mjs';
import { checkApprovals } from '../workflow-definition.mjs';
import { verifyOriginalTrialTests } from './original-trial-tests.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';

const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const freeze = visit => ({ inputId: visit.inputId, sessionId: visit.sessionId, revision: visit.revision,
  prompt: visit.prompt, taskContext: visit.taskContext, verdict: visit.verdict });
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export async function runTrial(settings) {
  await mkdir(settings.evidence, { recursive: true, mode: 0o700 });
  const s = await createSandbox();
  let attempt, client, browser;
  const evidence = { root: s.root, startedAt: Date.now(), interventions: [] };
  await writeJson(join(settings.evidence, 'latest.json'), evidence);
  const command = async args => {
    const result = await cliJson(s.spawn(cli, args), 45000);
    evidence.interventions.push({ command: args, at: Date.now(), result });
    return result;
  };
  try {
    s.env.DWF_CONTEXT_TRIAL_CONTROL = s.control;
    s.env.NODE_OPTIONS = `${s.env.NODE_OPTIONS ?? ''} --import=${new URL('./context-implement-faults.mjs', import.meta.url).href}`;
    attempt = await prepareCandidateTester(s, { ...settings, prompt: await readFile(settings.promptFile, 'utf8') });
    evidence.attempt = attempt.directory;
    await writeJson(join(settings.evidence, 'latest.json'), evidence);
    client = await connectCandidateTester(s, attempt);
    await admitTester(client, attempt);
    let runId, crashResumed = false, failureResumed = false, failedSuccesses;
    let capturedParallel = false;
    let decision;
    let final, tester;
    const deadline = Date.now() + (settings.timeoutMs ?? 40 * 60 * 1000);
    let lastObservation;
    while (Date.now() < deadline) {
      tester = await inspectTester(client, attempt);
      const runs = savedRuns(s.state).workflows.map(row => row.state);
      assert(runs.length <= 1, 'Independent tester created replacement/duplicate workflows.');
      runId ??= runs[0]?.id;
      if (runId) {
        const state = getWorkflow(s.state, runId);
        const observation = { status: state.status, visits: state.visits.length,
          instances: Object.values(state.implements?.instances ?? {}).map(i => ({ id: i.id, status: i.status, cycle: i.cycle })) };
        const text = JSON.stringify(observation);
        if (text !== lastObservation) {
          await writeJson(join(attempt.directory, 'observed-state.json'), state);
          console.log(JSON.stringify({ runId, tester: tester.status, ...observation }));
          lastObservation = text;
        }
        const crash = await readJson(join(s.control, 'crash.json'));
        if (crash && !crashResumed) {
          if (!decision) {
            const frozen = await readJson(join(s.control, 'before-crash.json'));
            const target = frozen.visits.find(v => crash.inputIds.includes(v.inputId));
            const text = 'Preserve both independent registry entries and public exports during integration. Keep the original acceptance tests unchanged.\n';
            const messageFile = join(attempt.directory, 'integration-decision.txt');
            await writeFile(messageFile, text, { mode: 0o600 });
            const accepted = await command(['steer', runId, target.participant, '--message-file', messageFile, '--kind', 'decision']);
            decision = { text, target: target.participant, taskId: target.taskId, accepted };
            evidence.decision = decision;
          }
          if (!capturedParallel) {
            const ui = await command(['ui', '--start']);
            browser = await openBrowser(ui.url + '?run=' + runId);
            await waitFor(() => browser.evaluate(`document.querySelectorAll('[data-toggle-implement]').length===3`), 15000, 'three real implement cards');
            for (const [width, height] of [[1440, 1000], [390, 844]]) {
              await browser.viewport(width, height);
              await browser.evaluate(`document.querySelector('#fit').click()`);
              await browser.screenshot(join(attempt.directory, `parallel-${width}.png`));
            }
            const api = await browser.evaluate(`fetch('/api/runs').then(r=>r.json())`);
            await writeJson(join(attempt.directory, 'parallel-ui.json'), api);
            capturedParallel = true;
          }
          // Native work continues while the controller is dead. Wait for its real
          // lease, without changing SQLite ownership or expiry.
          if (Date.now() >= crash.at + 31000) {
            const before = await readJson(join(s.control, 'before-crash.json'));
            const result = await command(['continue', runId]);
            assert.equal(result.runId, runId);
            assert.notEqual(result.recovery?.status, 'blocked', JSON.stringify(result.recovery));
            await writeFile(join(s.control, 'crash-released'), '');
            evidence.crash = { ...crash, resumedAt: Date.now(), inputs: before.visits.filter(v => crash.inputIds.includes(v.inputId)).map(freeze) };
            crashResumed = true;
          }
        }
        if (state.status === 'failed' && await readJson(join(s.control, 'admission-failure.json')) && !failureResumed) {
          await writeJson(join(attempt.directory, 'failed-state.json'), state);
          failedSuccesses = state.visits.filter(v => v.verdict && v.implementId).map(freeze);
          assert(Object.values(state.implements.instances).filter(i => i.status === 'integrated').length >= 2);
          await writeFile(join(s.control, 'failure-released'), ''); // Restore only the injected environment fault.
          const result = await command(['continue', runId]);
          assert.equal(result.runId, runId);
          assert.notEqual(result.recovery?.status, 'blocked', JSON.stringify(result.recovery));
          evidence.failedRun = { runId, error: state.error, successes: failedSuccesses.map(v => v.inputId), continuedAt: Date.now() };
          failureResumed = true;
        } else if (state.status !== 'running' && state.status !== 'succeeded' && !failureResumed) {
          throw new Error(`Unexpected terminal run: ${state.status}: ${state.error}`);
        }
        if (state.status === 'succeeded') final = state;
      }
      if (tester.status !== 'running') {
        assert.equal(tester.status, 'succeeded', tester.error);
        if (final) break;
        // The harness may have resumed just as the tester received the injected
        // terminal observation. Ask it to continue its original public task, with
        // no graph/wire-schema advice and no manual message relay.
        if (failureResumed && !evidence.testerResumed) {
          evidence.testerResumed = true;
          await client.session.prompt({ sessionID: attempt.sessionId,
            text: `Контролируемая причина сбоя устранена, тот же запуск ${runId} продолжен. Доведи исходное поручение до проверенного результата.` });
        } else if (!failureResumed) throw new Error('Tester finished before completing the trial workflow.');
      }
      await pause(750);
    }
    assert(final && tester?.status === 'succeeded', 'Independent trial timed out.');
    assert(crashResumed && failureResumed && capturedParallel, 'Missing lifecycle interventions or parallel UI evidence.');
    await writeJson(join(attempt.directory, 'final-state.json'), final);
    await verifyTrialResult({ attempt, final, client, browser, evidence, failedSuccesses, settings, command, decision });
    evidence.outcome = 'passed'; evidence.runId = runId; evidence.finishedAt = Date.now();
    evidence.skill = JSON.parse(await readFile(join(attempt.directory, 'skill-evidence.json'), 'utf8'));
    await writeJson(join(settings.evidence, 'latest.json'), evidence);
    console.log(JSON.stringify({ outcome: evidence.outcome, runId, attempt: attempt.directory }));
    return evidence;
  } catch (error) {
    evidence.outcome = 'failed'; evidence.error = error.message; evidence.finishedAt = Date.now();
    await writeJson(join(settings.evidence, 'latest.json'), evidence);
    throw error;
  } finally {
    try { if (browser) await within(browser.close(), 15000, 'close trial browser'); }
    finally { await s.cleanupProcesses(); } // Keep raw trial files for independent inspection.
  }
}

export async function verifyTrialResult({ attempt, final, client, browser, evidence, failedSuccesses, settings, command, decision }) {
  const runId = final.id;
    assert.equal(final.definition.implements.concurrency, 2);
    const instances = Object.values(final.implements.instances);
    assert.equal(instances.length, 3);
    assert(instances.every(i => i.status === 'integrated'));
    for (const [nodeId, node] of Object.entries(final.definition.nodes)) {
      const selected = final.participants[nodeId].model;
      const expected = ['orchestrator', 'reviewer'].includes(node.role)
        ? { providerID: 'openai', id: 'gpt-6-astra', variant: 'xhigh' }
        : { providerID: 'openai', id: 'gpt-6.1-sol', variant: node.role === 'worker' ? 'high' : 'xhigh' };
      assert.deepEqual(selected, expected, `Wrong effective model for ${nodeId}`);
    }
    const tasks = final.definition.taskPackages;
    if (decision) {
    const revision = final.taskRevisions.find(r => r.taskId === decision.taskId && r.kind === 'decision' && r.text === decision.text);
    assert(revision?.source.startsWith('steer:'));
    const deliveredDecision = final.visits.find(v => v.taskId === decision.taskId && v.taskVersion >= revision.version &&
      v.taskContext?.task?.revisions?.some(r => r.source === revision.source && r.text === decision.text));
    assert(deliveredDecision?.admitted, 'Accepted decision was not delivered to its addressed input.');
    assert(final.taskRevisions.every(r => r.taskId === decision.taskId), 'Decision leaked into another task package.');
    }
    const dependent = tasks.find(t => t.dependencies.length === 2);
    assert(dependent, 'No dependent third task.');
    const dependentInstance = instances.find(i => i.taskId === dependent.id);
    const firstDependent = final.visits.find(v => v.implementId === dependentInstance.id);
    const integratedEvents = final.implements.events.filter(e => e.type === 'integrated');
    for (const taskId of dependent.dependencies) assert(integratedEvents.some(e => e.taskId === taskId && e.createdAt <= firstDependent.startedAt));
    assert(final.implements.events.some(e => e.type === 'conflict'), 'No actual integration conflict/return occurred.');
    const conflict = final.implements.events.find(e => e.type === 'conflict');
    const workers = final.visits.filter(v => v.implementId === conflict.implementId && final.definition.nodes[v.node]?.role === 'worker');
    assert(workers.length >= 2, 'Conflict was not returned to its worker.');
    assert.equal(new Set(workers.map(v => v.sessionId)).size, 1, 'Return replaced the worker session.');
    for (const prior of failedSuccesses) assert.deepEqual(freeze(final.visits.find(v => v.inputId === prior.inputId)), prior);
    for (const prior of evidence.crash.inputs) {
      const current = final.visits.find(v => v.inputId === prior.inputId);
      assert.equal(current.sessionId, prior.sessionId); assert.equal(current.prompt, prior.prompt);
      assert.deepEqual(current.taskContext, prior.taskContext);
    }
    const inputIds = final.visits.map(v => v.inputId);
    assert.equal(new Set(inputIds).size, inputIds.length);
    const nativeMessages = new Map();
    for (const sessionId of new Set(final.visits.filter(v => v.sessionId).map(v => v.sessionId))) {
      const messages = []; let cursor;
      do {
        const page = await client.message.list({ sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: 'asc' }) });
        messages.push(...page.data); cursor = page.data.length ? page.cursor.next : undefined;
      } while (cursor);
      nativeMessages.set(sessionId, messages);
      const users = messages.filter(m => m.type === 'user').map(m => m.id);
      assert.equal(new Set(users).size, users.length, 'Duplicate native input.');
      for (const visit of final.visits.filter(v => v.sessionId === sessionId && v.verdict)) assert.equal(users.filter(id => id === visit.inputId).length, 1);
      await writeJson(join(attempt.directory, `${sessionId}-inputs.json`), users);
    }
    for (const visit of final.visits.filter(v => v.taskId)) {
      const task = tasks.find(t => t.id === visit.taskId);
      assert.equal(visit.taskContext.task.requirements, task.requirements);
      assert.deepEqual(visit.taskContext.task.acceptanceCriteria, task.acceptanceCriteria);
    }
    await verifyOriginalTrialTests(settings.seed, attempt.workspace, attempt.directory);
    const tests = execFileSync(process.execPath, ['--test'], { cwd: attempt.workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    await writeFile(join(attempt.directory, 'acceptance-tests.log'), tests, { mode: 0o600 });
    const registry = JSON.parse(await readFile(join(attempt.workspace, 'registry.json'), 'utf8'));
    assert(registry.formatters.includes('label') && registry.formatters.includes('duration'));
    assert.equal(new Set(registry.formatters).size, registry.formatters.length);
    const lastCheck = final.visits.findLast(v => !v.implementId && final.definition.nodes[v.node]?.role === 'verifier');
    checkApprovals(final, lastCheck.revision);
    assert.equal(final.result.commit, git(attempt.workspace, ['rev-parse', 'HEAD']));
    assert.equal(git(attempt.workspace, ['status', '--porcelain']), '');
    const idleCount = final.visits.length;
    await command(['continue', runId]); await command(['continue', runId]);
    assert.equal(getWorkflow(attempt.stateDirectory, runId).visits.length, idleCount);
    const nativeIntervals = [];
    for (const taskId of dependent.dependencies) {
      const instance = instances.find(i => i.taskId === taskId);
      const visit = final.visits.find(v => v.implementId === instance.id && final.definition.nodes[v.node]?.role === 'worker');
      const messages = nativeMessages.get(visit.sessionId);
      const index = messages.findIndex(m => m.id === visit.inputId && m.type === 'user');
      const start = messages.slice(index + 1).find(m => m.type === 'assistant');
      const finish = messages.slice(index + 1).find(m => m.type === 'idle');
      assert(start?.time?.created && finish?.time?.created, 'No native execution interval.');
      nativeIntervals.push({ taskId, inputId: visit.inputId, sessionId: visit.sessionId,
        startedAt: start.time.created, completedAt: finish.time.created });
    }
    assert(Math.max(...nativeIntervals.map(i => i.startedAt)) < Math.min(...nativeIntervals.map(i => i.completedAt)),
      'The two independent workers did not really overlap.');
    evidence.nativeIntervals = nativeIntervals;
    if (browser) {
      await waitFor(() => browser.evaluate(`document.querySelector('#description')?.textContent.includes('succeeded')`), 15000, 'final succeeded UI');
      for (const [width, height] of [[1440, 1000], [390, 844]]) {
        await browser.viewport(width, height); await browser.evaluate(`document.querySelector('#fit').click()`); await browser.screenshot(join(attempt.directory, `final-${width}.png`));
      }
      await writeJson(join(attempt.directory, 'final-ui.json'), await browser.evaluate(`fetch('/api/runs').then(r=>r.json())`));
    }

}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(['seed', 'baseline', 'prompt-file', 'skill-directory', 'evidence'].map(name => [name, { type: 'string' }])) });
  for (const name of ['seed', 'baseline', 'prompt-file', 'skill-directory', 'evidence']) assert(values[name], `Missing --${name}`);
  await runTrial({ seed: resolve(values.seed), baseline: values.baseline, promptFile: resolve(values['prompt-file']),
    skillDirectory: resolve(values['skill-directory']), evidence: resolve(values.evidence) });
}
