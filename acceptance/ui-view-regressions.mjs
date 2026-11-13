// Controlled saved records exercise view projection, not model execution.
// Real session entry remains covered separately by ui-browser.mjs.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, waitFor } from './harness.mjs';
import { createWorkflow, claimWorkflow, updateWorkflow } from '../run-store.mjs';
import { validateWorkflow } from '../workflow-definition.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';

const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const sandbox = await createSandbox();
const evidence = resolve('prototypes/dwf-ui/.evidence/view-regressions');
await mkdir(evidence, { recursive: true });
let browser;
try {
  const definition = validateWorkflow({ task: 'Прочитай MEASUREMENT_CONTEXT.md и проверь ' + 'W'.repeat(80), entry: 'r',
    nodes: { r: { role: 'reviewer' } }, groups: { batch: { members: ['r'] } },
    transitions: { r: { approve: 'batch', changes: null }, batch: { done: null, changes: null, failed: null } } });
  const state = { id: 'controlled-view', definition, status: 'running', createdAt: 1,
    workspace: { source: sandbox.workspace, path: sandbox.workspace }, sessions: {},
    visits: [{ node: 'r', participant: 'r', admitted: true, inputId: 'msg_solo', sessionId: 'ses_controlled', prompt: 'Standalone task' }] };
  createWorkflow(sandbox.state, state);
  assert.ok(claimWorkflow(sandbox.state, state.id, 'controlled-owner'));
  const ui = await cliJson(sandbox.spawn(cli, ['ui', '--start']), 15000);
  browser = await openBrowser(ui.url);
  const check = expression => waitFor(() => browser.evaluate(expression), 15000, expression);
  const click = selector => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await check(`document.querySelector('#run-id').textContent === 'controlled-view'`);
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await browser.viewport(width, height);
    if (await browser.evaluate(`!document.querySelector('#run-menu').open`)) await click('#run-menu > summary');
    assert.equal(await browser.evaluate(`(() => {
      const title = document.querySelector('[data-run="controlled-view"] strong');
      const card = title.closest('.run').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(title);
      return [...range.getClientRects()].every(rect => rect.left >= card.left && rect.right <= card.right);
    })()`), true, `Run title must wrap inside its card at ${width}px`);
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true,
      `Long run titles must not widen the page at ${width}px`);
    await browser.screenshot(resolve(evidence, `long-run-title-${width}.png`));
  }
  await browser.viewport(1440, 900);
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.node.active')].map(n => n.dataset.node)`), ['r']);
  assert.equal(await browser.evaluate(`document.querySelector('#current').textContent`), 'r is working');
  const geometry = `JSON.stringify([...document.querySelectorAll('[data-node]')].map(n => n.getAttribute('transform')))`;
  const initialGeometry = await browser.evaluate(geometry);

  const verdict = { outcome: 'approve', summary: 'Export headings are now escaped.',
    findings: [{ path: 'export.mjs', line: 8, summary: 'Verified heading escaping.' }], artifacts: ['verification.md'],
    extraEvidence: { checked: false, count: 0, literal: '<script>not executable</script>' } };
  state.visits[0].verdict = verdict;
  state.visits.push({ node: 'batch', children: [{ node: 'r', participant: 'r', admitted: true,
    inputId: 'msg_group', sessionId: 'ses_controlled', prompt: 'Grouped task' }] });
  updateWorkflow(sandbox.state, state, 'controlled-owner');
  await check(`document.querySelector('[data-node="batch"]').classList.contains('active')`);
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.node.active')].map(n => n.dataset.node)`), ['batch']);
  assert.equal(await browser.evaluate(`document.querySelector('#current').textContent`), 'r is working');
  assert.equal(await browser.evaluate(geometry), initialGeometry);
  await click('#current');
  assert.equal(await browser.evaluate(`document.querySelector('#detail-content .eyebrow').textContent`), 'batch / PARALLEL PARTICIPANT');
  assert.equal(await browser.evaluate(`document.querySelectorAll('.call-picker button').length`), 2);
  await click('.call-picker [data-invocation="0"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-result]').textContent`), verdict.summary);
  assert.ok((await browser.evaluate(`document.querySelector('.result-fields').innerText`)).includes('Findings'));
  await click('.result-fields details summary');
  assert.ok((await browser.evaluate(`document.querySelector('.result-fields').innerText`)).includes('Verified heading escaping.'));
  const source = await browser.evaluate(`document.querySelector('.result-source').open`);
  assert.equal(source, false, 'Raw envelope stays closed by default');
  await click('.result-source summary');
  assert.deepEqual(JSON.parse(await browser.evaluate(`document.querySelector('.result-source pre').textContent`)), verdict);
  assert.equal(await browser.evaluate(`document.querySelector('#command').value.includes('ses_controlled')`), true);
  assert.equal(await browser.evaluate(geometry), initialGeometry);
  state.visits[1].children[0].progress = { message: 'Controlled progress update' };
  updateWorkflow(sandbox.state, state, 'controlled-owner');
  await check(`fetch('/api/runs').then(r => r.json()).then(data => data.runs[0].graph.nodes.find(n => n.id === 'batch').participants[0].invocations[1].progress === 'Controlled progress update')`);
  // Wait for the page's own poll rather than treating the API request as a UI update.
  await check(`document.querySelector('#inspector .result-source').open && document.querySelector('.call-picker [aria-pressed=true]').dataset.invocation === '0'`);
  await browser.screenshot(resolve(evidence, 'shared-history-result.png'));

  state.status = 'succeeded';
  state.visits[1].children[0].verdict = { outcome: 'approve', summary: 'Grouped review complete.' };
  state.result = { outcome: 'done', summary: 'Workflow verified and integrated.', commit: 'controlled-commit', artifacts: ['verification.md'] };
  updateWorkflow(sandbox.state, state, 'controlled-owner', true);
  await check(`document.querySelector('#description').textContent.includes('succeeded')`);
  assert.equal(await browser.evaluate(`document.querySelector('#inspector .result-source').open`), true);
  assert.equal(await browser.evaluate(`document.querySelector('.call-picker [aria-pressed=true]').dataset.invocation`), '0');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-result]').textContent`), verdict.summary);
  await click('[data-close]');
  await click('#run-observations > summary');
  assert.equal(await browser.evaluate(`document.querySelector('#run-observations [data-result]').textContent`), state.result.summary);
  assert.ok((await browser.evaluate(`document.querySelector('#run-observations').innerText`)).includes('Commit'));
  assert.equal(await browser.evaluate(`document.querySelector('#run-observations .result-source').open`), false);
  await browser.screenshot(resolve(evidence, 'workflow-readable-result.png'));

  const special = { id: 'prototype-node', status: 'running', createdAt: 2, workspace: state.workspace, visits: [
    { node: 'toString', admitted: true, inputId: 'msg_prototype', sessionId: 'ses_prototype', prompt: 'Saved special-name task' }],
    definition: validateWorkflow({ task: 'Controlled prototype-name node', entry: 'toString',
      nodes: { toString: { role: 'reviewer' } }, transitions: { toString: { approve: null, changes: 'toString' } } }) };
  createWorkflow(sandbox.state, special);
  claimWorkflow(sandbox.state, special.id, 'special-owner');
  await check(`document.querySelector('[data-run="prototype-node"]') !== null`);
  await click('[data-run="prototype-node"]');
  assert.equal(await browser.evaluate(`document.querySelector('[data-node="toString"]').classList.contains('group')`), false);
  await click('[data-primitive="toString"]');
  assert.ok((await browser.evaluate(`document.querySelector('.role').textContent`)).includes('reviewer'));
  assert.equal(await browser.evaluate(`document.querySelector('[data-task]').textContent`), 'Saved special-name task');
  assert.ok((await browser.evaluate(`document.querySelector('#command').value`)).includes('ses_prototype'));
  assert.match(await browser.evaluate(`document.querySelector('[data-session-directory]').textContent`), /Unknown/);
  assert.equal(await browser.evaluate(`document.querySelector('[data-call-directory]').textContent`), sandbox.workspace);
  assert.equal(await browser.evaluate(`document.querySelector('[data-last-directory]').textContent`), sandbox.workspace);
  assert.match(await browser.evaluate(`document.querySelector('[data-directory-note]').textContent`), /Current directory is unknown/);
  const mapped = { id: 'mapped-steering', status: 'running', createdAt: 3, workspace: state.workspace,
    definition: validateWorkflow({ task: 'Controlled mapped steering', entry: 'seed',
      nodes: { seed: { role: 'orchestrator' }, template: { role: 'reviewer' } },
      groups: { batch: { member: 'template', items: [{ id: 'one' }] } },
      transitions: { seed: { done: 'batch' }, template: { approve: null, changes: null }, batch: { done: null, changes: null, failed: null } } }),
    visits: [{ node: 'template', participant: 'template', admitted: true, inputId: 'msg_original',
      sessionId: 'ses_original', prompt: 'Original standalone task', verdict: { outcome: 'approve', summary: 'Original standalone result' } },
      { node: 'batch', children: [{ node: 'template', participant: 'batch/one', admitted: true,
      inputId: 'msg_mapped', sessionId: 'ses_mapped', verdict: { outcome: 'approve', summary: 'Grouped result' } }] },
      { node: 'template', participant: 'batch/one', admitted: true, inputId: 'msg_steered', sessionId: 'ses_mapped', prompt: 'Steered mapped task' }] };
  createWorkflow(sandbox.state, mapped);
  claimWorkflow(sandbox.state, mapped.id, 'mapped-owner');
  await check(`document.querySelector('[data-run="mapped-steering"]') !== null`);
  await click('[data-run="mapped-steering"]');
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.node.active')].map(n => n.dataset.node)`), ['template']);
  assert.equal(await browser.evaluate(`document.querySelector('#current').textContent`), 'batch/one is working');
  await click('#current');
  assert.equal(await browser.evaluate(`document.querySelector('#detail-title').textContent`), 'batch/one');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-task]').textContent`), 'Steered mapped task');
  assert.equal(await browser.evaluate(`document.querySelectorAll('.call-picker button').length`), 2);
  await click('[data-close]');
  await click('[data-primitive="template"]');
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.member-picker [data-pick]')].map(b => b.dataset.pick)`), ['batch/one', 'template']);
  await click('[data-pick="template"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-task]').textContent`), 'Original standalone task');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-result]').textContent`), 'Original standalone result');
  assert.ok((await browser.evaluate(`document.querySelector('#command').value`)).includes("'ses_original'"));
  await browser.send('Browser.grantPermissions', { origin: ui.url, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await click('#copy');
  assert.equal(await browser.evaluate(`navigator.clipboard.readText()`), await browser.evaluate(`document.querySelector('#command').value`));
  await click('[data-pick="batch/one"]');
  await click('.call-picker [data-invocation="0"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-result]').textContent`), 'Grouped result');
  assert.ok((await browser.evaluate(`document.querySelector('#command').value`)).includes("'ses_mapped'"));
  await click('[data-close]');

  await click('[data-primitive="template"]');
  await click('[data-pick="template"]');

  // A prepared input is a selectable identity, not an observed call. It must
  // neither hide the earlier identities nor strand the inspector's empty view.
  mapped.visits[2].verdict = { outcome: 'approve', summary: 'Steered review complete' };
  mapped.visits.push({ node: 'template', participant: 'batch/pending', inputId: 'msg_pending', sessionId: 'ses_pending' });
  updateWorkflow(sandbox.state, mapped, 'mapped-owner');
  await check(`document.querySelector('.member-picker [data-pick="batch/pending"]') !== null`);
  assert.equal(await browser.evaluate(`document.querySelector('#detail-title').textContent`), 'template');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-result]').textContent`), 'Original standalone result');
  await click('[data-close]');
  await click('[data-primitive="template"]');
  assert.equal(await browser.evaluate(`document.querySelector('#detail-title').textContent`), 'batch/one');
  await click('[data-pick="batch/pending"]');
  assert.equal(await browser.evaluate(`document.querySelector('#command')`), null);
  assert.ok((await browser.evaluate(`document.querySelector('#detail-content').textContent`)).includes('No recorded invocation'));
  assert.equal(await browser.evaluate(`document.querySelectorAll('.member-picker [data-pick]').length`), 3);
  await click('[data-pick="template"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-task]').textContent`), 'Original standalone task');
  assert.ok((await browser.evaluate(`document.querySelector('#command').value`)).includes("'ses_original'"));
  await click('[data-close]');
  await click('[data-primitive="template"]');
  await click('[data-pick="template"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector [data-result]').textContent`), 'Original standalone result');
  await browser.screenshot(resolve(evidence, 'standalone-identities.png'));
  assert.deepEqual(browser.errors, []);
  console.log('View regressions passed: actual active platform, unique summary/current navigation, shared history, readable results, prototype-name nodes and selectable standalone identities (including prepared inputs).');
} finally {
  await browser?.close();
  await cliJson(sandbox.spawn(cli, ['ui', '--stop']), 10000).catch(() => {});
  await sandbox.cleanup();
}
