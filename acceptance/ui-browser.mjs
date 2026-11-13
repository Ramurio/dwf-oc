// Real CLI + native OpenCode + controlled HTTP model + disposable Chrome profile.
// No personal state, external model calls, or shared browser debugging port.
import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenCode, isSessionNotFoundError } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { createSandbox, cliJson, launch, waitFor, writeJson, within } from './harness.mjs';
import { createControlledHttpProvider, nativeProviderConfig } from './controlled-http-provider.mjs';
import { getWorkflow, getRun, claimWorkflow, updateWorkflow } from '../run-store.mjs';
import { openBrowser } from '../prototypes/dwf-ui/qa/browser-probe.mjs';
const execute=promisify(execFile),cli=[process.execPath,fileURLToPath(new URL('../dwf.mjs',import.meta.url))];
const sandbox=await createSandbox();let browser,provider,ui;
const evidence=resolve('prototypes/dwf-ui/.evidence/live');await mkdir(evidence,{recursive:true});
const seen=new Map();
try{
 provider=await createControlledHttpProvider({directory:sandbox.control,token:sandbox.token,reply:({prompt})=>{
  const marker=prompt.includes('UI_LOOP_A')?'loop':prompt.includes('UI_GATE')?'gate':prompt.includes('UI_VERIFICATION_LOOP')?'verification':'other';
  seen.set(marker,(seen.get(marker)??0)+1);
  if(marker!=='other'&&seen.get(marker)===1)return JSON.stringify({outcome:'changes',summary:'Controlled feedback for another visit'});
  if(prompt.includes('UI_SEED'))return JSON.stringify({outcome:'done',summary:'Controlled item list',items:[{id:'perspective_one',task:'First actual assignment'},{id:'perspective_two',task:'Second actual assignment'},{id:'perspective_three',task:'Third actual assignment'}]});
  return JSON.stringify({outcome:'approve',summary:'Controlled approval'});
 }});
 Object.assign(sandbox.env,{OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_FILEWATCHER:'true',OPENCODE_DISABLE_FFF:'true',
  DWF_PLANNER_MODEL:JSON.stringify({provider:'dwf-acceptance',modelId:'planner'}),DWF_PLANNER_REASONING:'high',OPENCODE_CONFIG:join(sandbox.root,'provider.json')});
 await writeJson(sandbox.env.OPENCODE_CONFIG,nativeProviderConfig(provider.baseURL));
 const command=async(args,cwd=sandbox.workspace)=>cliJson(launch(cli,args,{cwd,env:sandbox.env}),30000);
 ui=await command(['ui','--start']);
 browser=await openBrowser(ui.url);
 const check=async expression=>waitFor(()=>browser.evaluate(expression),15000,expression);
 await check('document.querySelector("#run-title").textContent==="No saved runs yet"');
 const definition={task:'Controlled browser: three-node cycle and history',workspace:'directory',entry:'review_long_named_first_step',
  nodes:{review_long_named_first_step:{role:'reviewer',instructions:'UI_LOOP_A',tools:[],skills:[]},independent_audit:{role:'reviewer',tools:[],skills:[]},verify_final:{role:'verifier',tools:[],skills:[]}},
  transitions:{review_long_named_first_step:{approve:'independent_audit',changes:'review_long_named_first_step'},independent_audit:{approve:'verify_final',changes:'review_long_named_first_step'},verify_final:{approve:null,changes:'review_long_named_first_step'}}};
 const firstFile=join(sandbox.root,'first.json');await writeJson(firstFile,definition);
 const first=await command(['start','--file',firstFile]);
 await check(`document.querySelector('#run-id').textContent===${JSON.stringify(first.runId)}`);
 assert.match(await browser.evaluate('document.querySelector("#description").textContent'),/running/);
 const geometryExpression=`JSON.stringify({nodes:[...document.querySelectorAll('[data-node]')].map(n=>[n.dataset.node,n.getAttribute('transform')]),routes:[...document.querySelectorAll('.route')].map(p=>p.getAttribute('d'))})`;
 const initialGeometry=await browser.evaluate(geometryExpression);
 await browser.evaluate(`document.querySelector('[data-primitive="review_long_named_first_step"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
 await check('document.querySelector("#command")!==null');
 const native=getWorkflow(sandbox.state,first.runId),endpoint=await Service.discover({file:native.opencode.registration,version:'2.2.5'});
 const client=OpenCode.make({baseUrl:endpoint.url,headers:Service.headers(endpoint)});
 const session=(await client.session.get({sessionID:native.visits[0].sessionId}));assert.equal(session.location.directory,await realpath(sandbox.workspace));
 const initialCommand=await browser.evaluate('document.querySelector("#command").value');
 assert.ok(initialCommand.includes(native.visits[0].sessionId));
 const help=await execute('/bin/zsh',['-c',initialCommand+' --help'],{env:sandbox.env,timeout:15000});assert.match(help.stdout,/--session/);
 await browser.evaluate('document.querySelector("[data-close]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
 const secondProject=join(sandbox.root,"another project's source");await mkdir(secondProject);
 const secondDefinition={task:'Controlled browser: heterogeneous fixed and data-driven groups',workspace:'directory',entry:'seed',
  nodes:{seed:{role:'orchestrator',instructions:'UI_SEED',tools:[],skills:[]},first_checker:{role:'reviewer',tools:[],skills:[]},second_checker:{role:'verifier',tools:[],skills:[]},mapped_checker:{role:'reviewer',memory:false,tools:[],skills:[]},decision_gate:{role:'reviewer',instructions:'UI_GATE',tools:[],skills:[]}},
  groups:{fixed_perspectives:{members:['first_checker','second_checker']},generated_perspectives:{member:'mapped_checker',itemsFrom:'seed'}},
  transitions:{seed:{done:'fixed_perspectives'},first_checker:{approve:null,changes:null},second_checker:{approve:null,changes:null},mapped_checker:{approve:null,changes:null},fixed_perspectives:{done:'generated_perspectives',changes:null,failed:null},generated_perspectives:{done:'decision_gate',changes:null,failed:null},decision_gate:{approve:null,changes:'generated_perspectives'}}};
 const secondFile=join(sandbox.root,'second.json');await writeJson(secondFile,secondDefinition);
 const second=await command(['start','--file',secondFile],secondProject);
 await check(`document.querySelectorAll('[data-run]').length===2`);
 assert.equal(await browser.evaluate('document.querySelector("#run-id").textContent'),first.runId,'new arrival must not reset selection');
 const alive=await client.session.active();assert.ok(alive[native.visits[0].sessionId]);
 // Stopping UI must not stop either real workflow or the original OpenCode service.
 await command(['ui','--stop']);
 assert.equal(getWorkflow(sandbox.state,first.runId).status,'running');assert.ok((await client.session.active())[native.visits[0].sessionId]);
 ui=await command(['ui','--start']);await browser.send('Page.navigate',{url:ui.url});
 await check(`document.querySelector('#run-id').textContent===${JSON.stringify(second.runId)}`);
 await browser.evaluate(`document.querySelector('[data-run="${first.runId}"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
 await writeJson(join(sandbox.control,'release.json'),{token:sandbox.token,all:true});
 await waitFor(()=>getWorkflow(sandbox.state,first.runId).status==='succeeded',30000,'first real workflow completed');
 await check('document.querySelector("#description").textContent.includes("succeeded")');
 assert.equal(await browser.evaluate(geometryExpression),initialGeometry,'status update preserves geometry');
 await browser.evaluate(`document.querySelector('[data-primitive="review_long_named_first_step"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
 await check('document.querySelectorAll(".call-picker button").length===2');
 await browser.evaluate(`document.querySelector('.call-picker [data-invocation="0"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
 const chosen=await browser.evaluate('document.querySelector("#command").value');
 const historyFirst=getWorkflow(sandbox.state,first.runId).visits[0];assert.ok(chosen.includes(historyFirst.sessionId));
 await waitFor(()=>getWorkflow(sandbox.state,second.runId).status!=='running',30000,'second grouped workflow completed');
 assert.equal(getWorkflow(sandbox.state,second.runId).status,'succeeded',getWorkflow(sandbox.state,second.runId).error);
 await check(`document.querySelector('.run[data-run="${second.runId}"] em').textContent==='succeeded'`);
 assert.equal(await browser.evaluate('document.querySelector(".call-picker [aria-pressed=true]").dataset.invocation'),'0');
 // Temporary network loss keeps the inspected historical call and recovers.
 await browser.send('Network.enable');await browser.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await check('document.querySelector("#connection").textContent.includes("Connection lost")');
 assert.equal(await browser.evaluate('document.querySelector("#command").value'),chosen);
 await browser.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await check('document.querySelector("#connection").textContent.includes("Connected")');
 await browser.evaluate('document.querySelector("[data-close]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
 await browser.evaluate(`document.querySelector('[data-run="${second.runId}"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
 await check('document.querySelectorAll("[data-participant]").length===5');
 const data=(await (await fetch(ui.url+'api/runs')).json()).runs.find(r=>r.id===second.runId);
 assert.equal(data.project,await realpath(secondProject));
 assert.deepEqual(data.graph.nodes.find(n=>n.id==='fixed_perspectives').participants.map(p=>p.role),['reviewer','verifier']);
 const people=data.graph.nodes.find(n=>n.id==='generated_perspectives').participants;
 assert.ok(people.every(p=>p.invocations.length===2));assert.ok(people.every(p=>p.invocations[0].session!==p.invocations[1].session));
 await browser.evaluate(`document.querySelector('[data-participant="generated_perspectives/perspective_one"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
 await check('document.querySelectorAll(".call-picker button").length===2');
 const selected=people[0].invocations[1],selectedSession=await client.session.get({sessionID:selected.session});
 assert.equal(selectedSession.location.directory,await realpath(secondProject));
 await browser.send('Browser.grantPermissions',{origin:ui.url,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
 await browser.evaluate(`document.querySelector('#copy').click()`);await check('document.querySelector("#copy-status").textContent.includes("copied")');
 assert.equal(await browser.evaluate('navigator.clipboard.readText()'),selected.command);assert.ok(!selected.command.includes(secondProject));assert.equal(selected.callDirectory,await realpath(secondProject));assert.equal(selected.sessionDirectory,await realpath(secondProject));
 // Launch the exact generated command in a private PTY, without submitting input.
 // Its rendered title/history must identify the selected real session.
 const ptyDriver=`import pty,os,sys,fcntl,termios,struct,select,signal
pid,fd=pty.fork()
if pid==0:
 fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
 os.execl('/bin/zsh','zsh','-c',sys.argv[1])
while True:
 ready,_,_=select.select([fd,0],[],[])
 if fd in ready:
  try: data=os.read(fd,65536)
  except OSError: break
  if not data: break
  os.write(1,data)
 if 0 in ready:
  data=os.read(0,65536)
  if not data:
   os.killpg(pid,signal.SIGKILL)
   break
  os.write(fd,data)
os.waitpid(pid,0)
`;
 const entry=launch(['python3','-c',ptyDriver],[selected.command],{cwd:secondProject,env:{...sandbox.env,TERM:'xterm-256color'}});
 try{await waitFor(()=>entry.stdout.includes('DWF reviewer mapped_checker'),20000,'generated command opens selected OpenCode session');}
  finally{await writeFile(join(evidence,'entry.txt'),entry.stdout+'\nSTDERR\n'+entry.stderr);}
 entry.child.stdin.write('\x03');entry.child.stdin.end();
 await within(entry.close,10000,'selected-session PTY fully closed');
 await browser.evaluate('document.querySelector("[data-close]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
 await browser.evaluate('document.querySelector("#fit").dispatchEvent(new MouseEvent("click",{bubbles:true}))');await browser.screenshot(join(evidence,'groups.png'));
 // Real legacy-planner CLI format remains visible alongside graph workflows.
 const plannerFile=join(sandbox.root,'planner.json');await writeJson(plannerFile,{planner:{task:'Controlled legacy planner view'}});
 const planner=await command(['start','--file',plannerFile]);
 await check('document.querySelectorAll("[data-run]").length===3');
 await waitFor(async()=>{const response=await fetch(ui.url+'api/runs');await response.json();return getRun(sandbox.state,planner.runId).status==='succeeded';},30000,'legacy planner observed through UI without inspect');
 await browser.evaluate(`document.querySelector('[data-run="${planner.runId}"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);await check('document.querySelector("#run-title").textContent==="Controlled legacy planner view"');
 await browser.screenshot(join(evidence,'planner.png'));
 // A real definition with paired long-range routes must reserve both captions.
 const steps=Array.from({length:5},(_,i)=>`step_${i}`),returns=[4,3,3,0,0];
 const routingFile=join(sandbox.root,'paired-skips.json');
 await writeJson(routingFile,{task:'Controlled paired skip routing',workspace:'directory',entry:steps[0],
  nodes:Object.fromEntries(steps.map(id=>[id,{role:'reviewer',tools:[],skills:[]}])),
  transitions:Object.fromEntries(steps.map((id,i)=>[id,{approve:steps[i+1]??null,changes:steps[returns[i]]}]))});
 const routing=await command(['start','--file',routingFile]);
 await waitFor(()=>getWorkflow(sandbox.state,routing.runId).status==='succeeded',30000,'real paired skip workflow completed');
 await check(`document.querySelector('[data-run="${routing.runId}"]')!==null`);
 await browser.evaluate(`document.querySelector('[data-run="${routing.runId}"]').click()`);
 for(const [width,height] of [[1440,900],[1024,768],[390,844]]) {
  await browser.viewport(width,height);
  for(const mode of ['fit','100']) {
   await browser.evaluate(`document.querySelector('${mode==='fit'?'#fit':'#zoom-reset'}').click()`);
   const collisions=await browser.evaluate(`(()=>{
    const boxes=[...document.querySelectorAll('[data-route-label]')].filter(el=>el.textContent.trim()).map(el=>{
     const r=el.getBoundingClientRect(),mask=parseFloat(getComputedStyle(el).strokeWidth)/2*el.getScreenCTM().a;
     return {id:el.dataset.routeLabel,x:r.left-mask,y:r.top-mask,right:r.right+mask,bottom:r.bottom+mask};
    });
    const nodes=[...document.querySelectorAll('.node-surface')].map(el=>{
     const r=el.getBoundingClientRect();return {id:el.closest('[data-node]').dataset.node,x:r.left,y:r.top,right:r.right,bottom:r.bottom};
    });
    const overlaps=(a,b)=>Math.min(a.right,b.right)>Math.max(a.x,b.x)+.1&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)+.1;
    return boxes.flatMap((a,i)=>[...boxes.slice(i+1),...nodes].filter(b=>overlaps(a,b)).map(b=>[a.id,b.id]));
   })()`);
   assert.deepEqual(collisions,[],`paired skip captions ${width}x${height} ${mode}`);
   await browser.screenshot(join(evidence,`paired-skips-${width}-${mode}.png`));
  }
 }
 // A verifier in the normal worktree mode executes in a private verification
 // snapshot, not in the source directory or the workflow's main worktree.
 for(const args of [['init','-b','main'],['config','user.name','Controlled UI Test'],['config','user.email','ui@example.invalid'],['add','.'],['commit','-m','Controlled baseline']])await execute('git',args,{cwd:sandbox.workspace,env:sandbox.env});
 const verificationFile=join(sandbox.root,'verification.json');
 await writeJson(verificationFile,{task:'Controlled verification worktree session',entry:'verification_with_private_snapshot',nodes:{verification_with_private_snapshot:{role:'verifier',instructions:'UI_VERIFICATION_LOOP',tools:[],skills:[]}},transitions:{verification_with_private_snapshot:{approve:null,changes:'verification_with_private_snapshot'}}});
 const verification=await command(['start','--file',verificationFile]);
 await waitFor(()=>getWorkflow(sandbox.state,verification.runId).status!=='running',30000,'real private verification snapshot');
 const verified=getWorkflow(sandbox.state,verification.runId);assert.equal(verified.status,'succeeded',verified.error);
 await check('document.querySelectorAll("[data-run]").length===5');
 await browser.evaluate(`document.querySelector('[data-run="${verification.runId}"]').click()`);
 await browser.evaluate(`document.querySelector('[data-primitive="verification_with_private_snapshot"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
 await check('document.querySelectorAll(".call-picker button").length===2');
 await browser.evaluate(`document.querySelector('.call-picker [data-invocation="0"]').click()`);
 const verificationVisit=verified.visits[0],latestVisit=verified.visits[1];
 assert.notEqual(verificationVisit.workspace.path,verified.workspace.path);
 assert.equal(verified.visits.length,2);
 assert.equal(verificationVisit.sessionId,latestVisit.sessionId,'verifier continues the real session');
 assert.notEqual(verificationVisit.workspace.path,latestVisit.workspace.path,'each visit has its own verification snapshot');
 const beforeEntry=await client.session.get({sessionID:verificationVisit.sessionId});
 const beforeMessages=await client.message.list({sessionID:verificationVisit.sessionId});
 const beforeSessions=(await client.session.list({limit:100})).data.map(session=>session.id).sort();
 assert.equal(beforeEntry.location.directory,latestVisit.workspace.path);
 await browser.viewport(1440,900);
 for(const [index,visit] of verified.visits.entries()) {
  await browser.evaluate(`document.querySelector('.call-picker [data-invocation="${index}"]').click()`);
  const verificationCommand=await browser.evaluate('document.querySelector("#command").value');
  assert.ok(verificationCommand.endsWith(`--session '${visit.sessionId}'`));
  assert.ok(!verificationCommand.includes(visit.workspace.path),'entry does not claim to override the current directory');
  assert.equal(await browser.evaluate(`document.querySelector('[data-call-directory]').textContent`),visit.workspace.path);
  await check(`document.querySelector('[data-session-directory]').textContent===${JSON.stringify(latestVisit.workspace.path)}`);
  if(index===0)assert.match(await browser.evaluate(`document.querySelector('[data-directory-note]').textContent`),/not the historical worktree/);
  const verificationEntry=launch(['python3','-c',ptyDriver],[verificationCommand],{cwd:secondProject,env:{...sandbox.env,TERM:'xterm-256color'}});
  try {
   await waitFor(()=>verificationEntry.stdout.includes('verification_with_private_snapshot')&&verificationEntry.stdout.includes('Controlled verification worktree session'),20000,'generated command opens the same verifier session from either call');
   assert.deepEqual((await client.session.get({sessionID:visit.sessionId})).location,beforeEntry.location,
    'opening either historical call must not move the native session');
  } finally {
   await writeFile(join(evidence,`verification-entry-${index}.txt`),verificationEntry.stdout+'\nSTDERR\n'+verificationEntry.stderr);
   verificationEntry.child.stdin.write('\x03');verificationEntry.child.stdin.end();
   await within(verificationEntry.close,10000,'verification PTY fully closed');
  }
  await browser.screenshot(join(evidence,`verification-context-${index}.png`));
 }
 assert.deepEqual(await client.message.list({sessionID:verificationVisit.sessionId}),beforeMessages,'entry submits no extra input');
 assert.equal((await client.session.get({sessionID:verificationVisit.sessionId})).id,beforeEntry.id,'no fork or replacement session');
 assert.deepEqual((await client.session.list({limit:100})).data.map(session=>session.id).sort(),beforeSessions,'entry creates no fork or replacement session');
 // Make only this completed test record's discovery path unavailable. Do not
 // remove the native registration: it participates in the service lifecycle.
 const registration=verified.opencode.registration;
 const saveDiscovery=path=>{
  assert.ok(claimWorkflow(sandbox.state,verified.id,'ui-observation-test'));
  verified.opencode.registration=path;
  updateWorkflow(sandbox.state,verified,'ui-observation-test',true);
 };
 saveDiscovery(join(sandbox.root,'missing-native-registration.json'));
 try {
  await check(`document.querySelector('[data-session-directory]').textContent.includes('Unknown')`);
  assert.equal(await browser.evaluate(`document.querySelector('[data-last-directory]').textContent`),latestVisit.workspace.path);
  assert.match(await browser.evaluate(`document.querySelector('[data-directory-note]').textContent`),/Current directory is unknown/);
  assert.deepEqual((await client.session.get({sessionID:verificationVisit.sessionId})).location,beforeEntry.location,'native service remains alive and unmoved');
 } finally { saveDiscovery(registration); }
 await check(`document.querySelector('[data-session-directory]').textContent===${JSON.stringify(latestVisit.workspace.path)}`);
 // Explicit isolated teardown of this one completed test session, not a UI
 // action: polling must not recreate it or offer a misleading entry command.
 await client.session.remove({sessionID:verificationVisit.sessionId});
 await check(`document.querySelector('#command')===null && document.querySelector('.command-section').textContent.includes('no longer available')`);
 assert.equal(await browser.evaluate(`document.querySelector('[data-call-directory]').textContent`),latestVisit.workspace.path);
 await assert.rejects(client.session.get({sessionID:verificationVisit.sessionId}),isSessionNotFoundError);
 assert.deepEqual(browser.errors,[]);
 await writeFile(join(evidence,'summary.json'),JSON.stringify({passed:true,checks:['two real projects','live arrival preserves selection','native running → terminal','UI stop leaves native execution alive','restart picks latest','historical call preserved','connection recovery','fixed mixed roles','data-driven repeat histories','fresh and continuing sessions','exact generated command opens native session in PTY','legacy planner auto-observation','paired skip captions clear at three viewports', 'early/latest verifier calls open the same native session without relocation or input', 'historical and observed current directories are distinct'],errors:browser.errors},null,2));
 console.log('Live browser verification passed: real CLI workflows in two projects, groups/history/session command, reconnect, stop/restart and planner.');
}finally{
 await browser?.close();
 if(ui)await cliJson(sandbox.spawn(cli,['ui','--stop']),10000).catch(()=>{});
 await provider?.close();await sandbox.cleanup();
}
