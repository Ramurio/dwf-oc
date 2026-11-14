// An external tester authors the workflow and participants implement the seed.
// No human decision relay or fixture implementation is performed by this harness.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createSandbox, writeJson } from './harness.mjs';
import { prepareCandidateTester, connectCandidateTester } from './candidate-tester.mjs';
import { admitTester, inspectTester, visibleMessages } from './tester.mjs';
import { getWorkflow, savedRuns } from '../run-store.mjs';

const [seedArg, skillArg, evidenceArg, promptArg] = process.argv.slice(2);
assert(seedArg && skillArg && evidenceArg && promptArg, 'seed skill evidence prompt required');
const seed=resolve(seedArg), evidence=resolve(evidenceArg);
await mkdir(evidence,{recursive:true,mode:0o700});
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
const sandbox=await createSandbox();
let attempt, client, final, tester;
try {
 attempt=await prepareCandidateTester(sandbox,{seed,baseline:git(seed,['rev-parse','HEAD']),
  skillDirectory:resolve(skillArg),prompt:await readFile(promptArg,'utf8')});
 await writeJson(join(evidence,'attempt.json'),attempt);
 client=await connectCandidateTester(sandbox,attempt);
 await admitTester(client,attempt);
 let last='';
 const deadline=Date.now()+40*60*1000;
 while(Date.now()<deadline){
  tester=await inspectTester(client,attempt);
  const runs=savedRuns(sandbox.state).workflows;
  assert(runs.length<=1,'Tester created replacement workflows');
  if(runs.length){
   const state=getWorkflow(sandbox.state,runs[0].state.id);
   const line=JSON.stringify({runId:state.id,status:state.status,instances:Object.values(state.implements?.instances??{}).map(i=>({id:i.id,status:i.status,phase:i.phase}))});
   if(line!==last){console.log(line);last=line;await writeJson(join(evidence,'state.json'),state);}
   if(state.status==='succeeded')final=state;
   else assert.equal(state.status,'running',state.error??'Workflow did not complete');
  }
  if(tester.status!=='running'){
   assert.equal(tester.status,'succeeded',tester.error);
   assert(final,'Tester finished without completing the assigned workflow');break;
  }
  await pause(1500);
 }
 assert(final && tester.status==='succeeded','Independent trial timed out');
 assert.equal(Object.values(final.implements.instances).filter(i=>i.status==='integrated').length,3);
 assert.equal(final.controls?.filter(c=>c.kind==='steer').length??0,0,'Trial required external steering');
 const attached=final.visits.filter(v=>v.reportArtifacts?.some(a=>a.access==='read'));
 assert(attached.length,'No participant attached a readable document');
 const manager=final.visits.filter(v=>final.definition.nodes[v.node]?.role==='orchestrator');
 assert(manager.some(v=>JSON.stringify(v.taskContext).includes('report-artifact-')),'Manager did not receive documents');
 const workerVisits=final.visits.filter(v=>v.implementId&&final.definition.nodes[v.node]?.role==='worker');
 const parallel=workerVisits.some(a=>workerVisits.some(b=>a!==b&&a.implementId!==b.implementId&&
  Math.max(a.progress?.startedAt??a.startedAt,b.progress?.startedAt??b.startedAt)<Math.min(a.execution?.finishedAt??a.progress?.updatedAt??a.startedAt,b.execution?.finishedAt??b.progress?.updatedAt??b.startedAt)));
 assert(parallel,'No observed parallel worker intervals');
 const original=await readFile(join(seed,'report.test.mjs'),'utf8');
 assert.equal(await readFile(join(attempt.workspace,'report.test.mjs'),'utf8'),original);
 const checks=execFileSync(process.execPath,['--test'],{cwd:attempt.workspace,encoding:'utf8',stdio:'pipe'});
 await writeFile(join(evidence,'leader-tests.log'),checks);
 assert.equal(git(attempt.workspace,['status','--porcelain']),'');
 const sessions=[...new Set(final.visits.map(v=>v.sessionId).filter(Boolean))];
 for(const sessionID of sessions){
  let cursor,messages=[];
  do{const page=await client.message.list({sessionID,limit:100,...(cursor?{cursor}:{order:'asc'})});messages.push(...page.data);cursor=page.data.length?page.cursor.next:undefined;}while(cursor);
  await writeJson(join(evidence,`${sessionID}.json`),visibleMessages(messages));
 }
 await writeJson(join(evidence,'result.json'),{passed:true,runId:final.id,attempt:attempt.directory,state:sandbox.state,parallel,attached:attached.map(v=>v.inputId),tester:tester.report,head:git(attempt.workspace,['rev-parse','HEAD'])});
 console.log(JSON.stringify({passed:true,runId:final.id,evidence}));
} catch(error){
 await writeJson(join(evidence,'failure.json'),{message:error.message,attempt:attempt?.directory,state:sandbox.state});throw error;
} finally { await sandbox.cleanupProcesses(); }
