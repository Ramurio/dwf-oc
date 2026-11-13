// Browser checks of controlled saved runtime records. Native execution is checked
// separately in implements.test.mjs; this deliberately includes hard-to-hold states.
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
const evidence=process.env.DWF_UI_EVIDENCE||await mkdtemp(join(tmpdir(),'dwf-implement-ui-'));
await mkdir(evidence,{recursive:true});
const sandbox=await createSandbox();let browser;
try {
  const states=[];
  for(const count of [2,8]) {
    const state=implementUiFixture(count);state.id=`controlled-${count}-implements`;
    state.workspace={path:sandbox.workspace,source:sandbox.workspace};state.definition.task=`${count} independent implement tasks`;
    if(count===8)state.definition.taskPackages[2].dependencies=['task-0'];
    state.definition.taskPackages[0].title='Export safe headings and preserve the exception callback with a deliberately long human-readable label';
    const statuses=count===2?['running','running']:['running','running','queued','blocked','conflict','changes_requested','ready','integrated'];
    const phases=['worker','reviewer','worker','worker','worker','worker','verifier','verifier'];
    for(const [i,instance] of Object.values(state.implements.instances).entries()) {
      Object.assign(instance,{status:statuses[i],phase:phases[i],cycle:i===5?2:1});
      if(i===4)instance.integration={status:'conflict',error:'Conflicting edits to shared.txt; both candidates were retained',conflicts:['shared.txt']};
      if(i===6||i===7)instance.result={outcome:'done',summary:`Verified result ${i}`};
      for(const role of ['worker','reviewer','verifier']) {
        const calls=role==='worker'&&i===0?14:1;
        for(let cycle=1;cycle<=calls;cycle++) {
          const task=state.definition.taskPackages[i],inputId=`msg_${count}_${i}_${role}_${cycle}`;
          const isCurrent=instance.status==='running'&&role===instance.phase&&cycle===calls;
          const outcome=i===3?'blocked':i===5?'changes':role==='worker'?'done':'approve';
          const verdict={outcome,summary:i===3?'Which API version should be supported?':i===5?'Return to worker: preserve the callback.':`Saved ${role} result · cycle ${cycle}`,...(i===3?{questions:['Use API v1 or v2?']}:{})};
          const taskContext={formatVersion:1,task,implement:{id:instance.id,cycle},assignment:{instructions:`Perform ${role} checks`,implement:{text:'Escape headings without changing callback behavior'}},otherReports:{handoff:{outcome:'changes',summary:'Preserve the callback on the exception path'}}};
          state.visits.push({node:{worker:'work',reviewer:'review',verifier:'verify'}[role],participant:`${instance.id}/${role}`,implementId:instance.id,item:{taskId:task.id},taskId:task.id,taskVersion:1,cycle,
            admitted:true,inputId,sessionId:`ses_${count}_${i}_${role}`,startedAt:1000+cycle,prompt:'Full original technical prompt; NOT A HUMAN TITLE',taskContext,...(isCurrent?{progress:{message:'Controlled work in progress'}}:{verdict}),...(i===4&&role==='worker'?{error:'Integration stopped: conflicting shared.txt'}:{})});
          if(isCurrent)instance.currentInputId=inputId;
        }
      }
      state.implements.events.push({sequence:i+1,implementId:instance.id,taskId:instance.taskId,type:instance.status==='changes_requested'?'changes':instance.status,createdAt:1000});
    }
    createWorkflow(sandbox.state,state);assert.ok(claimWorkflow(sandbox.state,state.id,'ui-test-owner'));states.push(state);
  }
  const ui=await cliJson(sandbox.spawn(cli,['ui','--start']),15000);
  browser=await openBrowser(ui.url+'?run=controlled-8-implements');
  const check=expr=>waitFor(()=>browser.evaluate(expr),15000,expr);
  const click=selector=>browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await check(`document.querySelectorAll('[data-toggle-implement]').length===8`);
  assert.equal(await browser.evaluate(`document.querySelector('#current').textContent`),'2 participants are working');
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('.implement-card.active')].map(n=>n.dataset.implement)`),['unit-0','unit-1']);
  for(const [width,height] of [[1440,1000],[390,844]]) {
    await browser.viewport(width,height);
    await click('#fit');
    await browser.screenshot(join(evidence,`eight-overview-${width}.png`));
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  }
  await click('[data-jump-implement="unit-0"]');
  await browser.screenshot(join(evidence,'eight-focused-narrow.png'));
  await click('[data-toggle-implement="unit-0"]');
  await browser.viewport(1440,1000);
  // True keyboard activation of independent SVG disclosures.
  await browser.evaluate(`document.querySelector('[data-toggle-implement="unit-0"]').focus()`);
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter'});
  await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter'});
  await click('[data-toggle-implement="unit-1"]');
  assert.equal(await browser.evaluate(`document.querySelectorAll('[aria-expanded="true"][data-toggle-implement]').length`),2);
  assert.equal(await browser.evaluate(`document.querySelectorAll('.implement-card .participant').length`),6);
  // Compare painted text and card bounds, independent of layout calculations.
  assert.equal(await browser.evaluate(`(() => {
    const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
    const cards=[...document.querySelectorAll('.implement-card')];
    for(const [i,card] of cards.entries()) {
      const surface=card.querySelector('.block-surface').getBoundingClientRect();
      const texts=[...card.querySelectorAll('text')].map(t=>t.getBoundingClientRect());
      if(texts.some(r=>r.left<surface.left-1||r.right>surface.right+1||r.top<surface.top-1||r.bottom>surface.bottom+1))return false;
      if(texts.some((a,j)=>texts.slice(j+1).some(b=>overlap(a,b))))return false;
      if(cards.slice(i+1).some(b=>overlap(surface,b.querySelector('.block-surface').getBoundingClientRect())))return false;
    }return true;
  })()`),true,'Painted cards and text must not overlap or escape');
  assert.equal(await browser.evaluate(`document.querySelector('[data-implement="unit-2"]').textContent.includes('dependencies')`),true);
  await click('#zoom-reset');
  await browser.evaluate(`document.querySelector('[data-implement="unit-0"]').scrollIntoView({block:'start',inline:'center'})`);
  await browser.screenshot(join(evidence,'eight-expanded-wide.png'));
  await click('[data-participant="unit-0/worker"]');
  await click('.call-picker [data-invocation="0"]');
  await click('[data-detail-key="technical-prompt"] summary');
  await browser.evaluate(`document.querySelector('[data-detail-key="technical-prompt"] summary').focus()`);
  const firstResult=await browser.evaluate(`document.querySelector('[data-result]').textContent`);
  assert.equal(await browser.evaluate(`document.querySelector('.assignment').textContent.includes('Preserve the callback on the exception path')`),true);
  assert.equal(await browser.evaluate(`document.querySelector('[data-task]').textContent`),'Exact requirements 0');
  states[1].visits[0].progress={message:'Refresh marker'};
  updateWorkflow(sandbox.state,states[1],'ui-test-owner');
  await check(`fetch('/api/runs').then(r=>r.json()).then(d=>d.runs.find(r=>r.id==='controlled-8-implements').graph.nodes.find(n=>n.id==='implements').participants[0].invocations[0].progress==='Refresh marker')`);
  // Wait for a page refresh, then check all independent pieces of view state.
  await check(`document.querySelector('#connection').textContent.includes('Connected') && document.querySelector('[data-detail-key="technical-prompt"]').open`);
  await new Promise(r=>setTimeout(r,1600));
  assert.equal(await browser.evaluate(`document.activeElement.parentElement.dataset.detailKey`),'technical-prompt');
  assert.equal(await browser.evaluate(`document.querySelector('.call-picker [aria-pressed="true"]').dataset.invocation`),'0');
  assert.equal(await browser.evaluate(`document.querySelector('[data-result]').textContent`),firstResult);
  assert.equal(await browser.evaluate(`document.querySelectorAll('[aria-expanded="true"][data-toggle-implement]').length`),2);
  for(const [width,height] of [[1440,1000],[390,844]]) {
    await browser.viewport(width,height);
    await browser.evaluate(`document.querySelector('#inspector').scrollTop=0`);
    await browser.screenshot(join(evidence,`call-history-${width}.png`));
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  }
  // Keyboard traversal stays inside the modal and outside its sticky header.
  for(const shift of [false,true])for(let step=0;step<12;step++) {
    await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',modifiers:shift?8:0});
    await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',modifiers:shift?8:0});
    await check(`(() => {
      const dialog=document.querySelector('#inspector'),el=document.activeElement,header=dialog.querySelector('.detail-top');
      if(!dialog.contains(el))return false;
      const r=el.getBoundingClientRect(),frame=dialog.getBoundingClientRect();
      return r.left>=frame.left && r.right<=frame.right && (header.contains(el)||r.top>=header.getBoundingClientRect().bottom) && r.bottom<=frame.bottom;
    })()`);
  }
  // A recorded correction can insert an invocation before the selected call.
  // Selection and keyboard focus follow input identity, not its former index.
  await click('.call-picker [data-invocation="13"]');
  const selectedCall=await browser.evaluate(`document.querySelector('.call-picker [aria-pressed="true"]').dataset.callId`);
  states[1].visits[0].correction={inputId:'msg_corrected_earlier',prompt:'Exact correction input'};
  updateWorkflow(sandbox.state,states[1],'ui-test-owner');
  await check(`document.querySelectorAll('.call-picker button').length===15`);
  assert.equal(await browser.evaluate(`document.querySelector('.call-picker [aria-pressed="true"]').dataset.callId`),selectedCall);
  assert.equal(await browser.evaluate(`document.activeElement.dataset.callId`),selectedCall);
  await click('[data-close]');
  await click('[data-implement-overview="unit-3"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector').textContent.includes('Use API v1 or v2?')`),true);
  await browser.screenshot(join(evidence,'question-narrow.png'));
  await click('#inspector [data-implement-overview="unit-4"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector').textContent.includes('conflict')`),true);
  assert.equal(await browser.evaluate(`document.querySelector('#inspector').textContent.includes('Integration stopped: conflicting shared.txt')`),true);
  await browser.screenshot(join(evidence,'conflict-error-narrow.png'));
  await click('#inspector [data-implement-overview="unit-5"]');
  assert.equal(await browser.evaluate(`document.querySelector('#inspector').textContent.includes('Return to worker')`),true);
  await browser.screenshot(join(evidence,'return-narrow.png'));
  await click('[data-close]');
  await browser.viewport(1440,1000);
  if(!await browser.evaluate(`document.querySelector('#run-menu').open`))await click('#run-menu>summary');
  await click('[data-run="controlled-2-implements"]');
  assert.equal(await browser.evaluate(`document.querySelectorAll('[data-toggle-implement]').length`),2);
  for(const id of ['unit-0','unit-1'])await click(`[data-toggle-implement="${id}"]`);
  for(const [width,height] of [[1440,1000],[390,844]]) {
    await browser.viewport(width,height);await click('#fit');
    await browser.screenshot(join(evidence,`two-expanded-${width}.png`));
  }
  await click('[data-jump-implement="unit-1"]');
  const viewportBefore=await browser.evaluate(`JSON.stringify([document.querySelector('#map-viewport').scrollLeft,document.querySelector('#map-viewport').scrollTop,document.querySelector('#map').style.width])`);
  states[0].visits.find(v=>v.participant==='unit-1/reviewer').progress={message:'Map refresh marker'};
  updateWorkflow(sandbox.state,states[0],'ui-test-owner');
  await new Promise(r=>setTimeout(r,1700));
  assert.equal(await browser.evaluate(`document.activeElement.dataset.jumpImplement`),'unit-1');
  assert.equal(await browser.evaluate(`JSON.stringify([document.querySelector('#map-viewport').scrollLeft,document.querySelector('#map-viewport').scrollTop,document.querySelector('#map').style.width])`),viewportBefore);
  assert.deepEqual(browser.errors,[]);
  await writeFile(join(evidence,'checks.json'),JSON.stringify({passed:true,source:'controlled saved runtime records',checks:['two/eight blocks','parallel activity','explicit titles','independent expansion','question/error/conflict/return','long history','structured fields','keyboard disclosure','refresh selection/focus','wide/narrow overflow'],screenshots:11},null,2));
  console.log(JSON.stringify({evidence,passed:true}));
} finally {
  await browser?.close();
  await cliJson(sandbox.spawn(cli,['ui','--stop']),10000).catch(()=>{});
  await sandbox.cleanup();
}
