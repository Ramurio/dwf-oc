// Fictional, static observations. No runtime or OpenCode connection.
export const skills = {
  research: ['Source research', 'Compare primary sources, retain citations, and identify gaps in the evidence.'],
  interface: ['Interface evaluation', 'Test whether context, ownership, and result delivery are clear in concrete scenarios.'],
  code: ['Code work', 'Make a focused change and verify the externally observable behavior.'],
  review: ['Independent review', 'Separate reproducible defects from preferences; review without relying on the author’s conclusion.'],
  verify: ['Behavioral verification', 'Exercise ordinary and boundary cases; record reproducible results.'],
};
const call = (time, session, task, result, state = 'done', options = {}) => ({time, session, task, result, state, model:'OpenAI · GPT-5', reasoning:'High', speed:'Ordinary', skills:['research'], ...options});
const person = (id, name, role, memory, invocations) => ({id,name,role,memory,invocations});
const scientist = person('scientist','Scientist','scientist',true,[
  call('09:12','demo_ses_scientist_01','Plan an investigation into agent session memory.','Ask two scouts to study session identity and existing tools.'),
  call('09:17','demo_ses_scientist_01','Compare the scout reports.','Commission four independent research questions.'),
  call('09:25','demo_ses_scientist_01','Synthesize all four research results.','Submit a proposal to the committee.'),
  call('09:30','demo_ses_scientist_01','Address the committee’s request for evidence about session identity.','Recall the two scouts in their original sessions.'),
  call('09:35','demo_ses_scientist_01','Use the new scout reports to refine the research tasks.','Waiting for the final interface research result.','waiting'),
]);
const scouts = ['Sessions','Tools'].map((name,i) => person(`scout-${i}`,name,'scout',true,[
  call('09:14',`demo_ses_scout_${i+1}`, i ? 'Study ways to enter OpenCode.' : 'Find the rules for session continuation.',i ? 'Use opencode --session <ID> to enter a session.' : 'A role name is not identity. The actual session ID is the key.','done',{speed:'Fast',reasoning:'Medium'}),
  call('09:32',`demo_ses_scout_${i+1}`,i ? 'Verify manual session entry.' : 'Verify the memory:false behavior.',i ? 'The UI can supply a command; live entry requires a real session.' : 'An ordinary reentry with memory:false creates a fresh session.','done',{speed:'Fast',reasoning:'Medium'}),
]));
const questions = ['Compare the evidence for agent identity.','Distinguish context from the result of a call.','Estimate the cost of reading context again.','Test how to show continued and fresh contexts.'];
const answers = ['Identity follows the session ID, not the role.','A result is an artifact; context belongs to one session.','A fresh session needs the relevant task and materials again.','Keep the architecture visible and inspect invocation history separately.'];
const researchers = ['Sources','Context','Cost','Interface'].map((name,i) => person(`researcher-${i}`,name,'researcher',false,[
  call('09:19',`demo_ses_r${i+1}_a`,questions[i],answers[i],'done',{skills:i===3?['research','interface']:['research']}),
  call('09:38',`demo_ses_r${i+1}_b`,questions[i]+' Independently recheck after committee feedback, without using the old context.',i===3?null:answers[i],i===3?'active':'done',{skills:i===3?['research','interface']:['research'],reasoning:i===3?'High':'Medium'}),
]));
const committee = person('committee','Committee','committee',false,[
  call('09:26','demo_ses_committee_a','Review the draft synthesis independently.','Request clearer citations before the final review.','done',{model:'Anthropic · Claude Sonnet 4',skills:['review']}),
  call('09:28','demo_ses_committee_b','Independently evaluate the scientist’s proposal.','Changes requested: show actual old and new session IDs, not just role names.','done',{model:'Anthropic · Claude Sonnet 4',skills:['review']}),
]);
const worker = person('worker','Worker','worker',true,[
  call('08:10','demo_ses_worker_01','Add Markdown export for notes.','Export implemented; ready for review.','done',{skills:['code']}),
  call('08:20','demo_ses_worker_01','Fix the reviewer’s finding: escape Markdown headings.','Escaping fixed. Repeat review approved.','done',{skills:['code']}),
  call('08:33','demo_ses_worker_01','Fix the verifier’s finding: exporting an empty note must not throw.',null,'active',{skills:['code']}),
]);
const reviewer = person('reviewer','Reviewer','reviewer',true,[
  call('08:18','demo_ses_reviewer_01','Review the export implementation.','Changes: Markdown headings are not escaped.','done',{skills:['review']}),
  call('08:27','demo_ses_reviewer_01','Review the escaping fix.','Approved. Send to verification.','done',{skills:['review']}),
]);
const verifier = person('verifier','Verifier','verifier',true,[
  call('08:30','demo_ses_verifier_01','Verify ordinary, empty, and Unicode notes.','Changes: empty-note export throws. Return to the same worker.','done',{skills:['verify'],speed:'Fast',reasoning:'Medium'}),
]);
const node = (id,label,role,participants,more={}) => ({id,label,role,participants,...more});
const end = () => node('end','End','terminal',[]);
const edge = (from,to,label,more={}) => ({id:`${from}-${to}`,from,to,label,kind:'control',...more});
const samplePerson = (id,name,role='worker',active=false) => person(id,name,role,true,[call('07:12',`demo_ses_${id}`,'Complete the assigned step and pass on the verified result.',active?null:'Step complete; result delivered.',active?'active':'done',{skills:[role==='reviewer'?'review':'code']})]);
const step = (id,label,role='worker',active=false) => node(id,label,role,[samplePerson(id,label,role,active)]);
export const runs = [
  {id:'research',project:'atlas-lab',time:'09:42',title:'Memory research',description:'Independent evidence, one continuing scientist.',now:'Interface researcher is working',nodes:[
    node('scientist','Scientist','scientist',[scientist]),node('scouts','Scouts','scout',scouts,{group:'fixed'}),node('researchers','Researchers','researcher',researchers,{group:'data-driven'}),node('committee','Committee','committee',[committee]),end(),
  ],edges:[edge('scientist','scouts','scout'),edge('scientist','researchers','research'),edge('scientist','committee','review'),edge('committee','end','approve'),edge('scouts','scientist','results',{kind:'result'}),edge('researchers','scientist','results',{kind:'result'}),edge('committee','scientist','changes',{reentry:true})]},
  {id:'build',project:'local-notes',time:'08:33',title:'Markdown export',description:'Two independent checks. Both can recall the same worker.',now:'Worker is fixing empty-note export',nodes:[node('worker','Worker','worker',[worker]),node('reviewer','Reviewer','reviewer',[reviewer]),node('verifier','Verifier','verifier',[verifier]),end()],edges:[edge('worker','reviewer','ready'),edge('reviewer','verifier','approve'),edge('verifier','end','pass'),edge('reviewer','worker','changes',{reentry:true}),edge('verifier','worker','changes',{reentry:true})]},
  {id:'branch',project:'release-kit',time:'07:50',title:'Branch & join',description:'A small parallel split, then one shared release.',now:'Release preparation is working',nodes:[step('plan','Plan release'),step('docs','Write documentation'),step('tests','Run smoke tests','verifier'),step('join','Prepare release','worker',true),end()],edges:[edge('plan','docs','documents'),edge('plan','tests','checks'),edge('docs','join','ready'),edge('tests','join','pass'),edge('join','end','publish')]},
  {id:'returns',project:'signal-lab',time:'07:20',title:'Multiple returns',description:'Two correction loops and a long-range alternate route.',now:'Analyst is revising the evidence',nodes:[step('draft','Draft evidence','worker',true),step('audit','Audit sources','reviewer'),step('trial','Reproduce findings','verifier'),step('publish','Publish decision'),end()],edges:[edge('draft','audit','submit'),edge('audit','trial','approve'),edge('trial','publish','verified'),edge('publish','end','archive'),edge('audit','draft','revise sources',{reentry:true}),edge('trial','draft','recheck evidence',{reentry:true}),edge('draft','publish','expedited route')]},
  {id:'ensemble',project:'language-kit',time:'06:45',title:'Seven perspectives',description:'A data-driven ensemble with a different participant count.',now:'Japanese language review is working',nodes:[step('editor','Editor'),node('languages','Language reviewers','researcher',['English','French','German','Japanese','Portuguese','Spanish','Ukrainian'].map((name,i)=>samplePerson(`language-${i}`,name,'researcher',i===3)),{group:'data-driven'}),step('merge','Merge findings'),end()],edges:[edge('editor','languages','review in parallel'),edge('languages','merge','all complete'),edge('merge','end','publish'),edge('languages','editor','results',{kind:'result'})]},
];
const largeNodes = [step('intake','Frame the cross-platform accessibility investigation')];
const largeEdges = [];
const streams = ['Keyboard navigation and focus restoration','Enlarged text and responsive content reflow','Session identity and invocation correspondence','Automatic routing and stable topology updates'];
for(let row=0;row<4;row++) for(let col=0;col<4;col++) {
  const id=`stream-${row}-${col}`;
  largeNodes.push(step(id,[`Investigate ${streams[row]}`,`Implement ${streams[row]}`,`Independently review ${streams[row]}`,`Verify ${streams[row]}`][col],['researcher','worker','reviewer','verifier'][col],row===1&&col===1));
  largeEdges.push(edge(col?`stream-${row}-${col-1}`:'intake',id,col?'ready':'delegate'));
}
largeNodes.push(step('synthesis','Synthesize independently verified findings'),end());
for(let row=0;row<4;row++)largeEdges.push(edge(`stream-${row}-3`,'synthesis','verified'));
largeEdges.push(edge('synthesis','end','accept'),edge('stream-2-2','stream-2-1','changes',{reentry:true}),edge('stream-0-3','intake','reframe',{reentry:true}));
runs.push({id:'large',project:'accessibility-lab',time:'06:10',title:'Cross-platform investigation',description:'19 primitives · four parallel streams · long labels.',now:'Text and reflow implementation is working',nodes:largeNodes,edges:largeEdges});

// The adapter boundary: nodes/groups + transitions + observed participants → map.
// It does not interpret runtime files, schedule work, or invent missing sessions.
export function toGraph(run) {
  return {nodes:structuredClone(run.nodes),edges:structuredClone(run.edges)};
}
