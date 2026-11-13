import { implementDefinition } from './implement-definition.mjs';
export function implementUiFixture(count = 2) {
  const definition = implementDefinition();
  definition.merge = false;
  definition.taskPackages = Array.from({length: count}, (_, i) => ({formatVersion: 1, id: `task-${i}`,
    beadsId: `project-${i}`, title: `Human task ${i}: readable explicit title`, requirements: `Exact requirements ${i}`,
    acceptanceCriteria: ['Check the result'], dependencies: i === count-1 && count > 2 ? ['task-0'] : [], decisions: [], artifacts: []}));
  definition.implements.instances = Object.fromEntries(definition.taskPackages.map((task, i) => [`unit-${i}`, {taskId: task.id, worker: 'work', reviewer: 'review', verifier: 'verify'}]));
  return {id: 'implement-ui', createdAt: 1, definition, status: 'running', sessions: {}, visits: [],
    workspace: {path: '/controlled/project'}, implements: {events: [], instances: Object.fromEntries(definition.taskPackages.map((task, i) => [`unit-${i}`, {id: `unit-${i}`, taskId: task.id, status: 'pending'}]))}};
}

