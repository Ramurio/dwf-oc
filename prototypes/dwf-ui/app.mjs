const live=document.body.dataset.live==='true';
let runs=[],skills={};
if(!live)({runs,skills}=await import('./fixtures.mjs'));
const toGraph=run=>structuredClone(run.graph??{nodes:run.nodes,edges:run.edges});
import { layoutGraph, roundedPath } from './layout.mjs';
const $ = s => document.querySelector(s);
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = (x,y,value,cls,extra='') => `<text x="${x}" y="${y}" class="${cls}" ${extra}>${esc(value)}</text>`;
const callTime=value=>{const date=new Date(value);return Number.isNaN(date.valueOf())?value:new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date);};
const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
const active = p => p.active ?? p.invocations?.at(-1)?.state==='active';
const observedState = p => p && Object.hasOwn(p,'currentState') ? p.currentState : p?.invocations?.at(-1)?.state;
const states = {active:'Working now',done:'Result received',waiting:'Waiting for results',failed:'Failed',cancelled:'Stopped',unknown:'No current observation'};
const measureCanvas=document.createElement('canvas').getContext('2d');
const measure=(value,size=18,weight=400)=>{measureCanvas.font=`${weight} ${size}px ${getComputedStyle(document.body).fontFamily}`;return measureCanvas.measureText(value).width;};
const marks = `<defs>${[['control','var(--line)',2.3],['result','var(--result)',1.25],['return','var(--return)',1.25]].map(([kind,color,width])=>`<marker id="${kind}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L9 5L1 9" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join('')}</defs>`;
const expansions=new Map();
let expandedImplements=new Set();
let run, graph, geometry, scale=1, selection=null, selectedEdge=null, hoveredEdge=null, invocation=0, invoker=null, copyGeneration=0, runDetailsSignature=null;
const viewport=$('#map-viewport'), inspector=$('#inspector');
const announce = message => { $('#announcement').textContent=message; };
function currentParticipants() {
  const participants=graph.nodes.flatMap(n=>n.participants||[]),working=participants.filter(active);
  const current=working.length?working:participants.filter(p=>observedState(p)==='waiting');
  return [...new Map(current.map(p=>[p.id,p])).values()];
}
function currentSummary() {
  const people=currentParticipants();
  if(!people.length)return live?'No active participant observed':'No participants are working';
  const state=active(people[0])?'working':'waiting for results';
  return people.length>1?`${people.length} participants are ${state}`:`${people[0].name} is ${state}`;
}
function updateCurrent() { $('#current').textContent=currentSummary();$('#current').disabled=!currentParticipants().length; }

function drawTrace(person,x,y) {
  const calls=person?.invocations||[],visible=calls.slice(-6),start=calls.length-visible.length;
  const points=visible.map((call,i)=>{
    const previous=calls[start+i-1],continued=i>0&&call.session&&call.session===previous?.session;
    return `${continued?`<path d="M${x+(i-1)*8} ${y}H${x+i*8}"/>`:''}<circle cx="${x+i*8}" cy="${y}" r="2.2" class="${i===visible.length-1?'last':''}" ${call.session?'':'stroke-dasharray="1 1"'}/>`;
  }).join('');
  return `<g class="context-trace" aria-hidden="true">${points}</g>`;
}
function drawImplementHub(n,data) {
  const lines=(items,x,y,cls,step=18)=>items.map((line,i)=>text(x,y+i*step,line,cls)).join('');
  return `<g class="node implement-hub ${data.participants.some(active)?'active':''}" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})"><rect class="hub-surface" width="${n.width}" height="${n.height}" rx="10"/>${text(20,28,'Implement tasks','node-title')}${text(20,49,`${data.instances.length} tasks · concurrency ${data.concurrency} · expand each task independently`,'node-role')}${n.cards.map(card=>{
   const instance=data.instances.find(i=>i.id===card.id),working=card.roles.some(active);
   let y=18;
   const title=lines(card.title,16,y+16,'node-title',22);y+=card.title.length*22+8;
   const identity=lines(card.identity,16,y+12,'node-role',16);y+=card.identity.length*16+10;
   const status=lines(card.status,16,y+14,'block-status');y+=card.status.length*18;
   const wait=lines(card.waiting,16,y+14,'node-role');
   const roleRows=card.expanded?card.roles.map((p,i)=>{
    const ry=card.top+i*76,latest=p.invocations.at(-1);
    return `<g class="participant ${active(p)?'active':''}" role="button" tabindex="0" data-primitive="${esc(n.id)}" data-participant="${esc(p.id)}" aria-label="${esc(instance.title||instance.taskId)}: ${esc(p.role)}, ${esc(states[observedState(p)]||'No recorded invocation')}, ${p.invocations.length} calls" aria-pressed="false"><rect class="member-surface" x="14" y="${ry}" width="${card.width-28}" height="68" rx="5"/><rect class="selection-ring" x="11" y="${ry-3}" width="${card.width-22}" height="74" rx="6"/><rect class="focus-ring" x="11" y="${ry-3}" width="${card.width-22}" height="74" rx="6"/>${text(26,ry+20,p.role,'member-name')}${text(card.width-26,ry+20,`${p.invocations.length} calls`,'call-count','text-anchor="end"')}${text(26,ry+39,states[observedState(p)]||'No recorded invocation','node-state')}${text(26,ry+56,latest?`Cycle ${latest.cycle??'not recorded'} · ${latest.outcome||latest.state}`:'Not called yet','node-role')}${drawTrace(p,card.width-78,ry+52)}</g>`;
   }).join(''):'';
   const footer=card.top+(card.expanded?card.roles.length*76+12:10);
   return `<g class="implement-card ${working?'active':''} ${selection?.implement===card.id?'selected':''}" data-implement="${esc(card.id)}" data-status="${esc(instance.status)}" transform="translate(${card.x} ${card.y})"><rect class="block-surface" width="${card.width}" height="${card.height}" rx="8"/><g role="button" tabindex="0" data-toggle-implement="${esc(card.id)}" aria-expanded="${card.expanded}" aria-label="${card.expanded?'Collapse':'Expand'} ${esc(instance.title||instance.taskId)}"><rect width="${card.width}" height="${card.top}" fill="transparent"/><rect class="focus-ring" x="3" y="3" width="${card.width-6}" height="${card.top-6}" rx="6"/>${title}${identity}${status}${wait}${text(card.width-14,18,card.expanded?'−':'+','disclosure','text-anchor="end"')}</g>${roleRows}${text(16,footer+14,`${card.questions} question / blocked reports · ${card.problem?'problem':'latest result'} preview`,'node-role')}${lines(card.preview,16,footer+34,'node-state')}<g role="button" tabindex="0" data-implement-overview="${esc(card.id)}" aria-label="Task details and history: ${esc(instance.title||instance.taskId)}"><rect x="10" y="${card.height-34}" width="${card.width-20}" height="28" rx="4" class="overview-surface"/>${text(18,card.height-15,'Task details, questions & history →','overview-label')}<rect class="focus-ring" x="8" y="${card.height-36}" width="${card.width-16}" height="32" rx="5"/></g></g>`;
  }).join('')}</g>`;
}
function drawNode(n) {
  const data=graph.nodes.find(d=>d.id===n.id), people=data.participants||[], live=people.some(active);
  if(data.group==='implements')return drawImplementHub(n,data);
  const title=n.title.map((line,i)=>text(n.group?30:16,28+i*22,line,'node-title')).join('');
  const shell=`<rect class="node-surface" width="${n.width}" height="${n.height}" rx="5"/><rect class="selection-ring" x="-5" y="-5" width="${n.width+10}" height="${n.height+10}" rx="8"/>`;
  if(n.role==='terminal')return `<g class="node terminal" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})">${shell}${n.title.map((line,i)=>text(n.width/2,28+i*22,line,'node-title','text-anchor="middle"')).join('')}${text(n.width/2,n.title.length*22+30,'null','node-role','text-anchor="middle"')}</g>`;
  const focus=`<rect class="focus-ring" x="-8" y="-8" width="${n.width+16}" height="${n.height+16}" rx="9"/>`;
  if(!n.group) {
    const p=people.find(active)||people.find(p=>p.invocations.length)||people[0],state=observedState(p);
    return `<g class="node primitive ${live?'active':''}" role="button" tabindex="0" aria-label="${esc(data.label)}, ${esc(data.role)}. ${p?.invocations?.length||0} calls. ${states[state]||'No recorded invocation'}." aria-pressed="false" data-node="${esc(n.id)}" data-primitive="${esc(n.id)}" transform="translate(${n.x} ${n.y})">${shell}${live?`<rect class="node-stripe" width="3" height="${n.height-16}" x="0" y="8" rx="1"/>`:''}${title}${text(16,n.title.length*22+23,data.role,'node-role')}${text(16,n.height-34,states[state]||'No calls recorded','node-state')}${drawTrace(p,18,n.height-15)}${text(n.width-16,n.height-11,p?.invocations?.length||0,'call-count','text-anchor="end"')}${focus}</g>`;
  }
  const role=`${data.role} · ${people.length} ${data.group} · parallel`;
  let rows='',y=n.header;
  const bottom=n.height-12, left=14,right=n.width-14;
  const rowCenters=n.rows.map((h,i)=>n.header+n.rows.slice(0,i).reduce((a,b)=>a+b,0)+h/2);
  const inputs=geometry.edges.filter(e=>e.to===n.id).map(e=>e.points.at(-1).y-n.y);
  const busTop=Math.min(rowCenters[0]??bottom,...inputs),busBottom=Math.max(rowCenters.at(-1)??bottom,...inputs);
  let wires=`<path class="bus" d="M${left} ${busTop}V${busBottom}"/>${inputs.map(y=>`<path class="bus" d="M0 ${y}H${left}"/>`).join('')}<path class="bus result" d="M${right} ${rowCenters[0]??bottom}V${bottom}"/>`;
  for(const edge of geometry.edges.filter(e=>e.from===n.id)) {
    const y=edge.points[0].y-n.y;
    const leftExit=Math.abs(edge.points[0].x-n.x)<1;
    wires+=leftExit?`<path class="bus result" d="M${right} ${bottom}H6V${y}H0"/>`:`<path class="bus ${edge.kind==='result'?'result':''}" d="M${right} ${y}H${n.width}"/>`;
  }
  people.forEach((p,i)=>{
    const h=n.rows[i],cy=rowCenters[i];
    wires+=`<path class="bus" d="M${left} ${cy}H30"/><path class="branch-arrow" d="M25 ${cy-3}L30 ${cy}L25 ${cy+3}Z"/><path class="bus result" d="M${n.width-30} ${cy}H${right}"/>`;
    rows+=`<g class="participant ${active(p)?'active':''}" role="button" tabindex="0" aria-label="${esc(p.name)}, ${esc(p.role)}, member of ${esc(data.label)}. ${p.invocations.length} calls. ${states[observedState(p)]||'No calls'}." aria-pressed="false" data-primitive="${esc(n.id)}" data-participant="${esc(p.id)}"><rect class="member-surface" x="30" y="${y+2}" width="${n.width-60}" height="${h-4}" rx="3"/><rect class="selection-ring" x="27" y="${y-1}" width="${n.width-54}" height="${h+2}" rx="5"/><rect class="focus-ring" x="25" y="${y-3}" width="${n.width-50}" height="${h+6}" rx="5"/>${n.members[i].lines.map((line,j)=>text(42,y+18+j*18,line,'member-name')).join('')}${drawTrace(p,44,y+h-12)}${text(n.width-42,y+h-8,p.invocations.length,'call-count','text-anchor="end"')}${active(p)?`<circle class="member-dot" cx="${n.width-41}" cy="${y+17}" r="3"/>`:''}</g>`;
    y+=h;
  });
  return `<g class="node group ${live?'active':''}" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})">${shell}${wires}<g class="primitive" role="button" tabindex="0" aria-label="${esc(data.label)}, ${people.length} parallel ${data.group} participants, ${esc(data.role)}" aria-pressed="false" data-primitive="${esc(n.id)}"><rect width="${n.width}" height="${n.header}" fill="transparent"/>${title}${text(30,n.title.length*22+23,role,'node-role')}${focus}</g>${rows}</g>`;
}
function updateTaskNavigation() {
  let nav=$('#task-navigation');
  const hub=graph.nodes.find(n=>n.group==='implements');
  if(!hub){nav?.remove();return;}
  if(!nav){nav=document.createElement('nav');nav.id='task-navigation';nav.setAttribute('aria-label','Jump to implement task at readable size');$('.map-tools').after(nav);}
  nav.innerHTML=hub.instances.map(i=>`<button data-jump-implement="${esc(i.id)}" title="${esc(i.title||i.taskId)}"><strong>${esc(i.title||'Untitled task')}</strong><span>${esc(i.executionStatus||i.status)} · ${esc(i.phase||i.waitingReason||'not started')}</span></button>`).join('');
}
function revealImplement(id) {
  expandedImplements.add(id);renderMap();setScale(.9,false);
  const card=[...document.querySelectorAll('[data-implement]')].find(el=>el.dataset.implement===id),rect=card?.getBoundingClientRect(),frame=viewport.getBoundingClientRect();
  if(rect){viewport.scrollLeft+=rect.left-frame.left-16;viewport.scrollTop+=rect.top-frame.top-16;}
  [...document.querySelectorAll('[data-jump-implement]')].find(el=>el.dataset.jumpImplement===id)?.focus({preventScroll:true});
  announce('Task expanded at readable size. Pan or use task navigation to explore other tasks.');
}
function renderMap() {
  geometry=layoutGraph(graph,{measure,expandedImplements});updateTaskNavigation();
  const paths=geometry.edges.map(e=>{const kind=e.reentry?'reentry':e.kind;const d=roundedPath(e.points);const from=graph.nodes.find(n=>n.id===e.from),to=graph.nodes.find(n=>n.id===e.to);return `<g class="edge" data-edge="${esc(e.id)}" role="button" tabindex="0" aria-pressed="false" aria-label="${esc(from.label)} → ${esc(to.label)}. ${e.reentry?'Changes requested':e.kind==='result'?'Result delivery':'Task or control'}"><title>${esc(from.label)} → ${esc(to.label)}</title><path class="route-case" d="${d}"/><path class="route ${kind}" d="${d}"/><path class="route-hit" d="${d}"/></g>`;}).join('');
  const labels=geometry.edges.map(e=>`<text x="${e.label.x}" y="${e.label.y}" class="route-label ${e.reentry?'reentry':e.kind}" text-anchor="${e.label.anchor}" data-route-label="${esc(e.id)}">${(e.label.lines||[e.label.text]).map((line,i)=>`<tspan x="${e.label.x}" dy="${i?18:0}">${esc(line)}</tspan>`).join('')}</text>`).join('');
  // Paint every arrowhead after all masking strokes, including a nearby reply.
  const heads=geometry.edges.map(e=>`<g class="edge-head" data-edge-head="${esc(e.id)}" aria-hidden="true"><path class="route-head ${e.reentry?'reentry':e.kind}" d="${roundedPath(e.points)}"/></g>`).join('');
  $('#map').setAttribute('viewBox',`0 0 ${geometry.width} ${geometry.height}`);
  $('#map').innerHTML=`<title id="map-title">${esc(run.title)} · all possible routes</title><desc id="map-description">Green task arrows and purple returns share a route when the same two blocks communicate in both directions. Labels distinguish results and changes. Select a primitive or a named parallel participant for invocation and session details.</desc>${marks}${paths}${labels}${heads}${geometry.nodes.map(drawNode).join('')}`;
  applySelection();applyScale();updateCurrent();applyEdgeSelection();
}
function applyEdgeSelection() {
  const id=hoveredEdge||selectedEdge,edge=geometry.edges.find(e=>e.id===id);
  $('#map').classList.toggle('has-edge-focus',!!edge);
  document.querySelectorAll('[data-edge]').forEach(el=>{
    el.classList.toggle('edge-focus',el.dataset.edge===id);
    el.classList.toggle('pair-focus',el.dataset.edge===edge?.pairedWith);
    el.setAttribute('aria-pressed',String(el.dataset.edge===selectedEdge));
  });
  document.querySelectorAll('[data-edge-head]').forEach(el=>{
    el.classList.toggle('edge-focus',el.dataset.edgeHead===id);
    el.classList.toggle('pair-focus',el.dataset.edgeHead===edge?.pairedWith);
  });
  document.querySelectorAll('[data-route-label]').forEach(el=>el.classList.toggle('edge-focus',el.dataset.routeLabel===id));
  if(edge){const from=graph.nodes.find(n=>n.id===edge.from),to=graph.nodes.find(n=>n.id===edge.to);$('#map-hint').textContent=`${from.label} → ${to.label} · ${edge.reentry?'changes':edge.kind==='result'?'results':'task / control'}`;}
}
function applySelection() {
  document.querySelectorAll('[data-implement]').forEach(el=>el.classList.toggle('selected',el.dataset.implement===selection?.implement));
  document.querySelectorAll('[data-node]').forEach(el=>el.classList.toggle('selected',el.dataset.node===selection?.node));
  document.querySelectorAll('[data-primitive]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.primitive===selection?.node&&(!el.dataset.participant||el.dataset.participant===selection?.person))));
}
function applyScale() {
  const svg=$('#map');svg.style.width=`${geometry.width*scale}px`;svg.style.height=`${geometry.height*scale}px`;
  $('#zoom-reset').textContent=`${Math.round(scale*100)}%`;
  $('#map-hint').textContent=`${graph.nodes.length} stops · ${graph.edges.length} routes · ${scale<.75?'Overview; use + for labels':'Drag or scroll to explore'}`;
}
function setScale(value,center=true) {
  if(!geometry)return;
  const x=(viewport.scrollLeft+viewport.clientWidth/2)/scale,y=(viewport.scrollTop+viewport.clientHeight/2)/scale;
  // Fit is an explicit overview mode, including wide maps on narrow screens.
  scale=Math.max(.01,Math.min(1.8,value));applyScale();
  if(center){viewport.scrollLeft=x*scale-viewport.clientWidth/2;viewport.scrollTop=y*scale-viewport.clientHeight/2;}
}
function fit(readable=false) {
  if(!geometry)return;
  const fitted=Math.min((viewport.clientWidth-32)/geometry.width,(viewport.clientHeight-28)/geometry.height,1);
  setScale(readable?Math.max(.8,fitted):fitted,false);viewport.scrollLeft=0;viewport.scrollTop=0;
}
function chooseRun(id) {
  if(inspector.open)inspector.close();
  run=runs.find(r=>r.id===id);graph=toGraph(run);expandedImplements=expansions.get(id)||new Set();expansions.set(id,expandedImplements);selection=null;selectedEdge=null;hoveredEdge=null;
  document.querySelectorAll('[data-run]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.run===id)));
  $('#project').textContent=run.project;$('#run-id').textContent=live?run.id:`demo_run_${run.id}`;$('#run-title').textContent=run.title;$('#mobile-run').textContent=run.title;$('#description').textContent=live?`${run.status} · ${run.description||''}`:run.description;updateCurrent();updateRunDetails();
  renderMap();fit(true);if(narrow.matches)$('#run-menu').open=false;
  announce(`Selected ${run.title}, ${run.project}.${live?'':' All session IDs are fictional.'}`);
}
function selectedData() {
  const n=graph.nodes.find(n=>n.id===selection.node),p=n.participants?.find(p=>p.id===selection.person);
  return {n,p,v:p?.invocations?.[invocation],prev:p?.invocations?.[invocation-1],past:invocation<(p?.invocations?.length||0)-1};
}
function selectPrimitive(id,personId,origin) {
  const n=graph.nodes.find(n=>n.id===id),p=n?.participants?.find(p=>p.id===personId)||n?.participants?.find(active)||n?.participants?.find(p=>p.invocations.length)||n?.participants?.[0];
  if(!n||n.role==='terminal')return;
  if(!inspector.open){invoker=origin||document.activeElement;invokerKey=focusKey(invoker);}
  selection={node:id,person:p?.id||null,implement:n.instances?.find(i=>i.participants.some(r=>r.participant===p?.id))?.id};invocation=p?.invocations?.length?p.invocations.length-1:0;applySelection();renderInspector();
  if(!inspector.open)inspector.showModal();
  revealSelectedCall();
  $('#detail-title').focus({preventScroll:true});inspector.scrollTop=0;
  announce(`${p?.name||n.label}. ${p?.invocations?.length?'Latest invocation selected.':'No recorded invocation.'} Current execution unchanged.`);
}
const inspectorHeaderObserver=new ResizeObserver(()=>updateInspectorClearance());
function updateInspectorClearance() {
  const height=inspector.querySelector('.detail-top')?.getBoundingClientRect().height;
  if(height)inspector.style.setProperty('--detail-header-height',`${height}px`);
}
function watchInspectorHeader() {
  inspectorHeaderObserver.disconnect();
  const header=inspector.querySelector('.detail-top');
  if(header)inspectorHeaderObserver.observe(header);
  updateInspectorClearance();
}
// Native focus scrolling is not consistently sticky-header-aware, especially on
// backwards Tab. Keep the complete focus ring in the unobscured reading area.
let inspectorFocusFrame=0;
inspector.addEventListener('focusin',event=>{
  const target=event.target;
  updateInspectorClearance();cancelAnimationFrame(inspectorFocusFrame);
  inspectorFocusFrame=requestAnimationFrame(()=>{
    const header=inspector.querySelector('.detail-top');
    if(!inspector.open||document.activeElement!==target||header?.contains(target))return;
    const rect=target.getBoundingClientRect(),frame=inspector.getBoundingClientRect();
    const top=(header?.getBoundingClientRect().bottom||frame.top)+12,bottom=frame.bottom-12;
    if(rect.top<top)inspector.scrollTop+=rect.top-top;
    else if(rect.bottom>bottom)inspector.scrollTop+=rect.bottom-bottom;
  });
});
function readableValue(value, depth=0) {
  if(value===null||value===undefined)return '<p>Not recorded</p>';
  if(typeof value!=='object')return `<p>${esc(value)}</p>`;
  if(depth>12)return '<p>Further nested details are available in the original saved result.</p>';
  if(Array.isArray(value))return value.length?`<ul>${value.map(item=>`<li>${readableValue(item,depth+1)}</li>`).join('')}</ul>`:'<p>None recorded</p>';
  const summary=typeof value.summary==='string'?`<p>${esc(value.summary)}</p>`:'';
  const entries=Object.entries(value).filter(([key])=>!summary||!['summary','outcome'].includes(key));
  return summary+(entries.length?`<dl>${entries.map(([key,item])=>`<dt>${esc(key.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replaceAll('_',' '))}</dt><dd>${readableValue(item,depth+1)}</dd>`).join('')}</dl>`:'');
}
function resultExtras(value) {
  const fields=value.resultDetails||[];
  const details=fields.length?`<div class="result-fields">${fields.map(field=>`<details data-detail-key="result-${esc(field.label)}"><summary>${esc(field.label)}</summary>${readableValue(field.value)}</details>`).join('')}</div>`:'';
  const raw=value.resultRaw;
  const source=raw!=null&&(typeof raw!=='string'||raw!==value.result)?`<details class="result-source" data-detail-key="result-source"><summary>Original saved result</summary><pre>${esc(typeof raw==='string'?raw:JSON.stringify(raw,null,2))}</pre></details>`:'';
  return details+source;
}
function renderImplementOverview() {
  const n=graph.nodes.find(n=>n.id===selection.node),instance=n.instances.find(i=>i.id===selection.implement);
  const conflict=instance.refresh?.status==='conflict'?instance.refresh:instance.integration?.status==='conflict'?instance.integration:null;
  const reports=instance.results||[],events=(run.implements?.events||[]).filter(e=>e.implementId===instance.id);
  $('#detail-content').innerHTML=`<header class="detail-top"><div><span class="eyebrow">IMPLEMENT TASK</span><h2 id="detail-title" tabindex="-1">${esc(instance.title||'Untitled task')}</h2><p>${instance.executionStatus?esc(instance.executionStatus)+' · ':''}${esc(instance.status)} · ${esc(instance.phase||'no stage yet')} · cycle ${instance.cycle??0}</p></div><button class="close" data-close="header" aria-label="Close task details">×</button></header>
   <nav class="block-picker" aria-label="Implement tasks">${n.instances.map(i=>`<button data-implement-overview="${esc(i.id)}" aria-pressed="${i.id===instance.id}">${esc(i.title||i.taskId)}</button>`).join('')}</nav>
   <section class="detail-block"><h3>Task identity</h3><p>${esc(instance.taskId)}${instance.beadsId?' · '+esc(instance.beadsId):''}</p><h3>Waiting reason</h3><p>${esc(instance.waitingReason||'Not waiting')}${instance.waitingFor?.length?' · '+esc(instance.waitingFor.join(', ')):''}</p><h3>Dependencies</h3>${readableValue(instance.dependencies)}</section>
   ${instance.status==='conflict'?`<section class="detail-block problem"><h3>Integration conflict</h3><p>${esc(conflict?.error||'Conflict recorded by runtime')}</p>${readableValue(conflict?.conflicts||[])}</section>`:''}<nav class="member-picker" aria-label="Task roles">${n.participants.filter(p=>instance.participants.some(r=>r.participant===p.id)).map(p=>`<button data-pick="${esc(p.id)}" class="${active(p)?'live':''}">${esc(p.role)} · ${p.invocations.length} calls${active(p)?' · working now':''}</button>`).join('')}</nav>
   <section class="detail-block"><h3>Result</h3>${readableValue(instance.result||reports.at(-1)?.result||reports.at(-1)?.error||'No result recorded')}</section>
   <section class="detail-block"><h3>Questions & call history</h3><p class="fine">Saved reports; historical questions are not necessarily still unresolved.</p>${reports.length?reports.map(r=>`<article class="report-entry"><button data-report-input="${esc(r.inputId)}">${esc(r.participant)} · ${esc(r.result?.outcome||'error')} →</button>${readableValue(r.result||r.error)}</article>`).join(''):'<p>No saved reports.</p>'}</section>
   <section class="detail-block"><h3>Runtime events</h3>${events.map(e=>`<details data-detail-key="event-${e.sequence}"><summary>${e.sequence} · ${esc(e.type)}</summary>${readableValue(e)}</details>`).join('')||'<p>No events recorded.</p>'}</section>
   <details class="detail-block" data-detail-key="implement-runtime"><summary>Technical runtime data · IDs, paths and operations</summary><pre>${esc(JSON.stringify(instance,null,2))}</pre></details><button class="back-map" data-close="map">Back to map</button>`;
  watchInspectorHeader();
}
function openImplement(id,origin) {
  const n=graph.nodes.find(n=>n.instances?.some(i=>i.id===id));if(!n)return;
  if(!inspector.open){invoker=origin||document.activeElement;invokerKey=focusKey(invoker);}
  selection={node:n.id,implement:id,person:null};applySelection();renderInspector();
  if(!inspector.open)inspector.showModal();
  const picker=inspector.querySelector('.block-picker');revealInScroller(picker,picker?.querySelector('[aria-pressed="true"]'));
  $('#detail-title').focus({preventScroll:true});inspector.scrollTop=0;
}
const inspectorScrollers=['.call-picker','.block-picker'];
function renderInspector() {
  const positions=inspectorScrollers.flatMap(selector=>{
    const el=inspector.querySelector(selector);
    return el?[{selector,left:el.scrollLeft,top:el.scrollTop}]:[];
  });
  renderInspectorContent();
  for(const {selector,left,top} of positions) {
    const el=inspector.querySelector(selector);if(el){el.scrollLeft=left;el.scrollTop=top;}
  }
}
function renderInspectorContent() {
  copyGeneration++;
  if(selection.implement&&!selection.person){renderImplementOverview();return;}
  const {n,p,v,prev,past}=selectedData(),identityKnown=!!v?.session&&!!prev?.session,same=identityKnown&&prev.session===v.session;
  const localInstance=n.instances?.find(i=>i.id===selection.implement);
  const pickerPeople=localInstance?n.participants.filter(m=>localInstance.participants.some(r=>r.participant===m.id)):n.participants;
  const picker=n.group||n.participants?.length>1?`<nav class="member-picker" aria-label="Participants of ${esc(n.label)}">${pickerPeople.map(m=>`<button data-pick="${esc(m.id)}" class="${active(m)?'live':''}" aria-pressed="${m.id===p?.id}">${esc(localInstance?m.role:m.name)}</button>`).join('')}</nav>`:'';
  const directoryDetails=live&&v?`<section class="detail-block session-directories"><h3>Working directories</h3>
    <p class="fine">This call · saved directory</p><code data-call-directory>${esc(v.callDirectory||'Not recorded')}</code>
    <p class="fine">Current session directory · OpenCode observation (may change)</p><code data-session-directory>${esc(v.sessionDirectory||'Unknown — OpenCode unavailable or not checked')}</code>
    ${!v.sessionDirectory?`<p class="fine">Last saved session directory · not a live observation</p><code data-last-directory>${esc(v.lastObservedDirectory||'Not recorded')}</code>`:''}
    <p data-directory-note>${!v.sessionDirectory?'Current directory is unknown. OpenCode will use the existing session’s current directory; no historical directory is forced.':v.callDirectory&&v.callDirectory!==v.sessionDirectory?'This call used another directory. OpenCode opens the existing session in its current directory, not the historical worktree.':'OpenCode opens the existing session in its current directory. The command does not change that directory.'}</p></section>`:'';
  if(!v) {
    $('#detail-content').innerHTML=`<div class="detail-top"><h2 id="detail-title" tabindex="-1">${esc(p?.name||n.label)}</h2><button class="close" data-close="header" aria-label="Close details">×</button></div>${localInstance?`<button class="task-back" data-implement-overview="${esc(localInstance.id)}">← Task overview & other tasks</button>`:''}${picker}<p class="detail-block">No recorded invocation. No session or command is available.</p>`;watchInspectorHeader();return;
  }
  $('#detail-content').innerHTML=`<header class="detail-top"><div><span class="eyebrow">${esc(n.label)} / ${n.group?'PARALLEL PARTICIPANT':'PRIMITIVE'}</span><h2 id="detail-title" tabindex="-1">${esc(localInstance?localInstance.title||localInstance.taskId:p.name)}</h2><p class="role">${esc(p.role)}${localInstance?'':' · '+esc(p.id)}</p></div><button class="close" data-close="header" aria-label="Close details and return to map">×</button></header>
  ${localInstance?`<button class="task-back" data-implement-overview="${esc(localInstance.id)}">← Task overview & other tasks</button>`:''}${picker}
  <div class="invocation-heading"><h3>Invocation</h3>${past?'<button id="latest">Return to latest →</button>':'<span class="fine">Latest selected</span>'}</div>
  <nav class="call-picker" aria-label="Invocation history" ${p.invocations.length===1?'hidden':''}>${p.invocations.map((c,i)=>`<button data-invocation="${i}" data-call-id="${esc(c.id??i)}" class="${c.state==='active'?'live':''}" aria-pressed="${i===invocation}" aria-label="${esc(c.time)}, ${states[c.state]}, ${i===p.invocations.length-1?'latest':'earlier'} invocation">${i+1}${c.cycle!=null?' · cycle '+esc(c.cycle):''} · ${esc(c.outcome||c.state)}${c.state==='active'?' ●':''}</button>`).join('')}</nav>
  ${past?`<p class="past-note">Inspecting an earlier call. <strong>Now:</strong> ${esc(currentSummary())}. The map has not changed.</p>`:''}
  <p title="${esc(v.time)}" class="call-state ${v.state==='active'?'active':''}">${esc(callTime(v.time))} · ${esc(timeZone)} · ${states[v.state]}${prev?` · ${identityKnown?(same?'same session':'new session'):'identity unknown'}`:''}${v.location&&v.location!==n.id?` · at ${esc(v.location)}`:''}</p>
  ${v.progress?`<p class="live-progress">${esc(v.progress)}</p>`:''}
  <section class="detail-block"><h3>${v.taskSource==='raw-only'?'Task (raw prompt only)':'Task'}</h3><p data-task>${esc(v.task||'No semantic task field saved.')}</p></section>
  ${v.assignment?`<section class="detail-block assignment"><h3>Addressed assignment / feedback</h3>${v.assignment.instructions?`<p>${esc(v.assignment.instructions)}</p>`:''}${v.assignment.implement?.text?`<p>${esc(v.assignment.implement.text)}</p>`:''}${v.assignment.steering?.text?`<h4>User clarification</h4><p>${esc(v.assignment.steering.text)}</p>`:''}${v.assignment.item?`<details data-detail-key="assignment-item"><summary>Assigned item</summary>${readableValue(v.assignment.item)}</details>`:''}${v.handoff?`<h4>Handoff · reported by another participant</h4>${readableValue(v.handoff)}`:''}</section>`:''}
  ${v.problem?`<section class="detail-block problem"><h3>Significant problem</h3><p data-problem>${esc(v.problem)}</p></section>`:''}
  <section class="detail-block"><h3>Result${v.outcome?' · '+esc(v.outcome):''}</h3><p data-result class="${v.result?'':'pending'}">${v.result?esc(v.result):v.state==='active'?'Not received. This participant is working.':'No result recorded.'}</p>${resultExtras(v)}</section>
  ${v.taskData?`<details class="detail-block" data-detail-key="task-data"><summary>Structured task/context data</summary><pre>${esc(JSON.stringify(v.taskData,null,2))}</pre></details>`:''}${v.promptRaw&&v.taskSource==='structured'?`<details class="detail-block" data-detail-key="technical-prompt"><summary>Technical prompt</summary><pre>${esc(v.promptRaw)}</pre></details>`:''}
  <details class="technical-session" data-detail-key="technical-session"><summary>Session identity & directories</summary>
  <section class="session-block"><h3>${prev?(identityKnown?(same?'↺ Same session':'＋ Fresh session'):'Session identity unavailable'):'Session identity'}</h3><code data-session>${esc(v.session||'No session observed')}</code><p>${prev?(identityKnown?(same?'The ID matches the previous invocation. Context continued.':'The ID differs from the previous invocation. Context is fresh.'):'One or both session IDs are missing. Continuity is unknown.'):'First recorded invocation of this participant.'}</p>${prev?`<div class="previous"><p>Previous invocation · ${esc(prev.time)}</p><code data-previous-session>${esc(prev.session)}</code></div>`:''}<p>Reentry policy: ${p.memory==null?'not saved':p.memory?'continue this participant’s session':'fresh context on each ordinary reentry'}.</p></section>
  ${directoryDetails}</details>
  <dl class="settings"><dt>Model</dt><dd>${esc(v.model)}</dd><dt>Reasoning</dt><dd>${esc(v.reasoning)}</dd><dt>Speed</dt><dd>${esc(v.speed)}</dd></dl>
  <details class="skills" data-detail-key="skills"><summary>${live?'Configured skills (not proof of use)':'Skills'} · ${v.skills.length}</summary>${live&&!v.skillsKnown?'<p>Skill configuration was not saved.</p>':''}${v.skills.map(k=>`<strong>${esc(skills[k]?.[0]||k)}</strong><p>${esc(v.skillDescriptions?.[k]||skills[k]?.[1]||'No description available.')}</p>`).join('')}</details>
  <section class="command-section"><div class="entry-head"><h3>OpenCode command</h3>${!live||v.command?'<button class="copy" id="copy">Copy command</button>':''}</div>${!live||v.command?`<label class="sr-only" for="command">Exact command for the selected ${live?'real':'fictional'} session</label><textarea id="command" class="command" rows="3" readonly spellcheck="false">${live?esc(v.command):`opencode --session ${esc(v.session)}`}</textarea><p id="copy-status" class="copy-status" role="status"></p>`:`<p>${v.sessionUnavailable?'This saved session is no longer available in OpenCode.':'No command available: session identity or saved profile is missing.'}</p>`}<p class="fine">${live?'OpenCode 2.2.5 · saved profile and existing session’s current directory. No move, fork or prompt is sent by this command.':'Fictional demo ID. This command cannot connect to a real session. Nothing is executed here.'}</p></section>
  <details class="history" data-detail-key="history"><summary>All calls & session IDs · ${p.invocations.length}</summary>${p.invocations.map((c,i)=>`<button data-invocation="${i}" data-call-id="${esc(c.id??i)}" aria-pressed="${i===invocation}"><strong>${esc(c.time)} · ${states[c.state]}${i?(c.session&&p.invocations[i-1].session?(c.session===p.invocations[i-1].session?' · same ID':' · new ID'):' · identity unknown'):''}</strong><code>${esc(c.session||'No session observed')}</code></button>`).join('')}</details><button class="back-map" data-close="map">Back to map</button>`;
  watchInspectorHeader();
}
// Opening/selection reveals the selected item explicitly. Refresh preserves
// each internal viewport, then reveals restored keyboard focus only if needed.
function revealInScroller(scroller,target) {
  if(!scroller||!target||!scroller.contains(target)||!inspector.open||!scroller.clientWidth)return;
  const frame=scroller.getBoundingClientRect(),rect=target.getBoundingClientRect();
  if(rect.left<frame.left)scroller.scrollLeft+=rect.left-frame.left;
  else if(rect.right>frame.right)scroller.scrollLeft+=rect.right-frame.right;
  if(rect.top<frame.top)scroller.scrollTop+=rect.top-frame.top;
  else if(rect.bottom>frame.bottom)scroller.scrollTop+=rect.bottom-frame.bottom;
}
function revealSelectedCall() {
  const picker=inspector.querySelector('.call-picker');
  revealInScroller(picker,picker?.querySelector('[aria-pressed="true"]'));
}
function chooseInvocation(index,history=false) {
  const scroll=inspector.scrollTop,skillsOpen=$('.skills')?.open,historyOpen=$('.history')?.open;
  invocation=index;renderInspector();if($('.skills'))$('.skills').open=skillsOpen;if($('.history'))$('.history').open=historyOpen||history;
  $(`${history?'.history':'.call-picker'} [data-invocation="${index}"]`).focus({preventScroll:true});revealSelectedCall();inspector.scrollTop=scroll;
  announce('Invocation details changed. Current execution and map geometry are unchanged.');
}
async function copyCommand() {
  const generation=copyGeneration,field=$('#command'),status=$('#copy-status'),value=field.value;
  try {
    if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if(generation===copyGeneration)status.textContent=live?'Command copied.':'Command copied. This is a fictional session ID.';
  } catch {
    if(generation!==copyGeneration)return;
    status.textContent='Could not copy. The command is selected; press ⌘C or Ctrl+C.';field.focus();field.select();
  }
}
function revealCurrent(open=true) {
  if(!graph)return;
  const p=currentParticipants()[0],n=graph.nodes.find(n=>n.participants?.includes(p));if(!n)return;
  const instance=n.instances?.find(i=>i.participants.some(r=>r.participant===p.id));if(instance&&!expandedImplements.has(instance.id)){expandedImplements.add(instance.id);renderMap();}
  const participant=p,el=[...document.querySelectorAll('[data-primitive]')].find(el=>el.dataset.primitive===n.id&&(n.group?el.dataset.participant===participant.id:true));
  el?.scrollIntoView({block:'center',inline:'center',behavior:'instant'});if(open)selectPrimitive(n.id,participant.id,$('#current'));
}
document.addEventListener('click',e=>{
  const runButton=e.target.closest('[data-run]');if(runButton){chooseRun(runButton.dataset.run);return;}
  const jump=e.target.closest('[data-jump-implement]');if(jump){revealImplement(jump.dataset.jumpImplement);return;}
  const toggle=e.target.closest('[data-toggle-implement]');if(toggle){toggleImplement(toggle.dataset.toggleImplement);return;}
  const overview=e.target.closest('[data-implement-overview]');if(overview){openImplement(overview.dataset.implementOverview,overview);return;}
  const report=e.target.closest('[data-report-input]');if(report){const n=graph.nodes.find(n=>n.id===selection.node),p=n.participants.find(p=>p.invocations.some(c=>c.id===report.dataset.reportInput));if(p){selectPrimitive(n.id,p.id);chooseInvocation(p.invocations.findIndex(c=>c.id===report.dataset.reportInput));}return;}
  const primitive=e.target.closest('[data-primitive]');if(primitive){selectPrimitive(primitive.dataset.primitive,primitive.dataset.participant,primitive);return;}
  const edge=e.target.closest('[data-edge]');if(edge){selectedEdge=selectedEdge===edge.dataset.edge?null:edge.dataset.edge;applyScale();applyEdgeSelection();return;}
  const pick=e.target.closest('[data-pick]');if(pick){selectPrimitive(selection.node,pick.dataset.pick);[...document.querySelectorAll('[data-pick]')].find(b=>b.dataset.pick===pick.dataset.pick)?.focus({preventScroll:true});return;}
  const call=e.target.closest('[data-invocation]');if(call){chooseInvocation(Number(call.dataset.invocation),!!call.closest('.history'));return;}
  if(e.target.closest('[data-close]')){inspector.close();return;}
  switch(e.target.closest('button')?.id) {
    case 'latest':chooseInvocation(selectedData().p.invocations.length-1);break;
    case 'copy':copyCommand();break;
    case 'zoom-out':setScale(scale/1.2);break;
    case 'zoom-in':setScale(scale*1.2);break;
    case 'zoom-reset':setScale(1);break;
    case 'fit':fit();break;
    case 'current':revealCurrent();break;
    case 'help-open':$('#help').showModal();break;
    case 'help-close':$('#help').close();break;
  }
});
$('#map').addEventListener('keydown',e=>{
  const action=e.target.closest('[data-toggle-implement],[data-implement-overview]');if(action&&(e.key==='Enter'||e.key===' ')){e.preventDefault();action.dispatchEvent(new MouseEvent('click',{bubbles:true}));return;}
  const node=e.target.closest('[data-primitive]');if(node&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectPrimitive(node.dataset.primitive,node.dataset.participant,node);}
  const edge=e.target.closest('[data-edge]');if(edge&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectedEdge=selectedEdge===edge.dataset.edge?null:edge.dataset.edge;applyScale();applyEdgeSelection();}
});
$('#map').addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const edge=e.target.closest('[data-edge]');if(edge){hoveredEdge=edge.dataset.edge;applyEdgeSelection();}});
$('#map').addEventListener('pointerout',e=>{if(e.target.closest('[data-edge]')&&!e.relatedTarget?.closest?.('[data-edge]')){hoveredEdge=null;applyScale();applyEdgeSelection();}});
$('#map').addEventListener('pointerleave',()=>{hoveredEdge=null;applyScale();applyEdgeSelection();});
$('#map').addEventListener('focusin',e=>{const edge=e.target.closest('[data-edge]');if(edge){hoveredEdge=edge.dataset.edge;applyEdgeSelection();}});
$('#map').addEventListener('focusout',()=>{hoveredEdge=null;applyScale();applyEdgeSelection();});
inspector.addEventListener('close',()=>{copyGeneration++;const target=invoker?.isConnected?invoker:findFocus(invokerKey);target?.focus({preventScroll:true});});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('keydown',e=>{
  if(e.key!=='Tab')return;
  const controls=[...dialog.querySelectorAll('button,textarea,summary,[tabindex="0"]')].filter(el=>!el.disabled&&el.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
});
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
// Native scroll remains available on touch; pointer dragging is an additional
// background-only convenience and never intercepts primitive clicks.
let drag;
viewport.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||e.button!==0||e.target.closest('[data-primitive],[data-edge],[data-toggle-implement],[data-implement-overview]'))return;drag={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(e.pointerId);viewport.classList.add('dragging');});
viewport.addEventListener('pointermove',e=>{if(drag){viewport.scrollLeft=drag.left+drag.x-e.clientX;viewport.scrollTop=drag.top+drag.y-e.clientY;}});
const endDrag=()=>{drag=null;viewport.classList.remove('dragging');};viewport.addEventListener('pointerup',endDrag);viewport.addEventListener('pointercancel',endDrag);
const narrow=matchMedia('(max-width:760px)');narrow.addEventListener('change',()=>{$('#run-menu').open=!narrow.matches;});
$('#run-menu').open=!narrow.matches;
function updateRunDetails() {
  if(!live)return;
  let details=$('#run-observations');
  if(!details){details=document.createElement('details');details.id='run-observations';details.className='run-observations';$('.run-heading > div').append(details);}
  const signature=JSON.stringify([run.id,run.task,run.result,run.resultDetails,run.resultRaw]);
  if(signature===runDetailsSignature)return;
  runDetailsSignature=signature;
  details.innerHTML=`<summary>Workflow task & result</summary><h3>Task</h3><pre>${esc(run.task)}</pre><h3>Result</h3><p data-result>${esc(run.result||'No final result saved.')}</p>${resultExtras(run)}`;
}
function renderRuns() {
  $('#runs').innerHTML=runs.map((r,i)=>live?`<button class="run" data-run="${esc(r.id)}" aria-pressed="${r.id===run?.id}"><small><span title="${esc(r.project)}">${esc(r.projectName||r.project)}</span><time>${r.createdAt?esc(new Date(r.createdAt).toLocaleString()):'Time not saved'}</time></small><strong>${esc(r.title)}</strong><em>${esc(r.status)}</em></button>`:`${i===2?'<p class="examples-label">LAYOUT EXAMPLES</p>':''}<button class="run ${i>1?'fixture':''}" data-run="${r.id}" aria-pressed="false"><small><span>${esc(r.project)}</span><time>${r.time}</time></small><strong>${esc(r.title)}</strong><em>${i<2?'In progress':`${r.nodes.length} stops · demo fixture`}</em></button>`).join('');
}
let invokerKey=null;
const focusAttributes=['data-jump-implement','data-toggle-implement','data-implement-overview','data-primitive','data-participant','data-edge','data-run','data-pick','data-call-id','data-invocation','data-report-input','data-detail-key','data-close'];
function focusKey(el) {
  if(!el)return null;
  if(el.id)return {id:el.id};
  const attrs=focusAttributes.filter(a=>el.hasAttribute(a)&&!(a==='data-invocation'&&el.hasAttribute('data-call-id'))).map(a=>[a,el.getAttribute(a)]);
  if(el.tagName==='SUMMARY'&&el.parentElement.dataset.detailKey)return {detail:el.parentElement.dataset.detailKey};
  return attrs.length?{attrs,scope:el.closest('.history')?'.history':el.closest('.call-picker')?'.call-picker':el.closest('#inspector')?'#inspector':null}:null;
}
function findFocus(key) {
  if(!key)return null;
  if(key.id)return document.getElementById(key.id);
  if(key.detail)return [...inspector.querySelectorAll('details[data-detail-key]')].find(d=>d.dataset.detailKey===key.detail)?.querySelector('summary');
  return [...(key.scope?document.querySelector(key.scope):document)?.querySelectorAll(`[${key.attrs[0][0]}]`)||[]].find(el=>key.attrs.every(([a,v])=>el.getAttribute(a)===v));
}
function toggleImplement(id) {
  const focus=focusKey(document.activeElement),left=viewport.scrollLeft,top=viewport.scrollTop;
  if(expandedImplements.has(id))expandedImplements.delete(id);else expandedImplements.add(id);
  renderMap();viewport.scrollLeft=left;viewport.scrollTop=top;
  (findFocus(focus)||[...document.querySelectorAll('[data-toggle-implement]')].find(el=>el.dataset.toggleImplement===id))?.focus({preventScroll:true});
  announce(`${expandedImplements.has(id)?'Expanded':'Collapsed'} task. Runtime execution unchanged.`);
}
function refreshSelected(next) {
  if(JSON.stringify(next)===JSON.stringify(run))return;
  const left=viewport.scrollLeft,top=viewport.scrollTop,selectedId=selection?.person?selectedData().v?.id:null;
  run=next;graph=toGraph(run);updateRunDetails();
  $('#description').textContent=`${run.status} · ${run.description||''}`;
  renderMap();viewport.scrollLeft=left;viewport.scrollTop=top;
  if(inspector.open&&selection){
    const person=graph.nodes.find(n=>n.id===selection.node)?.participants?.find(p=>p.id===selection.person);
    if(!person&&selection.person)return; // Keep inspected saved data if a transient snapshot lacks it.
    if(selectedId&&person){const index=person.invocations.findIndex(c=>c.id===selectedId);if(index>=0)invocation=index;}
    const scroll=inspector.scrollTop,open=new Map([...inspector.querySelectorAll('details[data-detail-key]')].map(d=>[d.dataset.detailKey,d.open]));
    const key=focusKey(document.activeElement);
    renderInspector();inspector.querySelectorAll('details[data-detail-key]').forEach(d=>d.open=open.get(d.dataset.detailKey)??false);
    findFocus(key)?.focus({preventScroll:true});revealInScroller(document.activeElement?.closest(inspectorScrollers.join(',')),document.activeElement);inspector.scrollTop=scroll;
  }
}
async function poll() {
  try {
    const response=await fetch('/api/runs',{signal:AbortSignal.timeout(8000),cache:'no-store'});
    if(!response.ok)throw new Error('State unavailable');
    const data=await response.json(),savedFocus=focusKey(document.activeElement);runs=data.runs;renderRuns();
    $('#connection').textContent='· Connected';
    if(!run&&runs.length){const requested=new URLSearchParams(location.search).get('run');chooseRun(runs.some(r=>r.id===requested)?requested:runs[0].id);}
    else if(run){const next=runs.find(r=>r.id===run.id);if(next)refreshSelected(next);}
    else{$('#run-title').textContent='No saved runs yet';$('#description').textContent='Start a DWF workflow in any project using this state directory. It will appear here automatically.';$('#current').disabled=true;}
    findFocus(savedFocus)?.focus({preventScroll:true});
  }catch{
    $('#connection').textContent='· Connection lost — retrying';
    if(!run){$('#run-title').textContent='Waiting for DWF state';$('#description').textContent='Connection or saved state unavailable. Retrying automatically.';}
  }finally{setTimeout(poll,1200);}
}
if(live)poll();
else{renderRuns();const requestedRun=new URLSearchParams(location.search).get('run');chooseRun(runs.some(run=>run.id===requestedRun)?requestedRun:runs[0].id);}
window.addEventListener('resize',()=>{if(geometry)fit(true);});
// Small test/review seam. Only in-memory demo data; never coordinates or runtime.
if(!live)window.dwfDemo={
  getGraph:()=>structuredClone(graph),
  getLayout:()=>structuredClone(geometry),
  showGraph:value=>{const next=structuredClone(value);layoutGraph(next);if(inspector.open)inspector.close();graph=next;selection=null;renderMap();fit(true);},
  setParticipantState:(id,state)=>{if(!Object.hasOwn(states,state))throw new Error('Unknown state');for(const n of graph.nodes)for(const p of n.participants||[])if(p.id===id)p.invocations.at(-1).state=state;renderMap();},
};
