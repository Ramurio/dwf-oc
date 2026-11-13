export function implementDefinition() {
  const task = (id, dependencies = []) => ({ formatVersion: 1, id, requirements: `Create ${id}.txt`,
    acceptanceCriteria: [`${id}.txt contains ${id}`], dependencies, decisions: [], artifacts: [] });
  return { task: 'Combine alpha, beta and dependent gamma', entry: 'manage', merge: true,
    taskPackages: [task('alpha'), task('beta'), task('gamma', ['alpha', 'beta'])],
    roles: { worker: { tools: ['shell'], skills: [] }, reviewer: { tools: [], skills: [] },
      verifier: { tools: [], skills: [] }, orchestrator: { skills: [] } },
    nodes: { manage: { role: 'orchestrator' }, work: { role: 'worker' }, review: { role: 'reviewer' },
      verify: { role: 'verifier' }, integrationReview: { role: 'reviewer' }, integrationVerify: { role: 'verifier' } },
    implements: { concurrency: 2, instances: Object.fromEntries(['alpha', 'beta', 'gamma'].map(id => [id,
      { taskId: id, worker: 'work', reviewer: 'review', verifier: 'verify' }])) },
    transitions: { manage: { dispatch: 'implements', finish: 'integrationReview', done: null },
      implements: { done: 'manage' }, work: { done: 'review' }, review: { approve: 'verify', changes: 'work' },
      verify: { approve: null, changes: 'work' }, integrationReview: { approve: 'integrationVerify', changes: 'manage' },
      integrationVerify: { approve: null, changes: 'manage' } } };
}
