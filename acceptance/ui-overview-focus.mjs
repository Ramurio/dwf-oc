// Controlled saved runtime; real candidate CLI/UI/Chrome in an isolated sandbox.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, waitFor } from './harness.mjs';
import { createWorkflow, claimWorkflow, updateWorkflow } from '../run-store.mjs';
import { implementUiFixture } from './ui-implement-fixture.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';
const cli=[process.execPath,fileURLToPath(new URL('../dwf.mjs',import.meta.url))];
const evidence=process.env.DWF_UI_EVIDENCE||await mkdtemp(join(tmpdir(),'dwf-overview-focus-'));
await mkdir(evidence,{recursive:true});
const sandbox=await createSandbox();let browser;
try {
  const state=implementUiFixture(8);state.workspace={path:sandbox.workspace};
  for(const [i,task] of state.definition.taskPackages.entries())task.title=`Task ${i+1}: Preserve the complete human-readable task title while navigating between independently reviewed implementation candidates`;
  createWorkflow(sandbox.state,state);assert.ok(claimWorkflow(sandbox.state,state.id,'overview-owner'));
  const ui=await cliJson(sandbox.spawn(cli,['ui','--start']),15000);browser=await openBrowser(ui.url);
  const check=expr=>waitFor(()=>browser.evaluate(expr),15000,expr);
  const click=selector=>browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  const measurements=[];
  await check(`document.querySelectorAll('[data-toggle-implement]').length===8`);
  for(const [width,height] of [[1440,1000],[390,844]]) {
    await browser.viewport(width,height);
    await click('#map [data-implement-overview="unit-0"]');
    await browser.evaluate(`document.querySelector('#inspector .close').focus()`);
    for(let i=0;i<8;i++) {
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'});
      await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab'});
    }
    const measure=`(() => {const picker=document.querySelector('.block-picker'),button=document.activeElement,p=picker.getBoundingClientRect(),r=button.getBoundingClientRect();return {selected:picker.querySelector('[aria-pressed="true"]').dataset.implementOverview,focused:button.dataset.implementOverview,top:picker.scrollTop,left:picker.scrollLeft,visible:picker.contains(button)&&r.top>=p.top-1&&r.bottom<=p.bottom+1&&r.left>=p.left-1&&r.right<=p.right+1};})()`;
    const before=await browser.evaluate(measure);
    assert.equal(before.focused,'unit-7');assert.equal(before.selected,'unit-0');
    assert.ok(before.top>0,'Keyboard navigation must actually scroll the internal task list');
    assert.equal(before.visible,true,'Last task is visible before refresh');
    const sequence=state.implements.events.length+1;
    state.implements.events.push({sequence,implementId:'unit-0',taskId:'task-0',type:'decision_rejected',createdAt:sequence,summary:'Controlled overview refresh'});
    updateWorkflow(sandbox.state,state,'overview-owner');
    await check(`document.querySelector('#inspector [data-detail-key="event-${sequence}"]')!==null`);
    const after=await browser.evaluate(measure);
    assert.equal(after.focused,before.focused,'Focus identity survives overview refresh');
    assert.equal(after.selected,before.selected,'Keyboard browsing does not activate another task');
    assert.equal(after.visible,true,`Last task remains visible after refresh at ${width}px`);
    assert.equal(after.top,before.top,'Preserve task-list vertical scroll');
    assert.equal(after.left,before.left,'Preserve task-list horizontal scroll');
    measurements.push({width,before,after});
    await browser.screenshot(join(evidence,`overview-focus-${width}.png`));
    await click('#inspector .close');
  }
  assert.deepEqual(browser.errors,[]);
  await writeFile(join(evidence,'overview-focus.json'),JSON.stringify({passed:true,measurements},null,2));
  console.log(JSON.stringify({passed:true,evidence}));
} finally {
  await browser?.close();await cliJson(sandbox.spawn(cli,['ui','--stop']),10000).catch(()=>{});await sandbox.cleanup();
}
