import { runs, toGraph } from '../fixtures.mjs';

// Reconstruct the reviewers' reported two-destination join without coordinates.
// Their ignored scripts/JSON are not present in the implementation workspace.
export function doubleJoinGraph() {
  const graph=toGraph(runs.find(r=>r.id==='branch'));
  graph.nodes.push({id:'audit',label:'Audit release',role:'reviewer',participants:[]});
  graph.edges.push(
    {id:'docs-audit',from:'docs',to:'audit',kind:'control',label:'audit'},
    {id:'tests-audit',from:'tests',to:'audit',kind:'control',label:'check'},
    {id:'audit-end',from:'audit',to:'end',kind:'control',label:'verified'},
  );
  return graph;
}

export function multiInputGroupGraph() {
  const graph=toGraph(runs.find(r=>r.id==='ensemble'));
  for(const [i,label] of ['audit','check','approve translation','cross-check sources'].entries()) {
    const id=`independent-${i}`;
    graph.nodes.push({id,label:`Independent editor ${i+1}`,role:'worker',participants:[]});
    graph.edges.push({id:`${id}-languages`,from:id,to:'languages',kind:'control',label});
  }
  return graph;
}

export function manyWayJoinGraph() {
  const graph={nodes:[{id:'start',label:'Plan the independent checks',role:'worker',participants:[]}],edges:[]};
  for(let i=0;i<6;i++) {
    const id=`check-${i}`;
    graph.nodes.push({id,label:`Independent evidence check ${i+1}`,role:'verifier',participants:[]});
    graph.edges.push({id:`start-${id}`,from:'start',to:id,kind:'control',label:'delegate'});
    graph.edges.push({id:`${id}-join`,from:id,to:'join',kind:'control',label:`evidence ${i+1} verified`});
  }
  graph.nodes.push({id:'join',label:'Combine independent evidence',role:'scientist',participants:[]},{id:'end',label:'End',role:'terminal',participants:[]});
  graph.edges.push({id:'join-end',from:'join',to:'end',kind:'control',label:'accept'});
  return graph;
}
