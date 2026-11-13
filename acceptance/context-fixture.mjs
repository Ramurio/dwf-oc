// Eight distinct complete tasks, shared by routing checks and size comparison.
export function eightTasks() {
  const taskPackages = Array.from({ length: 8 }, (_, i) => ({ formatVersion: 1, id: `task-${i}`,
    requirements: `UNIQUE_REQUIREMENT_${i}\r\n` + `Detailed specification for feature ${i}. `.repeat(80),
    acceptanceCriteria: Array.from({ length: 5 }, (_, n) => `CRITERION_${i}_${n}: exact observable behavior ${n}`),
    dependencies: i ? [`task-${i - 1}`] : [],
    decisions: [{ id: 'contract', text: `DECISION_${i}`, source: `user:approval-${i}` }],
    artifacts: [{ id: 'spec', uri: `docs/feature-${i}.md` }] }));
  const nodes = Object.fromEntries(taskPackages.flatMap((task, i) => ['worker', 'reviewer', 'verifier'].map(role =>
    [`${role}${i}`, { role, taskId: task.id, instructions: `ASSIGNMENT_${role}_${i}` }])));
  nodes.manager = { role: 'orchestrator', instructions: 'MANAGER_OWN_INSTRUCTIONS', model: { provider: 'private', modelId: 'hidden' } };
  const transitions = Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id,
    n.role === 'reviewer' ? { approve: `verifier${id.slice(8)}`, changes: 'manager' } :
      n.role === 'verifier' ? { approve: 'manager', changes: 'manager' } : { done: 'manager' }]));
  transitions.manager = { ...Object.fromEntries(taskPackages.map((_, i) => [`assign${i}`, `worker${i}`])), done: null };
  return { task: taskPackages.map(t => t.requirements + '\n' + t.acceptanceCriteria.join('\n')).join('\n'),
    taskPackages, nodes, transitions, entry: 'manager' };
}

