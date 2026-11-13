// Reproducible character counts, not token/cost estimates or a replay of private logs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalProblems } from '../workflow-definition.mjs';
import { prepareRoleInput } from '../role-context.mjs';
import { eightTasks } from './context-fixture.mjs';

// Frozen pre-xit.2 assembly for these ordinary worker/manager calls, with the
// existing separate system agent. No history, previous result or review in this case.
function oldPrompt(definition, nodeId, workspace) {
  const node = definition.nodes[nodeId];
  const routes = definition.transitions[nodeId];
  return [node.instructions ?? '',
    node.role === 'orchestrator' ? `Workflow control context:\n${JSON.stringify({ transitions: routes,
      ...(Object.keys(routes).length > 1 ? { nodes: definition.nodes, groups: definition.groups ?? {}, routes: definition.transitions } : {}),
      approvalProblems: approvalProblems({ definition, visits: [] }, 'candidate-2') })}` : '',
    `Project workspace: ${workspace.path}`,
    `Поручение пользователя:\n${definition.task}`,
    'Workspace snapshot recorded and checked by DWF: candidate-2',
  ].filter(Boolean).join('\n\n');
}

export function contextSizeComparison() {
  const root = mkdtempSync(join(tmpdir(), 'dwf-context-size-'));
  try {
    const definition = eightTasks();
    // Before packages were consumed, the author supplied each bounded worker's
    // exact requirements in its instructions as well as the full original task.
    const legacy = structuredClone(definition);
    for (let i = 0; i < 8; i++) legacy.nodes[`worker${i}`].instructions += '\n' +
      definition.taskPackages[i].requirements + '\n' + definition.taskPackages[i].acceptanceCriteria.join('\n');
    const state = { id: 'size-comparison', definition, visits: [], workspace: { path: root }, roleAgents: {} };
    const rows = ['manager', 'worker0'].map(node => {
      const visit = { node, inputId: `msg_${node}`, revision: 'candidate-2',
        ...(node === 'worker0' ? { taskId: 'task-0', taskVersion: 1 } : {}) };
      prepareRoleInput(root, state, visit);
      const baseline = oldPrompt(legacy, node, state.workspace);
      const unchangedDefinitionBaseline = oldPrompt(definition, node, state.workspace);
      const count = (text, fragment) => text.split(fragment).length - 1;
      const occurrences = text => definition.taskPackages.map((_, i) => count(text, `UNIQUE_REQUIREMENT_${i}`));
      // Exact addressed strings are checked, never shortened to meet a size budget.
      if (visit.taskContext.task) assert.deepEqual(visit.taskContext.task.acceptanceCriteria, definition.taskPackages[0].acceptanceCriteria);
      return { role: definition.nodes[node].role,
        beforeChars: baseline.length, unchangedDefinitionBeforeChars: unchangedDefinitionBaseline.length,
        afterChars: visit.prompt.length,
        reductionPercent: Number((100 * (1 - visit.prompt.length / baseline.length)).toFixed(1)),
        beforeRequirementOccurrences: occurrences(baseline), afterRequirementOccurrences: occurrences(visit.prompt),
        beforeManagerInstructionOccurrences: count(baseline, 'MANAGER_OWN_INSTRUCTIONS'),
        afterManagerInstructionOccurrences: count(visit.prompt, 'MANAGER_OWN_INSTRUCTIONS') };
    });
    return { unit: 'JavaScript UTF-16 code units', tasks: 8, sourceRequirementChars: definition.taskPackages.reduce((n, t) => n + t.requirements.length, 0),
      criteria: 40, separateSystem: true, rows };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(contextSizeComparison(), null, 2));
