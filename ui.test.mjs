import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkflow, claimWorkflow, updateWorkflow, createRun, saveOutcome } from './run-store.mjs';
import { workflowView, sessionCommand } from './ui-data.mjs';
import { layoutGraph } from './prototypes/dwf-ui/layout.mjs';
const execute=promisify(execFile),cli=fileURLToPath(new URL('./dwf.mjs',import.meta.url));
export const definition={task:'Controlled task — no personal data',entry:'alpha',nodes:{alpha:{role:'worker'},beta:{role:'reviewer'},gamma:{role:'verifier'}},transitions:{alpha:{done:'beta'},beta:{approve:'gamma',changes:'alpha'},gamma:{approve:null,changes:'alpha'}}};
export const state=(id='one',source='/controlled/project A')=>({id,createdAt:1,definition:structuredClone(definition),workspace:{source,path:source},status:'running',sessions:{},visits:[]});

test('adapter derives complete topology, arbitrary cycles, session history, no invented observations',()=>{
 const s=state();s.visits=[{node:'alpha',participant:'alpha',sessionId:'ses_a',inputId:'msg_a',admitted:true,prompt:'Actual task',verdict:{outcome:'done',summary:'Actual result'}}];
 const v=workflowView(s,{root:'/controlled/state',owned:true});
 assert.equal(v.graph.edges.length,5);assert.equal(v.graph.nodes.find(n=>n.id==='beta').participants[0].invocations.length,0);
 assert.equal(v.graph.nodes[0].participants[0].invocations[0].session,'ses_a');
 assert.equal(v.graph.nodes[0].participants[0].invocations[0].speed,'Not recorded');
 layoutGraph(v.graph);
 const loop=state();loop.definition.transitions.gamma.changes='beta';loop.definition.transitions.beta.changes='gamma';layoutGraph(workflowView(loop,{root:'/controlled/state'}).graph);
});

test('CLI service: concurrent start from two projects, detached lifetime, read-only local API, stop/restart/stale',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dwf-ui-test-')),a=join(root,'project A'),b=join(root,'project B');
 await mkdir(a);await mkdir(b);
 const env={...process.env,DWF_STATE_DIR:join(root,'state')};let url;
 const call=async(action,cwd=a)=>JSON.parse((await execute(process.execPath,[cli,'ui',action],{env,cwd,timeout:20000})).stdout);
 try{
  const starts=await Promise.all(Array.from({length:4},(_,i)=>call(i%2?'start':'--start',i%2?a:b)));
  url=starts[0].url;assert.ok(starts.every(s=>s.url===url));assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await call('--status')).url,url);
  const api=async()=>{const response=await fetch(url+'api/runs');assert.equal(response.status,200);return response.json();};
  assert.deepEqual((await api()).runs,[]);
  const first=state('one',a);createWorkflow(env.DWF_STATE_DIR,first);
  assert.equal((await api()).runs[0].id,'one');
  createWorkflow(env.DWF_STATE_DIR,{...state('two',b),createdAt:2});
  let views=(await api()).runs;assert.deepEqual(views.map(r=>r.id),['two','one']);assert.equal(views[0].project,b);
  assert.ok(claimWorkflow(env.DWF_STATE_DIR,'two','test-owner'));
  updateWorkflow(env.DWF_STATE_DIR,{...state('two',b),createdAt:2,status:'cancelled'},'test-owner',true);
  assert.equal((await api()).runs[0].status,'cancelled');
  createRun(env.DWF_STATE_DIR,{id:'old',sessionId:'ses_old',inputId:'msg_old',request:{text:'Legacy planner',session:{location:{directory:a}}}});
  saveOutcome(env.DWF_STATE_DIR,'old',{status:'succeeded',result:'Legacy result',answerId:'msg_answer'});
  await assert.rejects(readFile(join(env.DWF_STATE_DIR,'opencode','state','opencode','service.json')), { code: 'ENOENT' });
  const old=(await api()).runs.find(r=>r.id==='old');assert.equal(old.graph.nodes[0].role,'planner');assert.equal(old.result,'Legacy result');
  assert.equal((await fetch(url+'api/runs',{headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await fetch(url+'api/stop',{method:'POST'})).status,403);
  assert.equal((await fetch(url+'../dwf.mjs')).status,404);
  const registration=JSON.parse(await readFile(join(env.DWF_STATE_DIR,'ui.json'),'utf8'));
  assert.equal(registration.host,'127.0.0.1');
  if(process.platform==='darwin'){const sockets=await execute('/usr/sbin/lsof',['-nP','-a','-p',String(registration.pid),'-iTCP','-sTCP:LISTEN']);assert.match(sockets.stdout,/127\.0\.0\.1:/);assert.ok(!sockets.stdout.includes('*:'));}
  // A stalled UI event loop must not cause a duplicate singleton. This PID is
  // from the registration just created by this isolated test, never user state.
  process.kill(registration.pid,'SIGSTOP');
  try{assert.equal((await call('--start')).url,url);}
  finally{process.kill(registration.pid,'SIGCONT');}
  await call('--stop');await call('stop');assert.equal((await call('status')).status,'stopped');
  await writeFile(join(env.DWF_STATE_DIR,'ui.json'),JSON.stringify({...registration,token:'stale'}));
  const restarted=await call('--start');url=restarted.url;assert.equal((await fetch(url)).status,200);
  const crashed=JSON.parse(await readFile(join(env.DWF_STATE_DIR,'ui.json'),'utf8'));
  process.kill(crashed.pid,'SIGKILL');
  url=(await call('--start')).url;assert.equal((await fetch(url)).status,200);
  await call('--stop');
 }finally{await call('--stop').catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('session command quotes the saved profile and session ID without promising a directory override',()=>{
 const command=sessionCommand('/state', {env:{HOME:'/home/test',OPENCODE_DB:"/path/it's db.sqlite"}},'ses_selected',"/work/it's project");
 assert.ok(command.includes("'ses_selected'"));assert.ok(!command.includes('/work/'));assert.ok(command.endsWith("--session 'ses_selected'"));assert.ok(sessionCommand('/state',{env:{}},'ses_selected'));assert.ok(command.includes("OPENCODE_DB='/path/it'\"'\"'s db.sqlite'"));assert.ok(!command.includes('attach'));
});

function assertRoutesClear(graph) {
 const map=layoutGraph(graph,{measure:t=>t.length*8});
 for(const edge of map.edges)for(let i=1;i<edge.points.length;i++){
  const a=edge.points[i-1],b=edge.points[i];
  assert.ok(a.x===b.x||a.y===b.y,`${edge.id}: orthogonal`);
  for(const n of map.nodes){
   const crosses=a.x===b.x?a.x>n.x+1&&a.x<n.x+n.width-1&&Math.max(a.y,b.y)>n.y+1&&Math.min(a.y,b.y)<n.y+n.height-1:
    a.y>n.y+1&&a.y<n.y+n.height-1&&Math.max(a.x,b.x)>n.x+1&&Math.min(a.x,b.x)<n.x+n.width-1;
   assert.ok(!crosses,`${edge.id} crosses ${n.id}`);
  }
 }
 const boxes=map.edges.filter(e=>e.label.text).map(e=>{const lines=e.label.lines??[e.label.text],w=Math.max(...lines.map(t=>t.length*8))+7;
  return {id:e.id,x:e.label.x-(e.label.anchor==='end'?w:e.label.anchor==='middle'?w/2:0),y:e.label.y-18,width:w,height:lines.length*18+7};});
 const separate=(a,b)=>a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y;
 for(const [i,a] of boxes.entries()){
  for(const b of boxes.slice(i+1))assert.ok(separate(a,b),`Caption overlap ${a.id} / ${b.id}`);
  for(const n of map.nodes)assert.ok(separate(a,n),`Caption ${a.id} crosses ${n.id}`);
 }
 return map;
}

test('actual definitions: generated multi-node cycles, several returns and self-loops auto-layout without route or caption collisions',async()=>{
 const {validateWorkflow}=await import('./workflow-definition.mjs');
 for(let count=3;count<=9;count++){
  const names=Array.from({length:count},(_,i)=>`arbitrary_${i}_with_an_unusually_long_label`);
  const def={task:'Generated real definition',entry:names[0],nodes:Object.fromEntries(names.map(id=>[id,{role:'reviewer'}])),transitions:{}};
  names.forEach((id,i)=>def.transitions[id]={approve:names[i+1]??null,changes:names[Math.floor(i/2)]});
  validateWorkflow(def);
  const s={...state(),definition:def};const graph=workflowView(s,{root:'/controlled'}).graph;
  const before=assertRoutesClear(graph);
  for(const n of graph.nodes)for(const p of n.participants)p.invocations.push({state:'active',session:'ses_observed'});
  assert.deepEqual(layoutGraph(graph,{measure:t=>t.length*8}),before);
 }
});

test('groups retain different roles, all past items and standalone steering visits; prepared inputs are not counted',()=>{
 const s=state();s.definition={task:'Group history',entry:'batch',nodes:{r:{role:'reviewer'},v:{role:'verifier'},template:{role:'reviewer'}},
  groups:{batch:{members:['r','v']},mapped:{member:'template',items:[{id:'new'}]}},
  transitions:{r:{approve:null,changes:null},v:{approve:null,changes:null},template:{approve:null,changes:null},batch:{done:'mapped',changes:null,failed:null},mapped:{done:null,changes:null,failed:null}}};
 s.visits=[{node:'batch',children:[{node:'r',participant:'r',admitted:true,inputId:'one',sessionId:'ses_same',verdict:{outcome:'approve',summary:'First'}},{node:'v',participant:'v',admissionStarted:true,inputId:'not_sent',sessionId:'ses_prepared'}]},
  {node:'mapped',children:[{node:'template',participant:'mapped/old',item:{id:'old'},admitted:true,inputId:'two',sessionId:'ses_old',verdict:{outcome:'approve',summary:'Past item'}}]},
  {node:'r',participant:'r',admitted:true,inputId:'three',sessionId:'ses_same',verdict:{outcome:'approve',summary:'Steered visit'}}];
 const graph=workflowView(s,{root:'/controlled'}).graph;
 const fixed=graph.nodes.find(n=>n.id==='batch');assert.deepEqual(fixed.participants.map(p=>p.role),['reviewer','verifier']);
 assert.equal(fixed.participants[0].invocations.length,2);assert.equal(fixed.participants[1].invocations.length,0);
 assert.deepEqual(graph.nodes.find(n=>n.id==='mapped').participants.map(p=>p.id),['mapped/new','mapped/old']);assertRoutesClear(graph);
});

test('saved response correction is a separate real invocation, never an invented result or timestamp',()=>{
 const s=state();s.visits=[{node:'alpha',sessionId:'ses_same',inputId:'msg_original',prompt:'Initial prompt',correction:{inputId:'msg_correction',prompt:'Correction prompt'},admitted:true,verdict:{outcome:'done',summary:'Corrected result'}}];
 const calls=workflowView(s,{root:'/controlled'}).graph.nodes[0].participants[0].invocations;
 assert.equal(calls.length,2);assert.equal(calls[0].id,'msg_original');assert.equal(calls[1].id,'msg_correction');assert.equal(calls[1].task,'Correction prompt');assert.equal(calls[1].time,'Time not recorded');assert.equal(calls[0].session,calls[1].session);
});

test('activity belongs to the actual platform while standalone and group views share history', async () => {
  const { validateWorkflow } = await import('./workflow-definition.mjs');
  const s = state();
  s.definition = validateWorkflow({ task: 'Shared participant location', entry: 'r',
    nodes: { r: { role: 'reviewer' } }, groups: { batch: { members: ['r'] } },
    transitions: { r: { approve: 'batch', changes: null }, batch: { done: null, changes: null, failed: null } } });
  s.visits = [{ node: 'r', participant: 'r', admitted: true, inputId: 'msg_solo', sessionId: 'ses_shared' }];
  let graph = workflowView(s, { root: '/controlled', owned: true }).graph;
  const participant = (graph, platform) => graph.nodes.find(n => n.id === platform).participants[0];
  assert.equal(participant(graph, 'r').active, true);
  assert.equal(participant(graph, 'batch').active, false);
  assert.equal(participant(graph, 'batch').currentState, null);
  assert.deepEqual(participant(graph, 'r').invocations, participant(graph, 'batch').invocations);

  s.visits[0].verdict = { outcome: 'approve', summary: 'Standalone complete' };
  s.visits.push({ node: 'batch', children: [{ node: 'r', participant: 'r', admitted: true,
    inputId: 'msg_group', sessionId: 'ses_shared' }] });
  graph = workflowView(s, { root: '/controlled', owned: true }).graph;
  assert.equal(participant(graph, 'r').active, false);
  assert.equal(participant(graph, 'batch').active, true);
  assert.equal(participant(graph, 'r').currentState, 'done');
  assert.equal(participant(graph, 'batch').invocations.length, 2);
  assert.equal(participant(graph, 'batch').invocations[1].location, 'batch');
});

test('valid Object.prototype names stay ordinary nodes with their role, history and session', async () => {
  const { validateWorkflow } = await import('./workflow-definition.mjs');
  for (const id of ['toString', 'hasOwnProperty', 'valueOf']) {
    const s = state();
    s.definition = validateWorkflow({ task: 'Prototype-name participant', entry: id,
      nodes: { [id]: { role: 'reviewer' } }, transitions: { [id]: { approve: null, changes: id } } });
    s.visits = [{ node: id, participant: id, admitted: true, inputId: 'msg_actual', sessionId: 'ses_actual', prompt: 'Actual saved prompt' }];
    const graph = workflowView(s, { root: '/controlled', owned: true }).graph;
    const node = graph.nodes.find(n => n.id === id);
    assert.equal(node.group, undefined);
    assert.equal(node.role, 'reviewer');
    assert.equal(node.participants[0].invocations[0].session, 'ses_actual');
    assert.ok(node.participants[0].invocations[0].command.includes("'ses_actual'"));
    assert.equal(graph.edges.find(e => e.to === id).kind, 'control');
    layoutGraph(graph);
    s.definition = validateWorkflow({ task: 'Prototype-name return source', entry: 'start',
      nodes: { start: { role: 'reviewer' }, [id]: { role: 'reviewer' } },
      transitions: { start: { approve: id, changes: null }, [id]: { approve: null, changes: 'start' } } });
    const returning = workflowView(s, { root: '/controlled', owned: true }).graph.edges.find(e => e.from === id && e.to === 'start');
    assert.equal(returning.reentry, true);
    assert.equal(returning.kind, 'control');
  }
});

test('known DWF result envelopes project summary and useful fields, retaining exact source', () => {
  const envelope = { outcome: 'changes', summary: 'Escape the exported heading.',
    findings: [{ path: 'export.mjs', line: 8, summary: 'Heading is not escaped.' }],
    artifacts: ['report.md'], extraEvidence: { checked: false, count: 0 } };
  const s = state();
  s.status = 'succeeded';
  s.result = { outcome: 'done', summary: 'Export implemented and checked.', commit: 'controlled-commit' };
  s.visits = [{ node: 'alpha', admitted: true, inputId: 'msg_result', sessionId: 'ses_result', verdict: envelope }];
  const view = workflowView(s, { root: '/controlled' });
  const call = view.graph.nodes[0].participants[0].invocations[0];
  assert.equal(call.result, envelope.summary);
  assert.deepEqual(call.resultRaw, envelope);
  assert.deepEqual(call.resultDetails.find(d => d.label === 'Findings').value, envelope.findings);
  assert.deepEqual(call.resultDetails.find(d => d.label === 'Artifacts').value, envelope.artifacts);
  assert.ok(!call.resultDetails.some(d => d.label.toLowerCase() === 'outcome'));
  assert.deepEqual(call.resultDetails.find(d => d.label === 'Extra Evidence').value, envelope.extraEvidence);
  assert.equal(view.result, s.result.summary);
  assert.deepEqual(view.resultRaw, s.result);
  assert.equal(view.resultDetails[0].value, 'controlled-commit');
  for (const legacy of ['Old plain result', 'not { valid JSON', ['an old array', { evidence: 0 }], { custom: ['field'] }]) {
    s.result = legacy;
    const old = workflowView(s, { root: '/controlled' });
    assert.deepEqual(old.resultRaw, legacy);
    assert.ok(!old.result.startsWith('{') && !old.result.startsWith('['));
  }
  s.result = JSON.stringify(envelope);
  const serialized = workflowView(s, { root: '/controlled' });
  assert.equal(serialized.result, envelope.summary);
  assert.equal(serialized.resultRaw, s.result);
});

test('standalone steering of a mapped participant stays active at its actual template platform', async () => {
  const { validateWorkflow } = await import('./workflow-definition.mjs');
  const s = state();
  s.definition = validateWorkflow({ task: 'Steered mapped identity', entry: 'seed',
    nodes: { seed: { role: 'orchestrator' }, template: { role: 'reviewer' } },
    groups: { batch: { member: 'template', items: [{ id: 'one' }] } },
    transitions: { seed: { done: 'batch' }, template: { approve: null, changes: null }, batch: { done: null, changes: null, failed: null } } });
  s.visits = [{ node: 'batch', children: [{ node: 'template', participant: 'batch/one', admitted: true,
    inputId: 'msg_grouped', sessionId: 'ses_mapped', verdict: { outcome: 'approve', summary: 'Earlier grouped review' } }] },
    { node: 'template', participant: 'batch/one', admitted: true, inputId: 'msg_steered', sessionId: 'ses_mapped', prompt: 'Steered task' }];
  const graph = workflowView(s, { root: '/controlled', owned: true }).graph;
  const ordinary = graph.nodes.find(n => n.id === 'template').participants[0];
  assert.equal(ordinary.id, 'batch/one');
  assert.equal(ordinary.active, true);
  assert.equal(ordinary.invocations.length, 2);
  assert.equal(graph.nodes.find(n => n.id === 'batch').participants[0].active, false);
});


test('standalone identities retain original and mapped histories beside an unadmitted input', async () => {
  const { validateWorkflow } = await import('./workflow-definition.mjs');
  const s = state();
  s.definition = validateWorkflow({ task: 'Multiple standalone identities', entry: 'template',
    nodes: { template: { role: 'reviewer' } },
    groups: { batch: { member: 'template', items: [{ id: 'one' }] } },
    transitions: { template: { approve: 'batch', changes: null }, batch: { done: null, changes: null, failed: null } } });
  s.visits = [
    { node: 'template', admitted: true, inputId: 'msg_original', sessionId: 'ses_original',
      prompt: 'Original task', verdict: { outcome: 'approve', summary: 'Original result' } },
    { node: 'batch', children: [{ node: 'template', participant: 'batch/one', admitted: true,
      inputId: 'msg_group', sessionId: 'ses_mapped', verdict: { outcome: 'approve', summary: 'Grouped result' } }] },
    { node: 'template', participant: 'batch/one', admitted: true, inputId: 'msg_steered', sessionId: 'ses_mapped',
      verdict: { outcome: 'approve', summary: 'Steered result' } },
    { node: 'template', participant: 'batch/pending', inputId: 'msg_pending', sessionId: 'ses_pending' },
  ];
  const people = workflowView(s, { root: '/controlled', owned: true }).graph.nodes.find(n => n.id === 'template').participants;
  assert.deepEqual(people.map(p => p.id), ['batch/pending', 'batch/one', 'template']);
  assert.deepEqual(people.map(p => p.invocations.length), [0, 2, 1]);
  assert.ok(people.every(p => !p.active));
  const original = people.find(p => p.id === 'template').invocations[0];
  assert.equal(original.task, 'Original task');
  assert.equal(original.result, 'Original result');
  assert.ok(original.command.includes("'ses_original'"));
});

test('paired skip routes reserve both captions in the five-reviewer cycle', async () => {
  const { validateWorkflow } = await import('./workflow-definition.mjs');
  const ids = Array.from({ length: 5 }, (_, i) => `step_${i}`);
  const changes = [4, 3, 3, 0, 0];
  const s = state();
  s.definition = validateWorkflow({ task: 'Paired skip caption regression', entry: ids[0],
    nodes: Object.fromEntries(ids.map(id => [id, { role: 'reviewer' }])),
    transitions: Object.fromEntries(ids.map((id, i) => [id, { approve: ids[i + 1] ?? null, changes: ids[changes[i]] }])) });
  const graph = workflowView(s, { root: '/controlled' }).graph;
  const map = layoutGraph(graph, { measure: text => text.length * 8 });
  const boxes = map.edges.map(e => {
    const lines = e.label.lines ?? [e.label.text];
    const width = Math.max(...lines.map(text => text.length * 8));
    const offset = e.label.anchor === 'end' ? width : e.label.anchor === 'middle' ? width / 2 : 0;
    return { id: e.id, x: e.label.x - offset - 3.5, y: e.label.y - 17.5,
      width: width + 7, height: lines.length * 18 + 7 };
  });
  const separate = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) assert.ok(separate(a, b), `Caption collision: ${a.id} / ${b.id}`);
  }
});


test('call and last saved session directories remain distinct when native location is unknown', () => {
  const s = state();
  s.visits = [
    { node: 'alpha', sessionId: 'ses_moved', inputId: 'old', admitted: true, workspace: { path: '/old snapshot' },
      verdict: { outcome: 'done', summary: 'Earlier call' } },
    { node: 'alpha', sessionId: 'ses_moved', inputId: 'latest', admitted: true, workspace: { path: '/last snapshot' } },
    { node: 'alpha', sessionId: 'ses_moved', inputId: 'prepared', workspace: { path: '/not observed' } },
  ];
  const calls = workflowView(s, { root: '/controlled', owned: true }).graph.nodes[0].participants[0].invocations;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.callDirectory), ['/old snapshot', '/last snapshot']);
  assert.ok(calls.every(c => c.lastObservedDirectory === '/last snapshot'));
  assert.ok(calls.every(c => c.sessionDirectory === null));
  assert.ok(calls.every(c => c.command === calls[0].command));
  assert.ok(!calls[0].command.includes('/old snapshot'));
});
