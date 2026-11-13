import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { openBrowser } from './browser-probe.mjs';
import { doubleJoinGraph,multiInputGroupGraph,manyWayJoinGraph } from './review-graphs.mjs';

const root=resolve(import.meta.dirname,'..');
const evidence=resolve(root,'.evidence/implementation');
const phase=process.argv[2]||'after';
await mkdir(evidence,{recursive:true});
const server=createServer(async(req,res)=>{
  try {
    const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!path.startsWith(root+'/')&&path!==root)throw Error('path');
    const file=path===root?root+'/index.html':path;
    res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.mjs':'text/javascript'})[extname(file)]||'text/plain');
    res.end(await readFile(file));
  } catch {res.writeHead(404);res.end('Not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`;
const report={phase,checks:[],failures:[],errors:[]};
const shot=(browser,name)=>browser.screenshot(resolve(evidence,`review-${phase}-${name}.png`));
async function ready(browser) {
  await browser.evaluate(`new Promise((resolve,reject)=>{let tries=0;const wait=()=>{if(window.dwfDemo)resolve(true);else if(tries++>100)reject(Error('App not ready'));else setTimeout(wait,50)};wait()})`);
}
async function check(name,run) {
  try {await run();report.checks.push(name);}
  catch(error) {report.failures.push({name,message:error.message});}
}
// Actual DOM text bounds plus the paint-order mask are the collision oracle,
// independent of the router's own metrics and spacing decisions.
async function captionCollisions(browser) {
  return browser.evaluate(`(()=>{
    const boxes=Array.from(document.querySelectorAll('[data-route-label]')).filter(el=>el.textContent.trim()).map(el=>{
      const b=el.getBoundingClientRect(),mask=parseFloat(getComputedStyle(el).strokeWidth)/2*el.getScreenCTM().a;
      return {id:el.dataset.routeLabel,x:b.left-mask,y:b.top-mask,right:b.right+mask,bottom:b.bottom+mask};
    });
    const nodes=Array.from(document.querySelectorAll('.node-surface')).map(el=>{
      const b=el.getBoundingClientRect();return {id:'node/'+el.closest('[data-node]').dataset.node,x:b.left,y:b.top,right:b.right,bottom:b.bottom};
    });
    const overlaps=(a,b)=>Math.min(a.right,b.right)>Math.max(a.x,b.x)+.1&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)+.1;
    return boxes.flatMap((a,i)=>[...boxes.slice(i+1),...nodes].filter(b=>overlaps(a,b)).map(b=>[a.id,b.id]));
  })()`);
}

try {
  const browser=await openBrowser(url);
  try {
    await ready(browser);
    await check('all six fixtures: rendered captions do not collide',async()=>{
      for(const id of ['research','build','branch','returns','ensemble','large']) {
        await browser.evaluate(`document.querySelector('[data-run="${id}"]').click()`);
        assert.deepEqual(await captionCollisions(browser),[],id);
      }
    });
    await browser.evaluate(`document.querySelector('[data-run="branch"]').click()`);
    for(const [width,height] of [[1440,900],[1280,720],[1024,768],[390,844]]) {
      await browser.viewport(width,height);
      await browser.evaluate(`dwfDemo.showGraph(${JSON.stringify(doubleJoinGraph())})`);
      for(const mode of ['initial','fit','100'])await check(`double join ${width}×${height}: ${mode} captions clear captions/platforms`,async()=>{
        if(mode!=='initial')await browser.evaluate(`document.querySelector('${mode==='fit'?'#fit':'#zoom-reset'}').click()`);
        await shot(browser,`double-join-${width}x${height}-${mode}`);
        assert.deepEqual(await captionCollisions(browser),[]);
      });
    }
    await check('390px large-map Fit displays the whole topology',async()=>{
      await browser.evaluate(`document.querySelector('[data-run="large"]').click();document.querySelector('#fit').click()`);
      const size=await browser.evaluate(`({map:document.querySelector('#map').getBoundingClientRect().width,viewport:document.querySelector('#map-viewport').clientWidth})`);
      await shot(browser,'large-narrow-fit');assert.ok(size.map+24<=size.viewport,JSON.stringify(size));
    });
    await browser.viewport(1440,900);
    await browser.evaluate(`document.querySelector('[data-run="branch"]').click()`);
    for(const [name,graph] of [['multi-input-group',multiInputGroupGraph()],['many-way-join',manyWayJoinGraph()]]) {
      await browser.evaluate(`dwfDemo.showGraph(${JSON.stringify(graph)})`);
      await check(`${name}: captions clear other captions and platforms`,async()=>{
        await shot(browser,name);assert.deepEqual(await captionCollisions(browser),[]);
      });
    }
    report.errors.push(...browser.errors);
  } finally {await browser.close();}

  const zoomed=await openBrowser(url,{zoom:2});
  try {
    await ready(zoomed);
    report.nativeZoom=await zoomed.evaluate('({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,pinch:visualViewport.scale})');
    await check('native Chrome 200% zoom is real reflow, not pinch/DPR emulation',async()=>{
      assert.equal(report.nativeZoom.dpr,2);assert.equal(report.nativeZoom.width,720);assert.equal(report.nativeZoom.pinch,1);
    });
    await zoomed.evaluate(`document.querySelector('#current').click()`);
    const tab=async shift=>{
      for(const type of ['keyDown','keyUp'])await zoomed.send('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9,modifiers:shift?8:0});
      await zoomed.evaluate('new Promise(r=>setTimeout(r,35))');
    };
    const focusBounds=()=>zoomed.evaluate(`(()=>{
      const el=document.activeElement,header=document.querySelector('.detail-top'),dialog=document.querySelector('#inspector');
      const r=el.getBoundingClientRect(),h=header.getBoundingClientRect(),d=dialog.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      const path=[];for(let n=el;n&&n!==dialog;n=n.parentElement)path.unshift(n.tagName+':'+Array.from(n.parentElement.children).indexOf(n));
      return {key:path.join('/'),text:el.textContent.trim(),top:r.top,bottom:r.bottom,headerBottom:h.bottom,dialogBottom:d.bottom,inHeader:header.contains(el),inDialog:dialog.contains(el),hit:el===hit||el.contains(hit)};
    })()`);
    const assertFocus=f=>{
      assert.ok(f.inDialog,JSON.stringify(f));
      assert.ok(f.inHeader||f.top>=f.headerBottom+4,JSON.stringify(f));
      assert.ok(f.bottom<=Math.min(f.dialogBottom-4,report.nativeZoom.height-8),JSON.stringify(f));
      assert.ok(f.hit,JSON.stringify(f));
    };
    // Navigate with real keys until a semantic target, never a fixed Tab index.
    // Repetition detects an unreachable target; the bound only guards a broken trap.
    const tabTo=async(selector,shift=false)=>{
      const seen=new Set();
      for(let i=0;i<100;i++) {
        await tab(shift);const f=await focusBounds();assertFocus(f);
        if(await zoomed.evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`))return f;
        assert.ok(!seen.has(f.key),`Unreachable keyboard target: ${selector}`);seen.add(f.key);
      }
      assert.fail(`Keyboard traversal did not reach ${selector}`);
    };
    await check('native 200% zoom: Skills reached forward and backward stays visible below sticky heading',async()=>{
      await tabTo('.skills > summary');
      await tabTo('#command');
      report.focusAfterSequence=await tabTo('.skills > summary',true);
      await shot(zoomed,'focus-200');
      // The disclosure must actually work from the keyboard, not just receive focus.
      for(const type of ['keyDown','keyUp'])await zoomed.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})});
      assert.equal(await zoomed.evaluate(`document.querySelector('.skills').open`),true);
      assert.equal(await zoomed.evaluate(`document.querySelector('.skills strong').checkVisibility()`),true);
    });
    await check('native 200% zoom: every forward/backward focused control is unobscured',async()=>{
      const targets=['[data-close="header"]','.member-picker button','.call-picker button','[data-detail-key="technical-session"] > summary','.skills > summary','#copy','#command','.history > summary','.back-map'];
      for(const shift of [false,true]) {
        // A full focus cycle, with coverage tied to controls rather than step count.
        await tabTo('.skills > summary',shift);
        const first=(await focusBounds()).key,seen=new Set(),reached=new Set();
        for(let i=0;i<100;i++) {
          await tab(shift);const f=await focusBounds();assertFocus(f);
          for(const selector of targets)if(await zoomed.evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`))reached.add(selector);
          if(f.key===first)break;
          assert.ok(!seen.has(f.key),'Focus cycle did not return to Skills');seen.add(f.key);
          assert.ok(i<99,'Focus cycle did not finish');
        }
        assert.deepEqual([...reached].sort(),[...targets].sort(),shift?'backward controls':'forward controls');
      }
    });
    report.errors.push(...zoomed.errors);
  } finally {await zoomed.close();}
  assert.deepEqual(report.errors,[]);
} finally {await new Promise(r=>server.close(r));}
await writeFile(resolve(evidence,`review-${phase}-report.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.failures.length)process.exitCode=1;
