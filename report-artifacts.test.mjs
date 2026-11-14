import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureReportArtifacts } from './report-artifacts.mjs';
import { prepareRoleInput } from './role-context.mjs';
import { parseVerdict } from './workflow-definition.mjs';
import { snapshot } from './workflow-git.mjs';

function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'dwf-report-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'project');mkdirSync(path);
 const git=args=>execFileSync('git',args,{cwd:path,stdio:'pipe',encoding:'utf8'}).trim();
 git(['init','-q']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
 writeFileSync(join(path,'contract.md'),'exact contract\n');
 git(['add','.']);git(['commit','-qm','seed']);
 const state={id:'run',workspace:{path},visits:[],definition:{task:'Implement contract',entry:'manager',nodes:{work:{role:'worker'},manager:{role:'orchestrator'}},transitions:{work:{done:'manager'},manager:{done:null}}}};
 const visit={node:'work',participant:'work',inputId:'msg_report',revision:snapshot(state.workspace),verdict:{outcome:'blocked',summary:'Decide using attached evidence',artifacts:['contract.md']}};
 return {root,path,state,visit};
}

test('reported Git content is revision-bound, survives source removal and reaches manager context',t=>{
 const {root,path,state,visit}=fixture(t);
 writeFileSync(join(path,'contract.md'),'changed after snapshot');
 visit.reportArtifacts=captureReportArtifacts(root,state,visit,['contract.md']);
 const [link]=visit.reportArtifacts;
 assert.equal(link.access,'read');assert.equal(readFileSync(link.path,'utf8'),'exact contract\n');
 state.visits.push(visit);
 const manager={node:'manager',inputId:'msg_manager',revision:visit.revision};
 prepareRoleInput(root,state,manager,visit.verdict);
 assert.deepEqual(manager.taskContext.questions[0].artifacts,[link]);
 state.definition.nodes.manager.tools=[];
 const noRead={node:'manager',inputId:'msg_no_read',revision:visit.revision};
 prepareRoleInput(root,state,noRead,visit.verdict);
 assert.equal(noRead.taskContext.questions[0].artifacts[0].access,'unavailable');
 rmSync(path,{recursive:true});
 assert.equal(readFileSync(manager.taskContext.questions[0].artifacts[0].path,'utf8'),'exact contract\n');
});

test('files outside revision, symlinks, traversal, binary and oversized data are explicitly unavailable',t=>{
 const {root,path,state,visit}=fixture(t);
 writeFileSync(join(root,'secret'),'private');symlinkSync(join(root,'secret'),join(path,'escape'));
 writeFileSync(join(path,'big'),Buffer.alloc(1024*1024+1));writeFileSync(join(path,'binary'),Buffer.from([255]));
 visit.revision=snapshot(state.workspace);
 const links=captureReportArtifacts(root,state,visit,['../secret',join(root,'secret'),'escape','missing','big','binary',':(glob)**']);
 assert(links.every(x=>x.access==='unavailable'));
 for(const link of links) assert(!('path' in link));
 const saved=join(root,'workflows','run','contexts','msg_report');
 for(let i=0;i<links.length;i++)assert(!readFileSync(join(saved,`report-artifact-${i}.json`),'utf8').includes('private'));
});

test('directory reports replay the saved copy after source mutation',t=>{
 const {root,path,state,visit}=fixture(t);state.workspace.mode='directory';
 const first=captureReportArtifacts(root,state,visit,['contract.md']);
 writeFileSync(join(path,'contract.md'),'later');
 assert.deepEqual(captureReportArtifacts(root,state,visit,['contract.md']),first);
 assert.equal(readFileSync(first[0].path,'utf8'),'exact contract\n');
 assert.throws(()=>captureReportArtifacts(root,state,visit,['different.md']),/уже сохранён/);
 assert.throws(()=>captureReportArtifacts(root,state,{...visit,revision:'new-revision'},['contract.md']),/уже сохранён/);
});

test('replay after publishing text but before manifest is idempotent',t=>{
 const {root,state,visit}=fixture(t);
 const first=captureReportArtifacts(root,state,visit,['contract.md']);
 rmSync(first[0].path.replace(/\.txt$/,'.json'));
 assert.deepEqual(captureReportArtifacts(root,state,visit,['contract.md']),first);
});

test('text snapshots preserve UTF-8 BOM and original line endings',t=>{
 const {root,path,state,visit}=fixture(t);
 const bytes=Buffer.from('\uFEFFfirst\r\nsecond\n','utf8');
 writeFileSync(join(path,'contract.md'),bytes);
 visit.revision=snapshot(state.workspace);
 const [link]=captureReportArtifacts(root,state,visit,['contract.md']);
 assert.deepEqual(readFileSync(link.path),bytes);
});

test('result artifact envelope rejects malformed declarations and preserves old results',()=>{
 for(const artifacts of [null,'file',[1],['a','a'],Array.from({length:17},(_,i)=>String(i))]) {
  assert.throws(()=>parseVerdict(JSON.stringify({outcome:'done',summary:'ok',artifacts}),'worker'),/artifacts/);
 }
 assert.deepEqual(parseVerdict('{"outcome":"done","summary":"ok"}','worker'),{outcome:'done',summary:'ok'});
});
