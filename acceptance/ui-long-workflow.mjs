// Reproduce the narrow-screen defects observed in the independent live trial.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, waitFor } from './harness.mjs';
import { createWorkflow, claimWorkflow } from '../run-store.mjs';
import { implementUiFixture } from './ui-implement-fixture.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';
const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
const s = await createSandbox(); let browser;
const evidence = process.env.DWF_UI_EVIDENCE || join(s.root, 'evidence');
await mkdir(evidence, { recursive: true });
try {
  const state = implementUiFixture(3); state.workspace = { path: s.workspace };
  state.definition.task = 'Изучи проект. Запусти DWF, который выполнит три задачи из TASKS.md: label и duration параллельно, report — после их результатов. Работу выполняют участники DWF.';
  createWorkflow(s.state, state); assert(claimWorkflow(s.state, state.id, 'long-title-test'));
  const ui = await cliJson(s.spawn(cli, ['ui', '--start']), 15000);
  browser = await openBrowser(ui.url);
  await waitFor(() => browser.evaluate(`document.querySelectorAll('[data-toggle-implement]').length===3`), 15000, 'long title graph');
  const measurements = [];
  for (const [width, height] of [[390, 844], [1440, 1000]]) {
    await browser.viewport(width, height);
    const geometry = await browser.evaluate(`(() => {
      const summary=document.querySelector('#run-menu summary'), range=document.createRange();range.selectNodeContents(summary.firstChild);
      const zoom=document.querySelector('.zoom-controls').getBoundingClientRect(),tools=document.querySelector('.map-tools').getBoundingClientRect(),nav=document.querySelector('#task-navigation').getBoundingClientRect();
      return {labelLines:range.getClientRects().length,zoomTop:zoom.top,zoomBottom:zoom.bottom,toolsTop:tools.top,toolsBottom:tools.bottom,navTop:nav.top,pageOverflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    await browser.screenshot(join(evidence, `long-workflow-${width}.png`));
    if (width === 390) assert.equal(geometry.labelLines, 1, 'Runs must remain one word, not four vertically stacked letters.');
    assert(geometry.zoomTop >= geometry.toolsTop - 1 && geometry.zoomBottom <= geometry.toolsBottom + 1, 'Zoom controls must fit inside their toolbar.');
    assert(geometry.zoomBottom <= geometry.navTop + 1, 'Zoom controls must not overlap task navigation.');
    assert.equal(geometry.pageOverflow, false);
    measurements.push({ width, ...geometry });
  }
  assert.deepEqual(browser.errors, []);
  await writeFile(join(evidence, 'long-workflow.json'), JSON.stringify({ passed: true, measurements }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence }));
} finally {
  await browser?.close(); await s.cleanupProcesses();
}
