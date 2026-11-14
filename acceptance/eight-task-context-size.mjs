// Offline measurement of the eight original Beads descriptions. No start/model
// calls; this does not execute those tasks or claim to reproduce a private log.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRoleInput } from '../role-context.mjs';
import { eightTasks } from './context-fixture.mjs';

export async function eightTaskContextSize() {
  const ids = ['cuo', 'co1', '8ic', 'hni', 'vku', '22f', '715', '3af'].map(id => `dwf-oc-${id}`);
  const issues = (await readFile(new URL('../.beads/issues.jsonl', import.meta.url), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse);
  const definition = eightTasks(); // Assembly fixture only, not an execution graph for these tasks.
  definition.task = 'Read the eight addressed Beads tasks and implement their agreed requirements.';
  definition.taskPackages = ids.map(id => {
    const issue = issues.find(item => item._type === 'issue' && item.id === id);
    assert(issue?.description && issue.acceptance_criteria, `Missing source data: ${id}`);
    return { formatVersion: 1, id, beadsId: id, title: issue.title,
      requirements: issue.description, acceptanceCriteria: [issue.acceptance_criteria],
      dependencies: (issue.dependencies ?? []).filter(d => d.type === 'blocks' && ids.includes(d.depends_on_id)).map(d => d.depends_on_id),
      decisions: [], artifacts: [{ id: 'source', uri: '.beads/issues.jsonl' }] };
  });
  for (let i = 0; i < ids.length; i++) {
    for (const role of ['worker', 'reviewer', 'verifier']) definition.nodes[`${role}${i}`].taskId = ids[i];
  }
  const directory = await mkdtemp(join(tmpdir(), 'dwf-eight-beads-context-'));
  try {
    const state = { id: 'eight-beads-size', definition, visits: [], workspace: { path: directory }, roleAgents: {} };
    const rows = [];
    for (const [node, configuration] of Object.entries(definition.nodes)) {
      const visit = { node, inputId: `msg_${node}`, revision: 'measurement-candidate',
        ...(configuration.taskId ? { taskId: configuration.taskId, taskVersion: 1 } : {}) };
      prepareRoleInput(directory, state, visit);
      const occurrences = definition.taskPackages.map(task => {
        // Count the exact JSON-escaped description, not a shared first line.
        const fragment = JSON.stringify(task.requirements).slice(1, -1);
        return visit.prompt.split(fragment).length - 1;
      });
      assert.deepEqual(occurrences, ids.map(id => Number(id === configuration.taskId)));
      if (configuration.taskId) {
        const expected = definition.taskPackages.find(task => task.id === configuration.taskId);
        assert.equal(visit.taskContext.task.requirements, expected.requirements);
        assert.deepEqual(visit.taskContext.task.acceptanceCriteria, expected.acceptanceCriteria);
      }
      rows.push({ node, role: configuration.role, taskId: configuration.taskId ?? null,
        chars: visit.prompt.length, utf8Bytes: Buffer.byteLength(visit.prompt), exactDescriptionOccurrences: occurrences });
    }
    return { unit: 'UTF-16 code units; UTF-8 bytes reported separately', source: '.beads/issues.jsonl', ids,
      sourceRequirementChars: definition.taskPackages.reduce((n, task) => n + task.requirements.length, 0),
      criteriaFields: 8, rows,
      limitations: ['Offline initial role-input assembly, not execution of the eight tasks or model wire traffic.',
        'Each exact acceptance_criteria field is one string, not reinterpreted as individual criteria.',
        'Only in-corpus blocks dependencies; related links are not scheduler dependencies.',
        'No comments/decisions synthesized; no token or cost estimates; system and skill text excluded.'] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await eightTaskContextSize(), null, 2));
