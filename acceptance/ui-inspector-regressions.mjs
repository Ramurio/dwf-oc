// Controlled saved calls exercise inspector refresh; no developer service used.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, waitFor } from './harness.mjs';
import { createWorkflow, claimWorkflow, updateWorkflow } from '../run-store.mjs';
import { validateWorkflow } from '../workflow-definition.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';
const cli=[process.execPath,fileURLToPath(new URL('../dwf.mjs',import.meta.url))];
const evidence=process.env.DWF_UI_EVIDENCE||await mkdtemp(join(tmpdir(),'dwf-inspector-regressions-'));
await mkdir(evidence,{recursive:true});
const sandbox=await createSandbox();let browser;
try {
  const state={id:'inspector-regressions',createdAt:1,status:'running',sessions:{},workspace:{path:sandbox.workspace},
    definition:validateWorkflow({task:'Review inspector history and keyboard continuity',entry:'work',nodes:{work:{role:'worker'},review:{role:'reviewer'},verify:{role:'verifier'}},
      transitions:{work:{done:'review'},review:{approve:'verify',changes:'work'},verify:{approve:null,changes:'work'}}}),
    visits:Array.from({length:14},(_,i)=>({node:'work',participant:'work',admitted:true,inputId:`msg_${i}`,sessionId:'ses_same',startedAt:1000+i,prompt:`Saved input ${i}`,
      ...(i===13?{progress:{message:'Initial progress'}}:{verdict:{outcome:'done',summary:`Result ${i}`}})}))};
  createWorkflow(sandbox.state,state);assert.ok(claimWorkflow(sandbox.state,state.id,'inspector-owner'));
  const ui=await cliJson(sandbox.spawn(cli,['ui','--start']),15000);browser=await openBrowser(ui.url);
  const check=expr=>waitFor(()=>browser.evaluate(expr),15000,expr);
  const click=selector=>browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await check(`document.querySelector('[data-primitive="work"]')!==null`);
  const selectedVisible=`(() => {const picker=document.querySelector('.call-picker'),selected=picker.querySelector('[aria-pressed="true"]'),p=picker.getBoundingClientRect(),r=selected.getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1;})()`;
  let sequence=0;
  const refresh=async()=>{
    const marker=`Refresh ${++sequence}`;
    state.visits.at(-1).progress={message:marker};updateWorkflow(sandbox.state,state,'inspector-owner');
    await check(`document.querySelector('.live-progress')?.textContent===${JSON.stringify(marker)}`);
  };
  for(const scenario of process.argv[2]?[process.argv[2]]:['history','focus-history','close','back']) {
    for(const [width,height] of [[1440,1000],[390,844]]) {
      await browser.viewport(width,height);
      if(!await browser.evaluate(`document.querySelector('#inspector').open`))await browser.evaluate(`document.querySelector('[data-primitive="work"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
      if(scenario==='history') {
        assert.equal(await browser.evaluate(selectedVisible),true,`Latest call visible on opening at ${width}px`);
        await browser.evaluate(`document.querySelector('.call-picker').scrollLeft=document.querySelector('.call-picker').scrollWidth`);
        await click('.call-picker [data-invocation="13"]');
        assert.equal(await browser.evaluate(selectedVisible),true,`14th selected call visible after selection at ${width}px`);
        const left=await browser.evaluate(`document.querySelector('.call-picker').scrollLeft`);
        assert.ok(left>0,'The long history must actually be scrolled');
        await refresh();
        assert.equal(await browser.evaluate(`document.querySelector('.call-picker').scrollLeft`),left,'Keep horizontal history position across refresh');
        assert.equal(await browser.evaluate(selectedVisible),true,'Selected call remains visible after refresh');
        assert.equal(await browser.evaluate(`document.activeElement.dataset.callId`),'msg_13');
      } else if(scenario==='focus-history') {
        // Tab moves focus without changing the selected input. Native keyboard
        // scrolling reveals the first call while the fourteenth stays selected.
        await browser.evaluate(`document.querySelector('#inspector .close').focus()`);
        await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'});
        await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab'});
        const focusedVisible=`(() => {const picker=document.querySelector('.call-picker'),p=picker.getBoundingClientRect(),r=document.activeElement.getBoundingClientRect();return picker.contains(document.activeElement)&&r.left>=p.left-1&&r.right<=p.right+1;})()`;
        assert.equal(await browser.evaluate(`document.activeElement.dataset.callId`),'msg_0');
        assert.equal(await browser.evaluate(focusedVisible),true,'Keyboard-focused first call is initially visible');
        const left=await browser.evaluate(`document.querySelector('.call-picker').scrollLeft`);
        await refresh();
        assert.equal(await browser.evaluate(`document.querySelector('.call-picker [aria-pressed="true"]').dataset.callId`),'msg_13','Refresh does not change the selected call');
        assert.equal(await browser.evaluate(`document.activeElement.dataset.callId`),'msg_0','Refresh does not change the focused call');
        assert.equal(await browser.evaluate(focusedVisible),true,`Focused first call remains visible after refresh at ${width}px`);
        assert.equal(await browser.evaluate(`document.querySelector('.call-picker').scrollLeft`),left,'Preserve the keyboard browsing viewport');
      } else {
        const selector=scenario==='close'?'#inspector .close':'#inspector .back-map';
        await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        await refresh();
        assert.equal(await browser.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true,`${scenario} keeps focus at ${width}px`);
      }
      await browser.screenshot(join(evidence,`inspector-${scenario}-${width}.png`));
      await click('#inspector .close');
    }
  }
  assert.deepEqual(browser.errors,[]);
  await writeFile(join(evidence,'inspector-regressions.json'),JSON.stringify({passed:true,checks:['14th call visible on open and selection','horizontal history position and selection visible after refresh','different selected/focused calls retain selection, focus and browsing viewport','header Close focus retained','Back to map focus retained'],viewports:[1440,390]},null,2));
  console.log(JSON.stringify({passed:true,evidence}));
} finally {
  await browser?.close();await cliJson(sandbox.spawn(cli,['ui','--stop']),10000).catch(()=>{});await sandbox.cleanup();
}
