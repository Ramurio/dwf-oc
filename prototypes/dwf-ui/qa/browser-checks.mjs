import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { openBrowser } from './browser-probe.mjs';
const root=resolve(import.meta.dirname,'..'),evidence=resolve(root,'.evidence/implementation');
await mkdir(evidence,{recursive:true});
const server=createServer(async(req,res)=>{
  try {const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!path.startsWith(root+'/')&&path!==root)throw Error('path');const file=path===root||path===root+'/'?root+'/index.html':path;res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.mjs':'text/javascript'})[extname(file)]||'text/plain');res.end(await readFile(file));}catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
let browser;const checks=[];
try {
  browser=await openBrowser(url+'/');
  const {evaluate:ev,send}=browser;
  await ev(`new Promise((resolve,reject)=>{let n=0;const wait=()=>{if(window.dwfDemo)resolve(true);else if(n++>100)reject(Error('App did not initialize'));else setTimeout(wait,50)};wait()})`);
  const click=async selector=>{
    const point=await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing control');el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  const shot=name=>browser.screenshot(resolve(evidence,name+'.png'));
  const fixture=async id=>{if(await ev(`matchMedia('(max-width:760px)').matches && !document.querySelector('#run-menu').open`))await click('#run-menu summary');await click(`[data-run="${id}"]`);assert.equal(await ev(`document.querySelector('[data-run="${id}"]').getAttribute('aria-pressed')`),'true');};
  const text=()=>ev('document.body.innerText');
  assert.equal(await ev(`document.querySelector('[data-run="research"]').getAttribute('aria-pressed')`),'true');
  // Status counts must describe the selected observation cohort, not infer
  // "working" merely because more than one participant is present.
  const statusGeometry=await ev('JSON.stringify(dwfDemo.getLayout())');
  const assertSummary=async expected=>{
    assert.equal(await ev('document.querySelector("#current").textContent'),expected);
    assert.equal(await ev('JSON.stringify(dwfDemo.getLayout())'),statusGeometry);
  };
  await assertSummary('Interface is working');
  await ev(`dwfDemo.setParticipantState('researcher-3','waiting')`);
  await shot('waiting-status');
  await assertSummary('2 participants are waiting for results');
  assert.equal(await ev(`document.querySelectorAll('.primitive.active,.participant.active').length`),0);
  await click('#current');await click('[data-invocation="0"]');
  assert.ok(await ev(`document.querySelector('.past-note').textContent.includes('2 participants are waiting for results')`));
  await click('[data-close]');
  await ev(`dwfDemo.setParticipantState('researcher-3','done')`);
  await assertSummary('Scientist is waiting for results');
  await ev(`dwfDemo.setParticipantState('scientist','done')`);
  await assertSummary('No participants are working');
  assert.equal(await ev('document.querySelector("#current").disabled'),true);
  await ev(`dwfDemo.setParticipantState('researcher-3','active')`);
  await assertSummary('Interface is working');
  await ev(`dwfDemo.setParticipantState('researcher-2','active')`);
  await assertSummary('2 participants are working');
  await ev(`dwfDemo.setParticipantState('scientist','waiting')`);
  await assertSummary('2 participants are working'); // Active work takes priority over waiting.
  await fixture('research');
  checks.push('Single/multiple working and waiting, mixed and completed status summaries agree with observations; history and geometry remain stable');
  for(const [w,h] of [[1440,900],[1280,720],[1024,768],[390,844]]) {
    await browser.viewport(w,h);await fixture('research');await shot(`research-${w}x${h}`);
    assert.ok(await ev('document.documentElement.scrollWidth<=innerWidth'),`page overflow ${w}`);
    if(w>=1280){
      await click('#fit');
      assert.ok(await ev(`(()=>{const view=document.querySelector('#map-viewport').getBoundingClientRect();return Array.from(document.querySelectorAll('[data-route-label]')).every(el=>{const r=el.getBoundingClientRect();return r.top>=view.top&&r.bottom<=view.bottom})})()`),'Fit must show all core research route labels');
    }
    await fixture('build');await shot(`build-${w}x${h}`);
    await click('[data-primitive="worker"]');assert.ok((await text()).includes('demo_ses_worker_01'));await shot(`detail-${w}x${h}`);await click('[data-close]');
    checks.push(`${w}x${h}: both core maps, worker details, no document horizontal overflow`);
  }
  await browser.viewport(1440,900);
  for(const id of ['branch','returns','ensemble','large']){await fixture(id);await shot(id);await click('#fit');await shot(id+'-overview');}
  checks.push('All six fixtures rendered at 1440x900, including fit overview');
  await fixture('research');
  const geometry=await ev('JSON.stringify(dwfDemo.getLayout())');
  const activeBefore=await ev(`document.querySelectorAll('.participant.active').length`);
  await click('[data-participant="researcher-3"]');
  assert.ok((await text()).includes('demo_ses_r4_b'));
  await click('[data-invocation="0"]');
  assert.ok((await text()).includes('demo_ses_r4_a'));assert.equal(await ev(`document.querySelector('#command').value`),'opencode --session demo_ses_r4_a');
  assert.ok((await text()).includes('Inspecting an earlier call.'));assert.ok((await text()).includes('Keep the architecture visible'));
  assert.equal(await ev('JSON.stringify(dwfDemo.getLayout())'),geometry);assert.equal(await ev(`document.querySelectorAll('.participant.active').length`),activeBefore);
  await click('details.skills summary');assert.ok((await text()).includes('Interface evaluation'));
  await click('#latest');assert.ok((await text()).includes('demo_ses_r4_b'));assert.ok((await text()).includes('Fresh session'));
  await shot('research-current-detail');
  // Clipboard API success is read back from the actual isolated browser clipboard.
  await send('Browser.grantPermissions',{origin:url,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await click('#copy');
  assert.equal(await ev('navigator.clipboard.readText()'),'opencode --session demo_ses_r4_b');
  assert.ok((await text()).includes('Command copied.'));
  await ev(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Denied by test')}}})`);
  await click('#copy');
  assert.ok((await text()).includes('Could not copy.'));
  assert.equal(await ev('document.activeElement.id'),'command');
  assert.equal(await ev('document.querySelector("#command").selectionEnd-document.querySelector("#command").selectionStart'),'opencode --session demo_ses_r4_b'.length);
  await shot('clipboard-fallback');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
  await ev(`new Promise(r=>setTimeout(r,100))`);assert.equal(await ev('document.querySelector("#inspector").open'),false);
  assert.equal(await ev('document.activeElement.dataset.participant'),'researcher-3');
  // Verify actual keyboard activation and native modal focus containment.
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  assert.equal(await ev('document.querySelector("#inspector").open'),true);
  await ev(`document.querySelector('.back-map').focus()`);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});
  assert.equal(await ev('document.querySelector("#inspector").contains(document.activeElement)'),true);
  await click('[data-close]');
  checks.push('Research old/current result, task, fresh IDs, skills, stable map, exact clipboard readback, denied-copy selection fallback, Enter/Escape and modal Tab containment');
  await fixture('build');await click('[data-primitive="worker"]');await click('[data-invocation="0"]');
  assert.equal(await ev('document.querySelector("#command").value'),'opencode --session demo_ses_worker_01');
  assert.ok((await text()).includes('Add Markdown export'));
  await click('#latest');assert.ok((await text()).includes('Same session'));assert.ok((await text()).includes('empty note'));
  await click('[data-close]');
  checks.push('Old/latest worker invocations keep the same session, with corresponding task and command');
  await fixture('research');
  for(const [id,expected] of [['scouts','Same session'],['committee','Fresh session'],['scientist','Same session']]) {
    await click(`[data-primitive="${id}"]`);assert.ok((await text()).includes(expected));
    if(id==='scouts'){await click('[data-pick="scout-1"]');assert.equal(await ev(`document.querySelector('[data-session]').textContent`),'demo_ses_scout_2');}
    await click('[data-close]');
  }
  checks.push('Independent scout member IDs; continuing scientist and scouts; actual old/new committee review IDs');
  await browser.viewport(390,844);await fixture('research');await click('#current');assert.ok((await text()).includes('demo_ses_r4_b'));await click('[data-close]');
  await click('#help-open');assert.equal(await ev('document.querySelector("#help").open'),true);await click('#help-close');
  checks.push('Narrow current-participant jump, run navigation, guide open/close');
  await browser.viewport(1440,900);
  await fixture('research');
  await ev(`{const g=dwfDemo.getGraph();g.nodes[0].label='Principal investigator';g.nodes.find(n=>n.id==='end').label='Exit';const n=g.nodes.find(n=>n.id==='researchers');for(let i=0;i<3;i++){const p=structuredClone(n.participants[0]);p.id='added-'+i;p.name='Additional perspective '+(i+1);n.participants.push(p)}g.nodes.push({id:'independent-check',label:'Independent validation after committee',role:'verifier',participants:[]});g.edges.push({id:'extra-check',from:'committee',to:'independent-check',kind:'control',label:'extra check'});dwfDemo.showGraph(g)}`);
  assert.ok(await ev(`document.querySelector('#map').textContent.includes('Exit')`),'Terminal names must also come from data');
  await shot('modified-graph');await click('#fit');await shot('modified-graph-overview');
  await click('[data-primitive="independent-check"]');assert.ok((await text()).includes('No recorded invocation.'));assert.equal(await ev('document.querySelector("#command")'),null);await click('[data-close]');
  checks.push('Renamed terminal is rendered from data; unobserved primitive opens truthful empty details without a session command');
  const modified=await ev('JSON.stringify(dwfDemo.getLayout())');await ev(`dwfDemo.setParticipantState('researcher-3','done')`);assert.equal(await ev('JSON.stringify(dwfDemo.getLayout())'),modified);assert.ok(!(await ev('document.querySelector("#current").textContent')).includes('Interface'));
  checks.push('In-browser renamed scientist, added primitive and edge, group 4→7, status update without coordinate edits or geometry change');
  await fixture('research');
  await ev(`{const g=dwfDemo.getGraph();g.nodes[0].label='WWWWWWWWWWWWWWWWWWWWWWWW';g.nodes.find(n=>n.id==='researchers').participants[0].name='WWWWWWWWWWWWWWWWWWWWWWWW';dwfDemo.showGraph(g)}`);
  const overflow=await ev(`Array.from(document.querySelectorAll('.node-title,.member-name')).filter(el=>{const r=el.getBBox(),n=el.closest('[data-node]'),width=Number(n.querySelector('.node-surface').getAttribute('width'));return r.x+r.width>width-(el.classList.contains('member-name')?50:8)}).map(el=>el.textContent)`);
  assert.deepEqual(overflow,[],'Wide glyphs must fit, not just average character counts');
  await shot('wide-labels');checks.push('Wide-glyph titles and participant names wrap inside their platform bounds');
  await fixture('large');await click('#zoom-reset');await shot('large-readable');
  // Text enlargement uses CSS font enlargement, not a DPR/viewport equivalence.
  await fixture('research');await ev(`document.documentElement.style.fontSize='200%';const style=document.createElement('style');style.id='enlarged-text-check';style.textContent='body{font-size:28px}button{font-size:1em}.run strong{font-size:1em}.node-title{font-size:22px}';document.head.append(style)`);
  await shot('enlarged-text');
  await ev(`document.querySelector('#enlarged-text-check').remove();document.documentElement.style.fontSize=''`);
  await browser.viewport(1280,520);await fixture('research');await shot('short-viewport');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await ev('matchMedia("(prefers-reduced-motion:reduce)").matches'),true);
  await shot('reduced-motion');
  await browser.viewport(1280,720);await fixture('research');
  await send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  assert.equal(await ev('visualViewport.scale'),2);await shot('pinch-zoom-200');
  await send('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  checks.push('Actual CDP page/pinch scale 2 screenshot; this is not native browser UI zoom');
  assert.ok(await ev(`performance.getEntriesByType('resource').every(r=>r.name.startsWith(location.origin))`));
  checks.push('All loaded page resources are local; no third-party assets');
  checks.push('Short 1280x520 viewport and reduced-motion media exercised; enlarged-text exploratory screenshot (not native browser zoom)');
  await browser.viewport(1440,900);await send('Page.navigate',{url:url+'/baseline.html'});
  await ev(`new Promise(r=>setTimeout(r,250))`);await shot('baseline-1440x900');
  assert.deepEqual(browser.errors,[]);
  const report={checks,errors:browser.errors,evidence,limitations:['Chrome only. Native-zoom and backward-focus regressions are checked separately by qa/review-regressions.mjs.','Independent design/usability scores are not assigned by this implementation check.']};
  await writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  if(browser)await browser.close();await new Promise(r=>server.close(r));
}
