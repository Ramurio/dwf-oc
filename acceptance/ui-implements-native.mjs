// Real candidate CLI + native sessions/tools + Git. Only model replies are
// controlled. All services/profiles/processes belong to disposable sandboxes.
import assert from 'node:assert/strict';
import { currentContext, wireContext } from './context-delivery.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, waitFor, writeJson, transcript } from './harness.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { implementUiFixture } from './ui-implement-fixture.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';
const cli=[process.execPath,fileURLToPath(new URL('../dwf.mjs',import.meta.url))];
const evidence=process.env.DWF_UI_EVIDENCE||await mkdtemp(join(tmpdir(),'dwf-native-implement-ui-'));
await mkdir(evidence,{recursive:true});
const result=(outcome,summary,extra={})=>JSON.stringify({outcome,summary,...extra});
for(const count of [2,8]) {
  const sandbox=await createSandbox();let provider,browser;
  try {
    const definition=implementUiFixture(count).definition;
    definition.task=`Implement ${count} independently verified text files`;
    definition.implements.concurrency=count;
    provider=await createControlledHttpProvider({directory:sandbox.control,token:sandbox.token,reply:({prompt,toolResults})=>{
      const data=currentContext(prompt);
      if(data.role==='orchestrator') {
        const instances=data.implements.instances;
        if(instances.every(i=>i.status==='integrated'))return result('finish','All tasks integrated');
        return result('dispatch','Run and integrate independent tasks',{implements:instances.flatMap(i=>i.status==='pending'?[{action:'admit',id:i.id,assignment:`Write ${i.id}.txt with ${i.id}`}]:i.status==='ready'?[{action:'integrate',id:i.id}]:[])});
      }
      if(data.implement) {
        const id=data.implement.id;
        if(data.role==='worker'&&!toolResults.some(t=>t.includes('file-written')))return {toolCalls:[{name:'shell',arguments:{command:`printf '${id}' > ${id}.txt; echo file-written`}}]};
        if(data.role==='reviewer'&&id==='unit-0'&&data.implement.cycle===1)return result('changes','Recheck the exact file content before integration.');
        if(data.role==='verifier'&&!toolResults.some(t=>t.includes('file-verified')))return {toolCalls:[{name:'shell',arguments:{command:`test "$(cat ${id}.txt)" = ${id} && echo file-verified`}}]};
      }
      return result(data.role==='worker'?'done':'approve','Checked the exact task candidate');
    }});
    const isolated=join(sandbox.root,'native-isolated');await mkdir(isolated);
    Object.assign(sandbox.env,{OPENCODE_TEST_HOME:isolated,OPENCODE_CONFIG_DIR:join(isolated,'config'),XDG_CONFIG_HOME:join(isolated,'config'),XDG_DATA_HOME:join(isolated,'data'),XDG_CACHE_HOME:join(isolated,'cache'),XDG_STATE_HOME:join(isolated,'state'),OPENCODE_CONFIG:join(sandbox.root,'provider.json'),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_FILEWATCHER:'true',OPENCODE_DISABLE_FFF:'true',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',DWF_PLANNER_MODEL:JSON.stringify({provider:'dwf-acceptance',modelId:'planner'}),DWF_PLANNER_REASONING:'high'});
    delete sandbox.env.OPENCODE_CONFIG_CONTENT;
    await writeJson(sandbox.env.OPENCODE_CONFIG,nativeProviderConfig(provider.baseURL));
    // Deltas require a readable pinned fallback; shell-only workers correctly get snapshots.
    definition.roles.worker.tools=['shell','read'];
    definition.nodes.verify.tools=['shell'];
    for(const args of [['init','-b','main'],['config','user.name','Test'],['config','user.email','test@example.invalid'],['add','.'],['commit','-m','base']])execFileSync('git',args,{cwd:sandbox.workspace,env:sandbox.env,stdio:'pipe'});
    const file=join(sandbox.root,'workflow.json');await writeJson(file,definition);
    const command=async args=>{const process=sandbox.spawn(cli,args);try{return await cliJson(process,20000);}catch(error){throw new Error(error.message+': '+process.stderr+' '+process.stdout);}};
    const {runId}=await command(['start','--file',file]);
    // Release only the manager, leaving genuinely concurrent native workers held.
    const initial=await waitFor(async()=>{const calls=(await transcript(join(sandbox.control,'provider.jsonl'))).filter(e=>e.type==='received');return calls.length&&calls;},20000,'initial native controller');
    await writeJson(join(sandbox.control,'release.json'),{token:sandbox.token,callIds:initial.map(c=>c.callId)});
    // Last package has an explicit dependency, so one queued block remains visible.
    const active=count===2?2:7;
    await waitFor(async()=>{const view=await command(['inspect',runId]);return view.implements.instances.filter(i=>i.status==='running'&&i.current?.status==='admitted').length===active;},30000,'native parallel implement admissions');
    const ui=await command(['ui','--start']);browser=await openBrowser(ui.url+'?run='+runId);
    await waitFor(()=>browser.evaluate(`document.querySelectorAll('[data-toggle-implement]').length===${count}`),15000,'native UI blocks');
    assert.equal(await browser.evaluate(`document.querySelectorAll('.implement-card.active').length`),active);
    for(const [width,height] of [[1440,1000],[390,844]]) {
      await browser.viewport(width,height);
      await browser.evaluate(`document.querySelector('#fit').click()`);
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
      await browser.screenshot(join(evidence,`native-${count}-parallel-${width}.png`));
    }
    await browser.evaluate(`document.querySelector('[data-jump-implement="unit-0"]').click()`);
    await browser.screenshot(join(evidence,`native-${count}-focused-390.png`));
    await writeJson(join(sandbox.control,'release.json'),{token:sandbox.token,all:true});
    const final=await waitFor(async()=>{const v=await command(['inspect',runId]);return v.status!=='running'&&v;},60000,'native implementation completion');
    assert.equal(final.status,'succeeded');assert(final.implements.instances.every(i=>i.status==='integrated'));
    await waitFor(()=>browser.evaluate(`document.querySelector('#description').textContent.includes('succeeded')`),15000,'final UI projection');
    await browser.viewport(1440,1000);
    await browser.evaluate(`if(document.querySelector('[data-toggle-implement="unit-0"]').getAttribute('aria-expanded')!=='true')document.querySelector('[data-toggle-implement="unit-0"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.querySelector('[data-participant="unit-0/worker"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
    assert.equal(await browser.evaluate(`document.querySelectorAll('.call-picker button').length`),2);
    assert.equal(await browser.evaluate(`document.querySelector('[data-session]').textContent===document.querySelector('[data-previous-session]').textContent`),true);
    const returned = await browser.evaluate(`fetch('/api/runs').then(r=>r.json()).then(d=>d.runs.find(r=>r.id==='${runId}').graph.nodes.find(n=>n.id==='implements').participants.find(p=>p.id==='unit-0/worker').invocations.at(-1))`);
    assert.equal(returned.contextDelivery.mode,'delta');
    assert.equal(returned.contextDelivery.acknowledged,true);
    assert.equal(wireContext(returned.promptRaw).delivery.mode,'delta');
    assert.equal(returned.taskData.task.title,definition.taskPackages[0].title);
    assert.equal(returned.taskData.task.requirements,definition.taskPackages[0].requirements);
    assert.equal(returned.taskData.implement.cycle,2);
    assert.equal(await browser.evaluate(`document.querySelector('[data-task]').textContent`),definition.taskPackages[0].requirements);
    await browser.evaluate(`document.querySelector('[data-detail-key="task-data"] summary').click();document.querySelector('[data-detail-key="technical-prompt"] summary').click()`);
    assert.deepEqual(JSON.parse(await browser.evaluate(`document.querySelector('[data-detail-key="task-data"] pre').textContent`)),returned.taskData);
    assert.equal(await browser.evaluate(`document.querySelector('[data-detail-key="technical-prompt"] pre').textContent`),returned.promptRaw);
    for(const [width,height] of [[1440,1000],[390,844]]) {
      await browser.viewport(width,height);
      await browser.evaluate(`document.querySelector('#inspector').scrollTop=0`);
      await browser.screenshot(join(evidence,`native-${count}-returned-worker-${width}.png`));
    }
    assert.deepEqual(browser.errors,[]);
    await writeFile(join(evidence,`native-${count}-checks.json`),JSON.stringify({runId,passed:true,count,concurrentNativeCalls:active,finalStatus:final.status,returnedWorkerSameSession:true,deltaPromptAndFullTaskData:true},null,2));
  } finally {
    await browser?.close();
    await cliJson(sandbox.spawn(cli,['ui','--stop']),10000).catch(()=>{});
    await provider?.close();await sandbox.cleanup();
  }
}
console.log(JSON.stringify({evidence,passed:true}));
