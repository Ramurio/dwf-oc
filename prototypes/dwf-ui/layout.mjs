// Deterministic layered relay layout. Geometry depends only on graph structure and
// labels, never on workflow IDs, execution state, or the inspected invocation.
// The browser supplies real canvas metrics; this conservative fallback keeps
// headless geometry checks and non-browser consumers dependency-free.
const estimateText = (text, size=18) => Array.from(text).reduce((width,c)=>width+size*(/[MW@%]/.test(c)?.92:/[ilI.,:;!'| ]/.test(c)?.3:/[A-Z]/.test(c)?.68:.56),0);
export function wrapText(value, width=222, measure=text=>estimateText(text)) {
  const lines=[];
  let line='';
  for(let word of String(value).trim().split(/\s+/)) {
    if(line&&measure(line+' '+word)>width){lines.push(line);line='';}
    // Break unspaced labels too, using Unicode code points rather than UTF-16.
    while(measure(word)>width) {
      const chars=Array.from(word);let count=1;
      while(count<chars.length&&measure(chars.slice(0,count+1).join('')+'‐')<=width)count++;
      lines.push(chars.slice(0,count).join('')+'‐');word=chars.slice(count).join('');
    }
    if(word)line+=(line?' ':'')+word;
  }
  if(line)lines.push(line);
  return lines.length?lines:[''];
}
const sum = a => a.reduce((s,n)=>s+n,0);
export function layoutGraph(graph, {measure=estimateText}={}) {
  if(!graph.nodes.length)throw new Error('A map needs at least one node');
  if(new Set(graph.edges.map(e=>e.id)).size!==graph.edges.length)throw new Error('Duplicate edge ID');
  const nodes=graph.nodes.map((n,index)=>{
    const title=wrapText(n.label,n.role==='terminal'?58:n.group?208:222,t=>measure(t,18,600));
    const members=(n.group?n.participants||[]:[]).map(p=>({id:p.id,lines:wrapText(p.showRole?`${p.name} · ${p.role}`:p.name,158,t=>measure(t,16,600))}));
    const header=title.length*22+34;
    const rows=members.map(p=>Math.max(50,p.lines.length*18+28));
    return {id:n.id,index,role:n.role,group:n.group,title,members,header,rows,width:n.role==='terminal'?90:n.group?254:Math.max(150,Math.min(254,32+Math.ceil(Math.max(...title.map(t=>measure(t,18,600)))))),height:n.group?header+sum(rows)+16:n.role==='terminal'?82:Math.max(108,header+40),rank:0};
  });
  const byId=new Map(nodes.map(n=>[n.id,n]));
  if(byId.size!==nodes.length)throw new Error('Duplicate node ID');
  const edges=graph.edges.map(e=>({...e}));
  for(const e of edges)if(!byId.has(e.from)||!byId.has(e.to))throw new Error(`Unknown endpoint in ${e.id}`);
  const forward=edges.filter(e=>e.kind!=='result'&&!e.reentry);
  const incoming=n=>forward.filter(e=>e.to===n.id),outgoing=n=>forward.filter(e=>e.from===n.id);
  const degree=new Map(nodes.map(n=>[n.id,incoming(n).length]));
  const queue=nodes.filter(n=>degree.get(n.id)===0);let visited=0;
  while(queue.length) {
    const n=queue.shift();visited++;
    for(const e of outgoing(n)) { const target=byId.get(e.to);target.rank=Math.max(target.rank,n.rank+1);degree.set(target.id,degree.get(target.id)-1);if(!degree.get(target.id))queue.push(target); }
  }
  if(visited!==nodes.length)throw new Error('Control cycle: mark the reentry transition explicitly');
  const layers=Array.from({length:Math.max(0,...nodes.map(n=>n.rank))+1},(_,rank)=>nodes.filter(n=>n.rank===rank));
  // Stable barycentric sweeps reduce crossings without runtime-dependent ordering.
  for(let pass=0;pass<4;pass++) {
    const direction=pass%2===0?1:-1;
    for(let i=direction===1?1:layers.length-2;direction===1?i<layers.length:i>=0;i+=direction) {
      const score=n=>{const neighbors=(direction===1?incoming(n):outgoing(n)).map(e=>byId.get(direction===1?e.from:e.to));return neighbors.length?sum(neighbors.map(n=>(layers[n.rank].indexOf(n)+.5)/layers[n.rank].length))/neighbors.length:(layers[i].indexOf(n)+.5)/layers[i].length;};
      layers[i]=layers[i].map(n=>({n,score:score(n)})).sort((a,b)=>a.score-b.score||a.n.index-b.n.index).map(o=>o.n);
    }
  }
  const returnEdges=edges.filter(e=>e.kind==='result'||e.reentry);
  const pairedReturns=new Map();
  const pairedForward=new Set();
  for(const reverse of returnEdges) {
    const partner=forward.find(e=>e.from===reverse.to&&e.to===reverse.from&&!pairedForward.has(e.id));
    if(partner){pairedReturns.set(reverse.id,partner.id);pairedForward.add(partner.id);}
  }
  const returns=returnEdges.filter(e=>!pairedReturns.has(e.id));
  const portEdges=edges.filter(e=>!pairedReturns.has(e.id));
  const skipped=forward.filter(e=>byId.get(e.to).rank>byId.get(e.from).rank+1);
  // Every adjacent-rank caption occupies the horizontal approach to its target.
  // Reserve a port bank for lettering + the 7px paint mask, not just wire pitch.
  // The old source/destination heuristic stacked branch-to-join captions 10px
  // apart. Label-sized target ports keep captions attached to their own lines.
  const captionPitch=28;
  const inputBanks=new Map(),outputBanks=new Map();
  const captioned=e=>forward.includes(e)&&!skipped.includes(e)&&!!e.label;
  for(const n of nodes) {
    const inputs=portEdges.filter(e=>e.to===n.id),outputs=portEdges.filter(e=>e.from===n.id);
    let previousCaption=-Infinity;
    const inputOffsets=[];
    for(const [i,e] of inputs.entries()) {
      let offset=i?inputOffsets[i-1]+10:0;
      if(captioned(e)){
        offset=Math.max(offset,previousCaption+captionPitch);
        // A paired reply adds a second caption below the shared route.
        previousCaption=offset+(pairedForward.has(e.id)?36:0);
      }
      inputOffsets.push(offset);
    }
    const outputPitch=outputs.some(e=>pairedForward.has(e.id))?20:10;
    const outputOffsets=outputs.map((_,i)=>i*outputPitch);
    inputBanks.set(n.id,inputOffsets);outputBanks.set(n.id,outputOffsets);
    n.height=Math.max(n.height,(inputOffsets.at(-1)||0)+(n.group?37:28),(outputOffsets.at(-1)||0)+(n.group?40:28));
  }
  // A paired skip has a reply caption below its forward caption. Reserve
  // the whole caption block before placing the next skip route or any nodes.
  const skipLanes=new Map();
  let top=24;
  for(const edge of skipped) {
    skipLanes.set(edge.id,top);
    top+=38+(pairedForward.has(edge.id)?36:0);
  }
  const gapY=24;
  const maxHeight=Math.max(...layers.map(l=>sum(l.map(n=>n.height))+Math.max(0,l.length-1)*gapY));
  for(const layer of layers) {
    let y=top+(maxHeight-sum(layer.map(n=>n.height))-(layer.length-1)*gapY)/2;
    for(const n of layer) {n.y=y;y+=n.height+gapY;}
  }
  // Align relays to their neighbors, preserving the layer's non-overlap order.
  for(let pass=0;pass<6;pass++) {
    const dir=pass%2===0?1:-1;
    for(let i=dir===1?1:layers.length-2;dir===1?i<layers.length:i>=0;i+=dir) {
      const layer=layers[i];
      const desired=layer.map(n=>{const neighbors=(dir===1?incoming(n):outgoing(n)).map(e=>byId.get(dir===1?e.from:e.to));return neighbors.length?sum(neighbors.map(n=>n.y+n.height/2))/neighbors.length-n.height/2:n.y;});
      // Pool adjacent violators: nearest non-overlapping stack, not a greedy
      // downward push (which drifts on branch/join graphs over repeated sweeps).
      let offset=0;
      const offsets=layer.map(n=>{const value=offset;offset+=n.height+gapY;return value;});
      const blocks=[];
      desired.forEach((value,j)=>{
        blocks.push({start:j,end:j,total:value-offsets[j],weight:1});
        while(blocks.length>1) {
          const b=blocks.at(-1),a=blocks.at(-2);
          if(a.total/a.weight<=b.total/b.weight)break;
          blocks.splice(-2,2,{start:a.start,end:b.end,total:a.total+b.total,weight:a.weight+b.weight});
        }
      });
      for(const b of blocks)for(let j=b.start;j<=b.end;j++)layer[j].y=b.total/b.weight+offsets[j];
      const shift=Math.max(0,top-layer[0].y);
      for(const n of layer)n.y+=shift;
    }
  }
  const left=48+returns.length*14;
  let x=left;
  const gutters=[];
  for(let i=0;i<layers.length;i++) {
    const layer=layers[i],width=Math.max(...layer.map(n=>n.width));
    for(const n of layer)n.x=x;
    const departing=edges.filter(e=>byId.get(e.from).rank===i);
    const labels=forward.filter(e=>byId.get(e.to).rank===i+1).flatMap(e=>{
      const reverse=returnEdges.find(r=>pairedReturns.get(r.id)===e.id);
      return [measure((e.label||'')+' →',14,400),reverse?measure('← '+reverse.label,14,400):0];
    });
    // Leave a complete caption segment after all vertical routing tracks.
    const gap=Math.max(152,...labels.map(w=>w+40+departing.length*14),departing.length*15+88);
    gutters[i]={x:x+width,width:gap};x+=width+gap;
  }
  // Reserve full caption ascenders and mask below the lowest platform too.
  const bottom=Math.max(...nodes.map(n=>n.y+n.height))+30;
  // Every side uses a centered port bank. A reply shares its forward route's
  // bank position rather than reserving a second port on the opposite side.
  const inEdges=n=>portEdges.filter(e=>e.to===n.id);
  const outEdges=n=>portEdges.filter(e=>e.from===n.id);
  const port=(n,e,input)=>{
    const list=input?inEdges(n):outEdges(n),bank=(input?inputBanks:outputBanks).get(n.id);
    const offset=bank[list.indexOf(e)],span=bank.at(-1)||0;
    return {x:n.x+(input?0:n.width),y:n.y+n.height/2+offset-span/2};
  };
  const sortedReturns=[...returns].sort((a,b)=>byId.get(b.from).y-byId.get(a.from).y||edges.indexOf(a)-edges.indexOf(b));
  const returnPlans=new Map();
  let nextLane=bottom;
  sortedReturns.forEach((e,index)=>{
    const source=byId.get(e.from),target=byId.get(e.to);
    const slot=edges.filter(e=>byId.get(e.from).rank===source.rank).indexOf(e);
    const sx=gutters[source.rank].x+24+slot*14,tx=target.x-24-index*14;
    const count=source.group?(graph.nodes.find(n=>n.id===source.id).participants||[]).length:0;
    const wording=`${e.kind==='result'&&count?'all '+count+' ':''}${e.label} → ${graph.nodes.find(n=>n.id===target.id).label}`;
    const lines=wrapText(wording,Math.max(120,Math.abs(sx-tx)-32),t=>measure(t,14,400));
    const lane=nextLane+(lines.length-1)*18;
    returnPlans.set(e,{sx,tx,lane,lines,text:wording});nextLane=lane+30;
  });
  const routes=edges.map(e=>{
    if(pairedReturns.has(e.id))return {id:e.id,from:e.from,to:e.to,kind:e.kind||'control',reentry:!!e.reentry,points:[],label:{}};
    const source=byId.get(e.from),target=byId.get(e.to),start=port(source,e,false),finish=port(target,e,true);
    let points,label;
    const fromEdges=edges.filter(e=>byId.get(e.from).rank===source.rank),slot=fromEdges.indexOf(e);
    if(returns.includes(e)) {
      const {sx,tx,lane,lines,text}=returnPlans.get(e);
      points=[start,{x:sx,y:start.y},{x:sx,y:lane},{x:tx,y:lane},{x:tx,y:finish.y},finish];
      label={x:(sx+tx)/2,y:lane-9-(lines.length-1)*18,text,lines,anchor:'middle'};
    } else if(skipped.includes(e)) {
      const lane=skipLanes.get(e.id),sx=gutters[source.rank].x+24+slot*14,tx=target.x-24;
      points=[start,{x:sx,y:start.y},{x:sx,y:lane},{x:tx,y:lane},{x:tx,y:finish.y},finish];
      label={x:(sx+tx)/2,y:lane-8,text:e.label,anchor:'middle'};
    } else {
      const lane=gutters[source.rank].x+24+slot*14;
      points=[start,{x:lane,y:start.y},{x:lane,y:finish.y},finish];
      label={x:finish.x-10,y:finish.y-10,text:e.label,anchor:'end'};
    }
    return {id:e.id,from:e.from,to:e.to,kind:e.kind||'control',reentry:!!e.reentry,points,label};
  });
  for(const [reverseId,forwardId] of pairedReturns) {
    const outward=routes.find(e=>e.id===forwardId),reverse=routes.find(e=>e.id===reverseId);
    const center=outward.points;
    outward.points=offsetPolyline(center,-3);
    reverse.points=offsetPolyline(center,3).reverse();
    outward.pairedWith=reverse.id;
    reverse.pairedWith=outward.id;
    outward.label={...outward.label,y:outward.label.y-3,text:outward.label.text+' →'};
    const label='← '+edges.find(e=>e.id===reverseId).label;
    reverse.label={x:outward.label.x,y:outward.label.y+36,text:label,lines:[label],anchor:outward.label.anchor};
  }
  return {nodes:nodes.map(({index,...n})=>n),edges:routes,width:Math.max(...nodes.map(n=>n.x+n.width))+100+returns.length*14,height:returns.length?nextLane-6:bottom+24};
}

// Offset every segment together so opposing directions stay six pixels apart
// through corners as well as straight sections.
export function offsetPolyline(points,offset) {
  const clean=points.filter((p,i)=>!i||p.x!==points[i-1].x||p.y!==points[i-1].y);
  if(clean.length<2)return clean.map(point=>({...point}));
  const normals=clean.slice(1).map((p,i)=>{
    const dx=p.x-clean[i].x,dy=p.y-clean[i].y,length=Math.hypot(dx,dy);
    return {x:-dy/length,y:dx/length};
  });
  return clean.map((point,i)=>{
    const previous=normals[Math.max(0,i-1)],next=normals[Math.min(i,normals.length-1)];
    const denominator=1+previous.x*next.x+previous.y*next.y;
    const normal=denominator>1e-6?{x:(previous.x+next.x)/denominator,y:(previous.y+next.y)/denominator}:previous;
    return {x:point.x+normal.x*offset,y:point.y+normal.y*offset};
  });
}

export function roundedPath(points, radius=8) {
  let d=`M${points[0].x},${points[0].y}`;
  for(let i=1;i<points.length-1;i++) {
    const [a,b,c]=[points[i-1],points[i],points[i+1]];
    const length=(p,q)=>Math.abs(p.x-q.x)+Math.abs(p.y-q.y);
    const r=Math.min(radius,length(a,b)/2,length(b,c)/2);
    const toward=(p,q)=>{const len=length(p,q)||1;return {x:p.x+(q.x-p.x)*r/len,y:p.y+(q.y-p.y)*r/len};};
    const p=toward(b,a),q=toward(b,c);
    d+=` L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`;
  }
  const last=points.at(-1);return `${d} L${last.x},${last.y}`;
}
