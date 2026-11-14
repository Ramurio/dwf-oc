// Re-open the ACTUAL completed independent run with current browser assets.
// No fabricated state or model invocation, and no controller/database edits.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, waitFor } from './harness.mjs';
import { getWorkflow } from '../run-store.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';

export async function verifyTrialUi(attemptDirectory, evidenceDirectory) {
  const attempt = JSON.parse(await readFile(join(attemptDirectory, 'attempt.json'), 'utf8'));
  const saved = JSON.parse(await readFile(join(attemptDirectory, 'final-state.json'), 'utf8'));
  const state = getWorkflow(attempt.stateDirectory, saved.id);
  assert.equal(state.status, 'succeeded');
  assert.deepEqual(state.implements, saved.implements);
  const s = await createSandbox(); let browser;
  const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
  s.env.DWF_STATE_DIR = attempt.stateDirectory;
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  try {
    const ui = await cliJson(s.spawn(cli, ['ui', '--start']), 20000);
    browser = await openBrowser(ui.url + '?run=' + state.id);
    await waitFor(() => browser.evaluate(`document.querySelectorAll('[data-toggle-implement]').length===3 && document.querySelector('#description').textContent.includes('succeeded')`), 15000, 'completed live trial UI');
    const api = await browser.evaluate(`fetch('/api/runs').then(r=>r.json())`);
    const view = api.runs.find(r => r.id === state.id);
    const hub = view.graph.nodes.find(n => n.id === 'implements');
    assert.equal(hub.instances.length, 3);
    assert(hub.instances.every(i => i.status === 'integrated'));
    for (const participant of hub.participants) for (const call of participant.invocations) {
      const visit = state.visits.find(v => v.inputId === call.id);
      assert(visit); assert.deepEqual(call.taskData, visit.taskContext);
      assert.equal(call.promptRaw, visit.prompt);
    }
    await writeFile(join(evidenceDirectory, 'actual-ui.json'), JSON.stringify(api), { mode: 0o600 });
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      await browser.viewport(width, height);
      await browser.evaluate(`document.querySelector('#fit').click()`);
      await browser.screenshot(join(evidenceDirectory, `actual-final-fit-${width}.png`));
    }
    const conflict = state.implements.events.find(e => e.type === 'conflict');
    assert(conflict);
    const worker = hub.participants.find(p => p.id === `${conflict.implementId}/worker`);
    assert(worker.invocations.length >= 2);
    const task = state.definition.taskPackages.find(t => t.id === worker.invocations.at(-1).taskData.task.id);
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      await browser.viewport(width, height);
      await browser.evaluate(`document.querySelector('[data-jump-implement="${conflict.implementId}"]').click(); document.querySelector('[data-participant="${worker.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
      assert.equal(await browser.evaluate(`document.querySelector('[data-task]').textContent`), task.requirements);
      assert.equal(await browser.evaluate(`document.querySelectorAll('.call-picker button').length`), worker.invocations.length);
      assert.equal(await browser.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      await browser.screenshot(join(evidenceDirectory, `actual-returned-worker-${width}.png`));
      await browser.evaluate(`document.querySelector('#inspector .close').click()`);
    }
    assert.deepEqual(browser.errors, []);
    const result = { passed: true, runId: state.id, calls: hub.participants.reduce((n, p) => n + p.invocations.length, 0),
      conflictWorker: worker.id, conflictWorkerCalls: worker.invocations.length, evidenceDirectory };
    await writeFile(join(evidenceDirectory, 'verified-ui.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result)); return result;
  } finally {
    try { await browser?.close(); } finally { await s.cleanup(); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.argv[2] && process.argv[3], 'Usage: node acceptance/context-implement-ui.mjs <attempt-directory> <evidence-directory>');
  await verifyTrialUi(resolve(process.argv[2]), resolve(process.argv[3]));
}
