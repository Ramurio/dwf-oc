import { createHash } from 'node:crypto';
import { publicError } from './run-store.mjs';
import { roleSkills } from './role-skills.mjs';

export const outcomes = {
  worker: ['done'], reviewer: ['approve', 'changes'],
  verifier: ['approve', 'changes'], orchestrator: ['done'],
};

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

export function validateWorkflow(value) {
  const reject = message => { throw publicError('Workflow: ' + message); };
  if (!object(value)) reject('ожидается объект.');
  if (Object.keys(value).some(key => !['task', 'entry', 'nodes', 'transitions', 'merge'].includes(key))) reject('неизвестное поле.');
  if (typeof value.task !== 'string' || !value.task.trim()) reject('нужно непустое task.');
  if (!object(value.nodes) || !Object.keys(value.nodes).length) reject('нужны nodes.');
  if (!object(value.transitions)) reject('нужны transitions.');
  if (!identifier(value.entry) || !Object.hasOwn(value.nodes, value.entry)) reject('entry должен указывать на участника.');
  if (value.merge !== undefined && typeof value.merge !== 'boolean') reject('merge должен быть boolean.');
  for (const [id, node] of Object.entries(value.nodes)) {
    if (!identifier(id) || !object(node) || !Object.hasOwn(outcomes, node.role)) reject('неверный участник ' + id);
    if (Object.keys(node).some(key => !['role', 'instructions'].includes(key)) ||
      (node.instructions !== undefined && typeof node.instructions !== 'string')) reject('неверные настройки ' + id);
    const routes = value.transitions[id];
    if (!object(routes) || Object.keys(routes).some(key => !outcomes[node.role].includes(key))) reject('неверные переходы ' + id);
    for (const outcome of outcomes[node.role]) {
      if (!Object.hasOwn(routes, outcome)) reject(`нужен переход ${id}.${outcome}`);
      if (routes[outcome] !== null && (!identifier(routes[outcome]) || !Object.hasOwn(value.nodes, routes[outcome]))) reject('неизвестный адресат перехода.');
    }
  }
  if (Object.keys(value.transitions).some(id => !Object.hasOwn(value.nodes, id))) reject('переход от неизвестного участника.');
  const seen = new Set();
  const pending = [value.entry];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...Object.values(value.transitions[id]).filter(next => next !== null));
  }
  if (seen.size !== Object.keys(value.nodes).length) reject('есть недостижимые участники.');
  if (![...seen].some(id => Object.values(value.transitions[id]).includes(null))) reject('нужен завершающий переход null.');
  if (value.merge && !['reviewer', 'verifier'].every(role => Object.values(value.nodes).some(node => node.role === role))) {
    reject('merge требует reviewer и verifier.');
  }
  return structuredClone(value);
}

export function parseVerdict(text, role) {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1);
  let result;
  try { result = JSON.parse(fenced ? fenced[1] : text); }
  catch { throw publicError('Участник вернул неверный JSON результата.'); }
  if (!object(result) || ![...outcomes[role], 'blocked'].includes(result.outcome) ||
    typeof result.summary !== 'string' || !result.summary.trim()) {
    throw publicError('Результат участника требует допустимый outcome и непустой summary.');
  }
  return result;
}

export function rolePermissions(role) {
  const actions = role === 'planner' ? [] : ['read', 'glob', 'grep'];
  if (role !== 'orchestrator' && role !== 'planner') actions.push('webfetch', 'websearch');
  if (role === 'worker') actions.push('shell', 'edit', 'write');
  if (role === 'verifier') actions.push('shell');
  return [{ action: '*', resource: '*', effect: 'deny' },
    ...actions.map(action => ({ action, resource: '*', effect: 'allow' })),
    ...(roleSkills[role] ?? []).map(skill =>
      ({ action: 'skill', resource: skill.id, effect: 'allow' }))];
}

const commonInstructions = [
  'Execute your configured role. DWF runs the other workflow participants and passes their results to you.',
  'Work within the supplied project workspace. Read applicable AGENTS.md files inside it and any inherited project instructions supplied with the task. Parent directories contain DWF runtime data and are outside the project.',
  'DWF records the workspace snapshot, checks that reviews and verification cover the current files, and manages Git branches and integration. Treat its supplied snapshot identifier as an opaque reference. Leave snapshot calculation and Git index management to DWF.',
  'Distinguish observed facts from assumptions and other participants\' conclusions. Report actions and checks truthfully.',
  'If an obstacle prevents completion, return blocked. State the cause, the unfinished work and what is needed to continue.',
].join('\n');
const roleInstructions = {
  worker: [
    'Complete the assigned task and verify the result with the available tools. Use available skills when their descriptions match the task. When revising, assess the feedback and fix confirmed problems.',
    'Return done when the task is complete and verified within the available means. State remaining limitations and checks you could not run.',
    'In summary, describe the changes, checks performed and their results. For revisions, explain how you addressed the feedback.',
  ].join('\n'),
  reviewer: [
    'Independently review the result against the original requirements through static analysis. You can read and search files. The verifier runs tests and user scenarios. Preserve project files.',
    'Check for bugs, regressions and unmet requirements. For each finding, identify the location, triggering conditions and consequences. Support findings with evidence from the reviewed result.',
    'Return changes for defects that require correction, or approve when your review finds none.',
    'In summary, list actionable findings or explain what you reviewed and the basis for approval. State review limitations.',
  ].join('\n'),
  verifier: [
    'Independently verify the result against the original requirements. Run the necessary checks and reproduce user scenarios with the available tools. Use temporary data. Preserve project files.',
    'Base your conclusion on your own checks. Return changes for unmet requirements. Include reproduction steps and the expected and actual results.',
    'Return approve when the checks required by the task succeed. If a necessary check cannot be performed, return blocked.',
    'In summary, state the checks performed, their results and remaining limitations.',
  ].join('\n'),
  orchestrator: [
    'Summarize the history of completed stages. Preserve project files.',
    'Cover the task result, findings, corrections and reviewers\' decisions for the current revision when those stages are present. Distinguish participants\' reports and your own observations. Identify missing information and unfinished work.',
    'Return done when the summary is complete using the available history. This status records completion of the summary. Stage decisions determine the overall workflow result. DWF adds the actual integration result after this stage. Summarize the completed stages and leave that final integration status to DWF.',
    'In summary, give the outcome and the material evidence supporting it.',
  ].join('\n'),
};

function resultInstructions(role) {
  return `Your final response must be JSON {"outcome":"${outcomes[role].join('|')}|blocked","summary":"result or specific findings"}. Choose one outcome value.`;
}

export function roleSystemPrompt(role) {
  return [commonInstructions, roleInstructions[role], resultInstructions(role)].join('\n\n');
}

export const roleAgents = Object.fromEntries(Object.keys(outcomes).map(role => [role,
  `dwf-${role}-${createHash('sha256').update(JSON.stringify({
    system: roleSystemPrompt(role), permissions: rolePermissions(role),
  })).digest('hex').slice(0, 16)}`]));

export function rolePrompt(definition, nodeId, previous, revision, visits = [], separateSystem = false, review, workspace) {
  const node = definition.nodes[nodeId];
  const history = node.role === 'orchestrator' ? visits.flatMap((visit, index) => visit.verdict ? [{
    visit: index + 1, node: visit.node, role: definition.nodes[visit.node].role,
    sessionId: visit.sessionId, revision: visit.revision, result: visit.verdict,
  }] : []) : undefined;
  return [
    separateSystem ? '' : commonInstructions,
    separateSystem ? '' : roleInstructions[node.role],
    node.instructions ?? '',
    workspace ? `Project workspace: ${workspace.path}` : '',
    workspace?.instructions?.length ? `Inherited project instructions captured at workflow start (outermost first):\n${JSON.stringify(workspace.instructions)}` : '',
    `Поручение пользователя:\n${definition.task}`,
    `Workspace snapshot recorded and checked by DWF: ${revision}`,
    review ? `Материалы ревью (полный diff относительно начала задачи):\n${JSON.stringify(review)}` : '',
    history ? `Завершённые этапы workflow (по порядку):\n${JSON.stringify(history)}` :
      previous ? `Предыдущий результат участника:\n${JSON.stringify(previous)}` : '',
    separateSystem ? '' : resultInstructions(node.role),
  ].filter(Boolean).join('\n\n');
}
