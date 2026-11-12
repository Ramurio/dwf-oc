import assert from 'node:assert/strict';
import {runs,toGraph} from '../fixtures.mjs';
import {layoutGraph,offsetPolyline} from '../layout.mjs';

const expectedPairs={research:3,build:1,branch:0,returns:1,ensemble:1,large:1};
for(const run of runs){
  const graph=toGraph(run),layout=layoutGraph(graph);
  assert.deepEqual(layout.edges.map(edge=>edge.id),graph.edges.map(edge=>edge.id));
  assert.equal(layout.edges.filter(edge=>edge.pairedWith).length,expectedPairs[run.id]*2);
  for(const edge of layout.edges){
    assert(edge.points.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)));
    if(!edge.pairedWith)continue;
    const partner=layout.edges.find(other=>other.id===edge.pairedWith);
    assert.equal(partner.from,edge.to);
    assert.equal(partner.to,edge.from);
    assert.equal(partner.pairedWith,edge.id);
    const ownStart=edge.points[0],otherEnd=partner.points.at(-1);
    assert.equal(ownStart.x,otherEnd.x);
    assert.equal(Math.abs(ownStart.y-otherEnd.y),6);
  }
  const changed=structuredClone(graph);
  for(const node of changed.nodes)for(const person of node.participants||[])for(const call of person.invocations)call.state='done';
  assert.deepEqual(layoutGraph(changed),layout);
}

const ensemble=layoutGraph(toGraph(runs.find(run=>run.id==='ensemble')));
const group=ensemble.nodes.find(node=>node.id==='languages');
const next=ensemble.nodes.find(node=>node.id==='merge');
const groupOutput=ensemble.edges.find(edge=>edge.id==='languages-merge');
assert.equal(groupOutput.points[0].y,group.y+group.height/2);
assert.equal(groupOutput.points.at(-1).y,next.y+next.height/2);
const intoGroup=ensemble.edges.find(edge=>edge.id==='editor-languages');
const outOfGroup=ensemble.edges.find(edge=>edge.id==='languages-editor');
assert.equal((intoGroup.points.at(-1).y+outOfGroup.points[0].y)/2,group.y+group.height/2);
const resizedGroup=toGraph(runs.find(run=>run.id==='ensemble'));
resizedGroup.nodes.find(node=>node.id==='languages').label='Language review group with a substantially longer title';
resizedGroup.nodes.find(node=>node.id==='languages').participants.pop();
const resizedLayout=layoutGraph(resizedGroup);
const resized=resizedLayout.nodes.find(node=>node.id==='languages');
const resizedOutput=resizedLayout.edges.find(edge=>edge.id==='languages-merge');
assert.equal(resizedOutput.points[0].y,resized.y+resized.height/2);

const node=id=>({id,label:id,role:'worker',participants:[]});
const transition=(id,from,to,more={})=>({id,from,to,label:id,kind:'control',...more});
const triangle={nodes:['a','b','c'].map(node),edges:[transition('ab','a','b'),transition('bc','b','c'),transition('ca','c','a',{reentry:true})]};
assert(layoutGraph(triangle).edges.every(edge=>!edge.pairedWith));

const multiple={nodes:['a','b'].map(node),edges:[transition('ab','a','b'),transition('ba','b','a',{kind:'result'}),transition('again','b','a',{reentry:true})]};
const multipleLayout=layoutGraph(multiple);
assert.equal(multipleLayout.edges.length,3);
assert.equal(multipleLayout.edges.filter(edge=>edge.pairedWith).length,2);
assert.equal(multipleLayout.edges.find(edge=>edge.id==='again').pairedWith,undefined);

const split=structuredClone(multiple);
split.nodes.push(node('middle'));
split.edges[0].to='middle';
split.edges.push(transition('middle-b','middle','b'));
assert(layoutGraph(split).edges.every(edge=>!edge.pairedWith));
assert.throws(()=>layoutGraph({nodes:[node('a')],edges:[transition('bad','a','missing')]}),/Unknown endpoint/);
assert.deepEqual(offsetPolyline([{x:0,y:0},{x:0,y:0},{x:50,y:0},{x:50,y:30}],4),[{x:0,y:4},{x:46,y:4},{x:46,y:30}]);
assert.deepEqual(offsetPolyline([{x:0,y:0}],4),[{x:0,y:0}]);
console.log('Six original graphs, reciprocal topology, parallel returns, split edges, stable state and offset geometry passed.');
