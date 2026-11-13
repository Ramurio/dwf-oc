import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRoleInput } from './role-context.mjs';
import { acknowledgeContext } from './context-delivery.mjs';
import { eightTasks } from './acceptance/context-fixture.mjs';
import assert from 'node:assert/strict';
import { implementUiFixture as fixture } from './acceptance/ui-implement-fixture.mjs';
import { validateWorkflow } from './workflow-definition.mjs';
import { workflowView } from './ui-data.mjs';
import { layoutGraph } from './prototypes/dwf-ui/layout.mjs';


test('explicit titles are optional, validated and exposed without mining prompts', () => {
  const state = fixture();
  validateWorkflow(state.definition);
  const view = workflowView(state, {root: '/controlled'});
  const block = view.graph.nodes.find(n => n.id === 'implements');
  assert.equal(block.instances[0].title, 'Human task 0: readable explicit title');
  assert.equal(block.instances[0].beadsId, 'project-0');
  delete state.definition.taskPackages[0].title;
  validateWorkflow(state.definition);
  assert.equal(workflowView(state, {root: '/controlled'}).implements.instances[0].title, undefined);
  for (const invalid of ['  ', null, 42, '\ud800']) {
    state.definition.taskPackages[0].title = invalid;
    assert.throws(() => validateWorkflow(state.definition));
  }
});

test('structured call exposes exact assignment, handoff, problems, cycle and identity; raw-only is not summarized', () => {
  const state = fixture();
  const context = {task: state.definition.taskPackages[0], implement: {id:'unit-0', cycle:2},
    assignment: {instructions:'Check the candidate', implement:{text:'Fix the export'}, steering:{text:'Preserve escaping'}},
    otherReports: {handoff:{outcome:'changes', summary:'Check exception path', findings:['Missing callback']}}};
  state.visits = [{node:'work', participant:'unit-0/worker', implementId:'unit-0', cycle:2, taskId:'task-0', taskVersion:1,
    inputId:'msg_real', sessionId:'ses_real', admitted:true, taskContext:context, prompt:'TECHNICAL NOT A TITLE',
    verdict:{outcome:'blocked', summary:'Which API?', questions:['Use v1 or v2?']}}];
  const call = workflowView(state, {root:'/controlled', owned:true}).graph.nodes.find(n=>n.id==='implements').participants[0].invocations[0];
  assert.deepEqual(call.assignment, context.assignment);
  assert.deepEqual(call.handoff, context.otherReports.handoff);
  assert.equal(call.problem, 'Which API?');
  assert.equal(call.cycle, 2);
  assert.equal(call.task, 'Exact requirements 0');
  assert.equal(call.promptRaw, 'TECHNICAL NOT A TITLE');
  assert.equal(call.outcome, 'blocked');
  delete state.visits[0].taskContext;
  const raw = workflowView(state, {root:'/controlled'}).graph.nodes.find(n=>n.id==='implements').participants[0].invocations[0];
  assert.equal(raw.taskSource, 'raw-only');
  assert.equal(raw.taskData, null);
  assert.equal(raw.assignment, null);
});

test('two and eight implement cards have independent expansion and nonoverlapping measured geometry', () => {
  for (const count of [2,8]) {
    const state = fixture(count);
    state.definition.taskPackages[0].title = 'Long meaningful label '.repeat(18);
    const graph = workflowView(state, {root:'/controlled'}).graph;
    const map = layoutGraph(graph, {expandedImplements: new Set(['unit-0','unit-1'])});
    const hub = map.nodes.find(n=>n.id==='implements');
    assert.equal(hub.cards.length, count);
    assert.equal(hub.cards[0].expanded, true);
    assert.equal(hub.cards[0].roles.length, 3);
    if (count===8) assert.equal(hub.cards[2].expanded, false);
    for (const [i,a] of hub.cards.entries()) {
      assert.ok(a.x>=0 && a.x+a.width<=hub.width && a.y+a.height<=hub.height);
      for (const b of hub.cards.slice(i+1)) assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
    }
  }
});

for (const terminal of [
  {verdict:{outcome:'blocked',summary:'Correction requires API clarification'}},
  {error:'Corrected input failed'},
]) test(`a corrected ${terminal.error?'error':'blocked result'} is not attributed to the unsaved original reply`, () => {
  const state = fixture();
  state.visits = [{node:'work',participant:'unit-0/worker',implementId:'unit-0',admitted:true,
    inputId:'msg_original',sessionId:'ses_same',prompt:'Original input',
    correction:{inputId:'msg_correction',prompt:'Exact correction input'},progress:{message:'Correction progress'},...terminal}];
  const [original, corrected] = workflowView(state,{root:'/controlled'}).graph.nodes.find(n=>n.id==='implements').participants[0].invocations;
  assert.equal(original.outcome,null);
  assert.equal(original.problem,null);
  assert.equal(original.resultRaw,null);
  assert.equal(original.progress,null);
  assert.equal(corrected.progress,'Correction progress');
  assert.equal(corrected.outcome,terminal.verdict?.outcome??null);
  assert.equal(corrected.problem,terminal.error??terminal.verdict.summary);
  assert.equal(corrected.id,'msg_correction');
});


test('delta calls retain full logical task data, optional titles and legacy history without parsing prompts', t => {
  const root = mkdtempSync(join(tmpdir(), 'dwf-ui-delivery-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const state = {id:'ui-delivery',definition:eightTasks(),visits:[],workspace:{path:root},taskRevisions:[],status:'running'};
  const title = '  Точное название 😀\r\n';
  state.definition.taskPackages[0].title = title;
  const manager = {node:'manager',participant:'manager',inputId:'msg_manager',sessionId:'ses_manager'};
  prepareRoleInput(root,state,manager);
  assert.equal(manager.taskContext.catalog[0].title,title);
  assert.equal(manager.taskContext.catalog[1].title,undefined);
  const build = inputId => {
    const visit = {node:'worker0',participant:'worker0',inputId,sessionId:'ses_worker',taskId:'task-0',taskVersion:1};
    prepareRoleInput(root,state,visit);
    state.visits.push(visit);
    return visit;
  };
  const first = build('msg_first');
  first.admitted=true;first.admissionStarted=true;acknowledgeContext(first);
  first.verdict={outcome:'done',summary:'First result'};
  const second = build('msg_second');
  second.admitted=true;second.admissionStarted=true;acknowledgeContext(second);
  assert.equal(second.delivery.mode,'delta');
  assert(!second.prompt.includes(state.definition.taskPackages[0].requirements));
  state.visits.push({node:'worker0',inputId:'msg_legacy',admitted:true,prompt:'Legacy raw-only input'});
  const calls=workflowView(state,{root}).graph.nodes.find(n=>n.id==='worker0').participants[0].invocations;
  assert.equal(calls[1].task,state.definition.taskPackages[0].requirements);
  assert.deepEqual(calls[1].taskData,second.taskContext);
  assert.equal(calls[1].taskData.task.title,title);
  assert.deepEqual(calls[1].assignment,second.taskContext.assignment);
  assert.deepEqual(calls[1].contextDelivery,second.delivery);
  assert.equal(calls[1].promptRaw,second.prompt);
  assert.equal(calls[2].taskSource,'raw-only');
  assert.equal(calls[2].taskData,null);
  assert.equal(calls[2].assignment,null);
  assert.equal(calls[2].contextDelivery,undefined);
});
