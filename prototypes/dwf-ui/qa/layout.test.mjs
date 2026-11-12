import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from '../layout.mjs';
import { runs, toGraph } from '../fixtures.mjs';

function assertCaptionsClear(map) {
  // Independent rectangle oracle for the supplied 8px/glyph metric:
  // 14px lettering, 18px line height, and the renderer's 7px paint mask.
  const boxes=map.edges.filter(e=>e.label.text).map(e=>{
    const lines=e.label.lines||[e.label.text],width=Math.max(...lines.map(t=>t.length*8));
    return {id:e.id,x:e.label.x-(e.label.anchor==='end'?width:e.label.anchor==='middle'?width/2:0)-3.5,y:e.label.y-17.5,width:width+7,height:18*lines.length+7};
  });
  const separate=(a,b)=>a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y;
  for(const [i,a] of boxes.entries()) {
    for(const b of boxes.slice(i+1))assert.ok(separate(a,b),`Caption collision: ${a.id} / ${b.id}`);
    for(const n of map.nodes)assert.ok(separate(a,n),`Caption ${a.id} overlaps node ${n.id}`);
  }
}

function inspect(graph) {
  const map = layoutGraph(graph,{measure:text=>text.length*8});
  assertCaptionsClear(map);
  assert.equal(map.nodes.length, graph.nodes.length);
  assert.equal(map.edges.length, graph.edges.length);
  for (const a of map.nodes) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= map.width && a.y + a.height <= map.height);
    for (const b of map.nodes.filter(b => b.id !== a.id)) {
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} overlaps ${b.id}`);
    }
  }
  for (const edge of map.edges) {
    assert.ok(edge.points.length >= 2);
    for (let i = 1; i < edge.points.length; i++) {
      const [a,b] = [edge.points[i-1], edge.points[i]];
      assert.ok(a.x === b.x || a.y === b.y, `non-orthogonal ${edge.id}`);
      for (const n of map.nodes) {
        const inside = a.x === b.x
          ? a.x > n.x + 1 && a.x < n.x+n.width-1 && Math.max(a.y,b.y)>n.y+1 && Math.min(a.y,b.y)<n.y+n.height-1
          : a.y > n.y + 1 && a.y < n.y+n.height-1 && Math.max(a.x,b.x)>n.x+1 && Math.min(a.x,b.x)<n.x+n.width-1;
        assert.ok(!inside, `${edge.id} crosses ${n.id}`);
      }
    }
    assert.ok(edge.label.x >= 0 && edge.label.y > 0);
  }
  return map;
}
for (const run of runs) test(`automatic routing: ${run.id}`, () => inspect(toGraph(run)));
test('renamed nodes, added branch, seven parallel participants: no coordinates', () => {
  const graph = structuredClone(toGraph(runs[0]));
  graph.nodes[0].label = 'A newly renamed principal investigator with a very long title';
  const group = graph.nodes.find(n => n.id === 'researchers');
  group.participants.push(...Array.from({length:3}, (_,i) => ({...structuredClone(group.participants[0]), id:`extra-${i}`, name:`Independent extra participant ${i+1}`})));
  graph.nodes.push({id:'extra',label:'An additional independent validation step',role:'verifier',participants:[]});
  graph.edges.push({id:'additional',from:'committee',to:'extra',label:'additional check',kind:'control'});
  inspect(graph);
});
test('execution and history do not change placement or routing', () => {
  const graph = toGraph(runs[0]), before = layoutGraph(graph);
  for (const n of graph.nodes) for (const p of n.participants || []) for (const v of p.invocations) v.state = 'done';
  assert.deepEqual(layoutGraph(graph), before);
});
test('invalid references and undesignated cycles are reported', () => {
  assert.throws(() => layoutGraph({nodes:[{id:'a',label:'A'}],edges:[{id:'x',from:'a',to:'missing'}]}), /unknown/i);
  assert.throws(() => layoutGraph({nodes:[{id:'a',label:'A'},{id:'b',label:'B'}],edges:[{id:'x',from:'a',to:'b'},{id:'y',from:'b',to:'a'}]}), /cycle/i);
});
test('core workflow contracts and actual session identity', () => {
  const research=toGraph(runs.find(r=>r.id==='research'));
  assert.deepEqual(research.edges.map(e=>[e.from,e.to,e.kind,!!e.reentry]),[
    ['scientist','scouts','control',false],['scientist','researchers','control',false],['scientist','committee','control',false],['committee','end','control',false],['scouts','scientist','result',false],['researchers','scientist','result',false],['committee','scientist','control',true],
  ]);
  const scientist=research.nodes[0].participants[0];
  assert.equal(new Set(scientist.invocations.map(v=>v.session)).size,1);
  const scouts=research.nodes.find(n=>n.id==='scouts').participants;
  assert.equal(scouts.length,2);assert.notEqual(scouts[0].invocations[0].session,scouts[1].invocations[0].session);
  for(const p of scouts){assert.equal(p.memory,true);assert.equal(new Set(p.invocations.map(v=>v.session)).size,1);}
  const researchers=research.nodes.find(n=>n.id==='researchers').participants;
  assert.equal(researchers.length,4);
  for(const p of [...researchers,...research.nodes.find(n=>n.id==='committee').participants]){
    assert.equal(p.memory,false);assert.ok(p.invocations.length>1);assert.equal(new Set(p.invocations.map(v=>v.session)).size,p.invocations.length);
  }
  const build=toGraph(runs.find(r=>r.id==='build'));
  assert.deepEqual(build.edges.map(e=>[e.from,e.to,!!e.reentry]),[['worker','reviewer',false],['reviewer','verifier',false],['verifier','end',false],['reviewer','worker',true],['verifier','worker',true]]);
  assert.equal(new Set(build.nodes[0].participants[0].invocations.map(v=>v.session)).size,1);
});
test('alignment stays compact rather than drifting into empty space', () => {
  for(const id of ['research','branch','large']) {
    const map=layoutGraph(toGraph(runs.find(r=>r.id===id)));
    assert.ok(Math.min(...map.nodes.map(n=>n.y))<65);
    assert.ok(map.height<1000,`${id} has unnecessary vertical drift`);
  }
});
test('extra reentry and self-return are routed without node collisions', () => {
  const graph=toGraph(runs.find(r=>r.id==='large'));
  graph.edges.push({id:'extra-return',from:'stream-3-3',to:'intake',kind:'control',reentry:true,label:'broaden the evidence'});
  graph.edges.push({id:'self-return',from:'stream-1-1',to:'stream-1-1',kind:'control',reentry:true,label:'retry'});
  inspect(graph);
});
test('generated branch/join topologies use the same routing invariants', () => {
  for(let seed=1;seed<=12;seed++) {
    const nodes=[],edges=[],layers=[];
    for(let rank=0;rank<4;rank++) {
      const layer=Array.from({length:rank===0?1:1+(seed*rank)%4},(_,i)=>({id:`n-${rank}-${i}`,label:`Independent verification ${rank+1} perspective ${i+1}`,role:'verifier',participants:[]}));
      nodes.push(...layer);layers.push(layer);
      if(rank)for(let i=0;i<layer.length;i++) {
        const prior=layers[rank-1];
        edges.push({id:`forward-${rank}-${i}`,from:prior[i%prior.length].id,to:layer[i].id,kind:'control',label:'verified'});
        if(prior.length>1)edges.push({id:`join-${rank}-${i}`,from:prior[(i+1)%prior.length].id,to:layer[i].id,kind:'control',label:'reviewed'});
      }
    }
    edges.push({id:'reentry',from:layers[3][0].id,to:layers[0][0].id,kind:'control',reentry:true,label:'revise the evidence'});
    inspect({nodes,edges});
  }
});

test('two parallel join destinations have independently readable captions', async () => {
  const { doubleJoinGraph }=await import('./review-graphs.mjs');
  const map=layoutGraph(doubleJoinGraph(),{measure:text=>text.length*8});
  assertCaptionsClear(map);
});

test('many-way joins and multi-input groups reserve label-sized input banks', async () => {
  const { multiInputGroupGraph,manyWayJoinGraph }=await import('./review-graphs.mjs');
  for(const graph of [multiInputGroupGraph(),manyWayJoinGraph()])inspect(graph);
});
