import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openBrowser} from './browser-probe.mjs';

const [url,evidence]=process.argv.slice(2);
if(!url||!evidence)throw new Error('Pass the preview URL and an evidence directory.');
await mkdir(evidence,{recursive:true});
const browser=await openBrowser(url);
const results=[];
const settled='new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))';
try{
  for(const [width,height] of [[1440,900],[1024,768],[390,844]]){
    await browser.viewport(width,height);
    for(const id of ['research','build','branch','returns','ensemble','large']){
      await browser.evaluate(`document.querySelector('[data-run="${id}"]').click();${settled}`);
      const result=await browser.evaluate(`(()=>{
        const graph=dwfDemo.getGraph(),layout=dwfDemo.getLayout(),collisions=[],labelCollisions=[];
        for(const edge of layout.edges){
          const path=document.querySelector('[data-edge="'+edge.id+'"] .route');
          for(let distance=0;distance<=path.getTotalLength();distance+=3){
            const point=path.getPointAtLength(distance);
            const node=layout.nodes.find(node=>node.id!==edge.from&&node.id!==edge.to&&point.x>node.x+1&&point.x<node.x+node.width-1&&point.y>node.y+1&&point.y<node.y+node.height-1);
            if(node){collisions.push({edge:edge.id,node:node.id});break;}
          }
        }
        for(const label of document.querySelectorAll('[data-route-label]')){
          const box=label.getBBox();
          for(const node of layout.nodes)if(box.x<node.x+node.width&&box.x+box.width>node.x&&box.y<node.y+node.height&&box.y+box.height>node.y)labelCollisions.push({edge:label.dataset.routeLabel,node:node.id});
        }
        const masks=[...document.querySelectorAll('.route-case,.route-label')];
        const heads=[...document.querySelectorAll('.route-head')];
        const headsAboveMasks=heads.every(head=>masks.every(mask=>!!(mask.compareDocumentPosition(head)&Node.DOCUMENT_POSITION_FOLLOWING)));
        const separateMarkers=[...document.querySelectorAll('.route')].every(path=>getComputedStyle(path).markerEnd==='none')&&heads.every(path=>getComputedStyle(path).markerEnd!=='none');
        return {nodes:graph.nodes.length,edges:graph.edges.length,drawn:document.querySelectorAll('[data-edge]').length,heads:heads.length,headsAboveMasks,separateMarkers,finite:layout.edges.every(edge=>edge.points.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y))),overflow:document.documentElement.scrollWidth>innerWidth,collisions,labelCollisions};
      })()`);
      results.push({width,height,id,...result});
      assert.equal(result.drawn,result.edges);
      assert.equal(result.heads,result.edges);
      assert(result.headsAboveMasks);
      assert(result.separateMarkers);
      assert(result.finite);
      assert(!result.overflow);
      assert.deepEqual(result.collisions,[]);
      assert.deepEqual(result.labelCollisions,[]);
      if(width===1440){
        await browser.evaluate(`document.querySelector('#fit').click();${settled}`);
        await browser.screenshot(join(evidence,id+'-overview.png'));
      }
    }
  }
  await browser.viewport(1440,900);
  await browser.evaluate(`document.querySelector('[data-run="ensemble"]').click()`);
  const widths=await browser.evaluate(`({forward:parseFloat(getComputedStyle(document.querySelector('.route.control')).strokeWidth),backward:parseFloat(getComputedStyle(document.querySelector('.route.result')).strokeWidth)})`);
  assert.deepEqual(widths,{forward:2.3,backward:1.25});
  await browser.evaluate(`document.querySelector('[data-run="build"]').click();document.querySelector('[data-edge="reviewer-worker"]').focus();`);
  for(const type of ['keyDown','keyUp'])await browser.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await browser.evaluate(`document.querySelector('[data-edge="reviewer-worker"]').getAttribute('aria-pressed')`),'true');
  assert(await browser.evaluate(`['reviewer-worker','worker-reviewer'].every(id=>getComputedStyle(document.querySelector('[data-edge="'+id+'"]').closest('.edge')).opacity===getComputedStyle(document.querySelector('[data-edge-head="'+id+'"]').closest('.edge-head')).opacity)`));
  const geometry=await browser.evaluate('JSON.stringify(dwfDemo.getLayout())');
  await browser.evaluate(`document.querySelector('[data-primitive="worker"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
  assert(await browser.evaluate(`document.querySelector('#inspector').open`));
  assert.match(await browser.evaluate(`document.querySelector('#command').value`),/demo_ses_worker_01/);
  await browser.evaluate(`document.querySelector('[data-invocation="0"]').click()`);
  assert.equal(await browser.evaluate('JSON.stringify(dwfDemo.getLayout())'),geometry);
  await browser.screenshot(join(evidence,'worker-context.png'));
  await browser.evaluate(`document.querySelector('#inspector').close();document.querySelector('[data-run="research"]').click();document.querySelector('[data-participant="researcher-0"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
  assert.match(await browser.evaluate(`document.querySelector('#command').value`),/demo_ses_r1_b/);
  assert.match(await browser.evaluate(`document.querySelector('.session-block').textContent`),/Fresh session/);
  await browser.screenshot(join(evidence,'researcher-context.png'));
  await browser.evaluate(`document.querySelector('#inspector').close();document.querySelector('[data-run="research"]').click();const graph=dwfDemo.getGraph();graph.nodes[0].label='Scientist with a much longer name for a resized automatic workflow';graph.nodes.push({id:'extra',label:'Extra checkpoint',role:'worker',participants:[]});graph.edges.find(edge=>edge.id==='scientist-scouts').to='extra';graph.edges.push({id:'extra-scouts',from:'extra',to:'scouts',kind:'control',label:'continue'});dwfDemo.showGraph(graph);${settled}`);
  const mutation=await browser.evaluate(`({nodes:dwfDemo.getGraph().nodes.length,edges:dwfDemo.getGraph().edges.length,pairs:dwfDemo.getLayout().edges.filter(edge=>edge.pairedWith).length/2})`);
  assert.deepEqual(mutation,{nodes:6,edges:8,pairs:2});
  await browser.evaluate(`document.querySelector('#fit').click();${settled}`);
  await browser.screenshot(join(evidence,'mutated-graph.png'));
  assert.deepEqual(browser.errors,[]);
  const report={results,mutation,widths,keyboard:true,inspector:true,stableHistory:true,errors:browser.errors};
  await writeFile(join(evidence,'browser-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({cases:results.length,geometryCollisions:results.filter(result=>result.collisions.length||result.labelCollisions.length),mutation,errors:browser.errors}));
}finally{
  await browser.close();
}
