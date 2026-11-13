import { validateTaskPackages } from './task-packages.mjs';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { publicError } from './run-store.mjs';
import { roleSkills, bundledSkills } from './role-skills.mjs';
import { researchGraph, researchInstructions, researchModel, researchRoles,
  scientistPhase, validateResearchGraph } from './research-workflow.mjs';

export const outcomes = {
  worker: ['done'], reviewer: ['approve', 'changes'],
  verifier: ['approve', 'changes'], orchestrator: ['done'],
  ...Object.fromEntries(Object.entries(researchRoles).map(([role, config]) => [role, config.outcomes])),
};
export const groupOutcomes = ['done', 'changes', 'failed'];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

const settings = ['model', 'reasoning', 'tools', 'skills', 'memory'];

function validateSettings(value, role, reject) {
  if (value.model !== undefined && (!object(value.model) ||
    Object.keys(value.model).some(key => !['provider', 'modelId'].includes(key)) ||
    !['provider', 'modelId'].every(key => typeof value.model[key] === 'string' && value.model[key].trim()))) reject('неверная модель.');
  if (value.reasoning !== undefined && value.reasoning !== null &&
    (typeof value.reasoning !== 'string' || !value.reasoning.trim())) reject('неверный reasoning.');
  if (value.memory !== undefined && typeof value.memory !== 'boolean') reject('memory должен быть boolean.');
  for (const field of ['tools', 'skills']) {
    if (value[field] === undefined) continue;
    const allowed = field === 'tools' ? roleTools[role] : bundledSkills.map(skill => skill.name);
    if (!Array.isArray(value[field]) || new Set(value[field]).size !== value[field].length ||
      value[field].some(item => !allowed.includes(item))) reject('неверный список ' + field + '.');
  }
}

export function validateWorkflow(value) {
  const reject = message => { throw publicError('Workflow: ' + message); };
  if (!object(value)) reject('ожидается объект.');
  if (Object.keys(value).some(key => !['task', 'taskPackages', 'entry', 'nodes', 'groups', 'transitions', 'merge', 'roles', 'workspace'].includes(key))) reject('неизвестное поле.');
  if (typeof value.task !== 'string' || !value.task.trim()) reject('нужно непустое task.');
  if (!object(value.nodes) || !Object.keys(value.nodes).length) reject('нужны nodes.');
  if (!object(value.transitions)) reject('нужны transitions.');
  if (value.groups !== undefined && !object(value.groups)) reject('groups должен быть объектом.');
  const entries = { ...value.nodes, ...value.groups };
  if (!identifier(value.entry) || !Object.hasOwn(entries, value.entry)) reject('entry должен указывать на участника или группу.');
  if (value.merge !== undefined && typeof value.merge !== 'boolean') reject('merge должен быть boolean.');
  if (value.workspace !== undefined && !['worktree', 'directory'].includes(value.workspace)) reject('неверный workspace.');
  if (value.roles !== undefined) {
    if (!object(value.roles)) reject('roles должен быть объектом.');
    for (const [role, defaults] of Object.entries(value.roles)) {
      if (!Object.hasOwn(outcomes, role) || !object(defaults) ||
        Object.keys(defaults).some(key => !settings.includes(key))) reject('неверные настройки роли.');
      validateSettings(defaults, role, reject);
    }
  }
  for (const [id, node] of Object.entries(value.nodes)) {
    if (!identifier(id) || !object(node) || !Object.hasOwn(outcomes, node.role)) reject('неверный участник ' + id);
    if (Object.keys(node).some(key => !['role', 'instructions', 'required', 'taskId', ...settings].includes(key)) ||
      (node.instructions !== undefined && typeof node.instructions !== 'string')) reject('неверные настройки ' + id);
    validateSettings(node, node.role, reject);
    if (node.required !== undefined && (typeof node.required !== 'boolean' ||
      !['reviewer', 'verifier'].includes(node.role))) reject('required допустим только для проверяющих.');
    if (value.workspace === 'directory' && node.role === 'worker') reject('directory поддерживает только read-only роли.');
  }
  for (const [id, group] of Object.entries(value.groups ?? {})) {
    if (!identifier(id) || Object.hasOwn(value.nodes, id) || !object(group) ||
      Object.keys(group).some(key => !['members', 'required', 'member', 'items', 'itemsFrom'].includes(key))) reject('неверная группа ' + id);
    if (group.members !== undefined) {
      if (!Array.isArray(group.members) || !group.members.length || new Set(group.members).size !== group.members.length ||
        group.members.some(member => !Object.hasOwn(value.nodes, member)) ||
        ['member', 'items', 'itemsFrom'].some(key => group[key] !== undefined)) reject('неверный состав группы ' + id);
      if (group.required !== undefined && (!Array.isArray(group.required) || new Set(group.required).size !== group.required.length ||
        group.required.some(member => !group.members.includes(member)))) reject('неверный обязательный состав группы ' + id);
    } else {
      if (!Object.hasOwn(value.nodes, group.member) || group.required !== undefined ||
        (group.items === undefined) === (group.itemsFrom === undefined)) reject('нужны member и items либо itemsFrom для ' + id);
      if (group.itemsFrom !== undefined && !Object.hasOwn(value.nodes, group.itemsFrom)) reject('неизвестный источник itemsFrom.');
      if (group.items !== undefined) validateItems(group.items);
    }
  }
  for (const id of Object.keys(entries)) {
    const expected = value.nodes[id] ? outcomes[value.nodes[id].role] : groupOutcomes;
    const routes = value.transitions[id];
    const manages = value.nodes[id]?.role === 'orchestrator';
    const canEscalate = ['worker', 'reviewer', 'verifier'].includes(value.nodes[id]?.role);
    if (!object(routes) || Object.keys(routes).some(key => manages
      ? !identifier(key) || key === 'blocked' : !expected.includes(key) && !(canEscalate && key === 'blocked'))) reject('неверные переходы ' + id);
    for (const outcome of expected) {
      if (!Object.hasOwn(routes, outcome)) reject(`нужен переход ${id}.${outcome}`);
    }
    for (const outcome of Object.keys(routes)) {
      if (routes[outcome] !== null && (!identifier(routes[outcome]) || !Object.hasOwn(entries, routes[outcome]))) reject('неизвестный адресат перехода.');
      if (manages && outcome !== 'done' && routes[outcome] === null) reject('Только done orchestrator может завершать workflow.');
      if (outcome === 'blocked' && (routes[outcome] === null || value.nodes[routes[outcome]]?.role !== 'orchestrator')) {
        reject('blocked может передавать препятствие только orchestrator.');
      }
    }
    if (manages && Object.keys(routes).length > 1 && Object.values(value.groups ?? {}).some(group =>
      group.member === id || group.members?.includes(id))) {
      reject('Управляющий orchestrator должен быть отдельным узлом: группа не исполняет переходы участников.');
    }
  }
  if (Object.keys(value.transitions).some(id => !Object.hasOwn(entries, id))) reject('переход от неизвестного участника.');
  const seen = new Set();
  const pending = [value.entry];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...Object.values(value.transitions[id]).filter(next => next !== null));
    const group = value.groups?.[id];
    if (group) pending.push(...(group.members ?? [group.member]));
  }
  if (seen.size !== Object.keys(entries).length) reject('есть недостижимые участники.');
  if (![...seen].some(id => Object.values(value.transitions[id]).includes(null))) reject('нужен завершающий переход null.');
  if (value.merge && value.workspace === 'directory') reject('directory не поддерживает merge.');
  if (value.merge && !['reviewer', 'verifier'].every(role => Object.values(value.nodes).some(node => node.role === role && node.required !== false))) {
    reject('merge требует reviewer и verifier.');
  }
  validateTaskPackages(value);
  validateResearchGraph(value, participantSettings, reject);
  return structuredClone(value);
}

export function validateItems(items) {
  if (!Array.isArray(items) || items.some(item => !object(item) || !identifier(item.id)) ||
    new Set(items.map(item => item.id)).size !== items.length) {
    throw publicError('Группа требует массив items с уникальными идентификаторами id.');
  }
  return items;
}

export function participantVisits(visits) {
  return visits.flatMap(visit => visit.children ?? [visit]);
}

function verdictObjects(text) {
  const objects = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (!depth) {
      if (character === '{') { start = index; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (!depth) {
        try { objects.push({ value: JSON.parse(text.slice(start, index + 1)), start, end: index + 1 }); }
        catch { /* Ordinary prose may contain balanced braces. */ }
      }
    }
  }
  return objects;
}

export function decisionOutcomes(definition, nodeId) {
  const role = definition.nodes[nodeId].role;
  return role === 'orchestrator' ? Object.keys(definition.transitions[nodeId]) : outcomes[role];
}

export function parseVerdict(text, role, allowed = outcomes[role]) {
  const objects = verdictObjects(text);
  if (objects.length !== 1) {
    throw publicError('Участник вернул неверный JSON результата.');
  }
  const { value: result, start, end } = objects[0];
  // Keep literal backticks in JSON strings opaque to Markdown fence handling.
  const json = text.slice(start, end).replaceAll('`', '\\u0060');
  const framed = text.slice(0, start) + json + text.slice(end);
  const unfenced = framed.replace(/```(?:json)?\s*\n([\s\S]*?)```/g, '\n$1\n');
  const normalizedObjects = verdictObjects(unfenced);
  if (normalizedObjects.length !== 1 || unfenced.slice(normalizedObjects[0].end).trim()) {
    throw publicError('Участник вернул неверный JSON результата.');
  }
  if (!object(result) || ![...allowed, 'blocked'].includes(result.outcome) ||
    typeof result.summary !== 'string' || !result.summary.trim()) {
    throw publicError('Результат участника требует допустимый outcome и непустой summary.');
  }
  return result;
}

export const roleTools = {
  worker: ['read', 'glob', 'grep', 'webfetch', 'websearch', 'shell', 'edit', 'write'],
  reviewer: ['read', 'glob', 'grep', 'webfetch', 'websearch'],
  verifier: ['read', 'glob', 'grep', 'webfetch', 'websearch', 'shell'],
  orchestrator: ['read', 'glob', 'grep'], planner: [],
  ...Object.fromEntries(Object.entries(researchRoles).map(([role, config]) => [role, config.tools])),
};

export function rolePermissions(role, config = {}) {
  const actions = config.tools ?? roleTools[role];
  const skills = config.skills === undefined ? roleSkills[role] ?? [] :
    config.skills.map(name => bundledSkills.find(skill => skill.name === name));
  return [{ action: '*', resource: '*', effect: 'deny' },
    ...actions.map(action => ({ action, resource: '*', effect: 'allow' })),
    ...skills.map(skill =>
      ({ action: 'skill', resource: skill.id, effect: 'allow' }))];
}

export function participantSettings(definition, id) {
  const node = definition.nodes[id];
  const research = Object.hasOwn(researchRoles, node.role) ? { model: researchModel, reasoning: 'high' } : {};
  return { memory: node.role !== 'committee', ...research, ...definition.roles?.[node.role], ...node };
}

export function participantAgent(role, config) {
  const agent = { mode: 'primary', system: roleSystemPrompt(role), permissions: rolePermissions(role, config) };
  const id = `dwf-${role}-${createHash('sha256').update(JSON.stringify({ system: agent.system,
    permissions: agent.permissions })).digest('hex').slice(0, 16)}`;
  return { id, agent };
}

export function approvalProblems(state, revision) {
  const required = [];
  const problems = [];
  for (const [id, node] of Object.entries(state.definition.nodes)) {
    if (!['reviewer', 'verifier'].includes(node.role) || node.required === false) continue;
    const maps = Object.entries(state.definition.groups ?? {}).filter(([, group]) => group.member === id);
    for (const [groupId] of maps) {
      const latest = state.visits.findLast(visit => visit.node === groupId);
      if (!latest) { problems.push(`Для завершения нужны результаты ${groupId}.`); continue; }
      for (const child of latest.children) required.push({ id: child.participant, role: node.role,
        visit: participantVisits(state.visits).findLast(visit => visit.participant === child.participant) });
    }
    const ordinary = participantVisits(state.visits).findLast(visit => visit.node === id && !visit.item);
    if (!maps.length || ordinary) required.push({ id, role: node.role, visit: ordinary });
  }
  for (const { id, visit } of required) {
    if (visit?.verdict?.outcome !== 'approve' || visit.revision !== revision) {
      problems.push(`Для завершения нужно одобрение ${id} текущей версии.`);
    }
  }
  if (state.definition.merge && !['reviewer', 'verifier'].every(role => required.some(item => item.role === role))) {
    problems.push('Для merge нужны фактические одобрения reviewer и verifier.');
  }
  return problems;
}

export function checkApprovals(state, revision) {
  const problems = approvalProblems(state, revision);
  if (problems.length) throw publicError(problems[0]);
}

export function workflowCommitTitle(state, revision) {
  const verifier = participantVisits(state.visits).findLast(visit =>
    state.definition.nodes[visit.node]?.role === 'verifier' &&
    state.definition.nodes[visit.node].required !== false &&
    visit.revision === revision && visit.verdict?.outcome === 'approve');
  const title = verifier?.verdict.summary?.trim().split(/[\r\n]/, 1)[0];
  if (/^DWF (feat|fix|refactor|perf|docs|test|build|ci|style|chore|revert)(\([^()]+\))?!?: \S.*$/u.test(title) &&
    !/[\u0000-\u001f\u007f]/u.test(title)) return title;
  // Older saved verdicts have no commit title. Keep them resumable using the task.
  const task = state.definition.task.trim().split(/[\r\n]/, 1)[0].replace(/[\u0000-\u0020\u007f]+/gu, ' ').trim();
  return `DWF chore: ${Array.from(task).slice(0, 100).join('')}`;
}

const commonInstructions = [
  'Execute your configured role. DWF runs the other workflow participants and passes their results to you.',
  'Work within the supplied project workspace. Read applicable AGENTS.md files inside it and any inherited project instructions supplied with the task. Parent directories contain DWF runtime data and are outside the project.',
  'DWF records the workspace snapshot, checks that reviews and verification cover the current files, and manages Git branches and integration. Treat its supplied snapshot identifier as an opaque reference. Leave snapshot calculation and Git index management to DWF.',
  'Distinguish observed facts from assumptions and other participants\' conclusions. Report actions and checks truthfully.',
  'Finish or stop your background commands before reporting completion. Your result is accepted only after your commands have finished.',
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
    'Before asserting a compatibility regression, establish how the baseline behaves on the same input. ' +
      'For behavior controlled by a library, ground the relevant guarantee in available implementation, documentation, or an observed check. ' +
      'Treat exception propagation and continuation after an exception as separate behaviors that each need evidence. ' +
      'If the supplied evidence cannot establish the claimed baseline behavior, pass a specific verification question to the verifier. ' +
      'A necessary verification question may accompany approve only when the supplied workflow context confirms that a required verifier runs immediately next and receives this review. ' +
      'Otherwise return blocked with the missing check if it is necessary to decide correctness. ' +
      'Require changes for an explicit unmet requirement or a defect substantiated by the reviewed code.',
  ].join('\n'),
  verifier: [
    'Independently verify the result against the original requirements. Run the necessary checks and reproduce user scenarios with the available tools. Use temporary data. Preserve project files.',
    'For Git workflows your workspace contains only the transferable candidate files. Install declared dependencies if needed. Base your checks on this workspace and report missing required files.',
    'Base your conclusion on your own checks. Return changes for unmet requirements. Include reproduction steps and the expected and actual results.',
    'Return approve when the checks required by the task succeed. If a necessary check cannot be performed, return blocked.',
    'In summary, state the checks performed, their results and remaining limitations.',
    'When approving a code change for Git integration, begin summary with a concise commit title in the form "DWF <type>: <description>". Describe the complete change being verified with a specific imperative description naming the changed behavior or component.',
    'Use feat for a new feature, fix for a bug fix, refactor for restructuring that preserves behavior, perf for a performance improvement, docs for documentation, test for tests, build for build or dependency changes, ci for automation, style for formatting, chore for other maintenance, and revert for a rollback.',
    'An optional scope and ! for a breaking change follow Conventional Commits, for example "DWF fix(admission): preserve the saved input on retry". Put verification evidence and limitations after a blank line.',
  ].join('\n'),
  orchestrator: [
    'Manage the assigned work through the supplied workflow graph. Choose an outcome from this node\'s configured transitions; DWF executes its target. In summary, give the reason and the target\'s assignment or correction.',
    'Preserve project files. Delegate implementation and checks to the configured participants. DWF owns execution, session reuse and integration; do not launch nested workflows or perform Git integration yourself.',
    'Return done when your assigned stage is complete. If done ends the workflow, the requested work must be complete and the supplied approval requirements satisfied. DWF checks the current revision again before completing or merging. Your decision is not evidence that integration happened.',
    'When configured only with done, complete the assigned report or preparation using the supplied history; the configured target determines whether another stage follows. Return blocked when the available routes cannot resolve missing information or unfinished work.',
  ].join('\n'),
};

function resultInstructions(role) {
  if (role === 'orchestrator') return 'Your final response must be JSON {"outcome":"configured transition name or blocked","summary":"decision reason and next assignment, or final report"}. Choose one outcome value from the supplied transitions, or blocked.';
  return `Your final response must be JSON {"outcome":"${outcomes[role].join('|')}|blocked","summary":"result or specific findings"}. Choose one outcome value.`;
}

export function roleSystemPrompt(role) {
  if (Object.hasOwn(researchRoles, role)) {
    return [researchInstructions, researchRoles[role].system, resultInstructions(role)].join('\n\n');
  }
  return [commonInstructions, roleInstructions[role], resultInstructions(role)].join('\n\n');
}

export const roleAgents = Object.fromEntries(Object.keys(outcomes).map(role => [role,
  `dwf-${role}-${createHash('sha256').update(JSON.stringify({
    system: roleSystemPrompt(role), permissions: rolePermissions(role),
  })).digest('hex').slice(0, 16)}`]));

export function workflowControlContext(definition, nodeId, visits, revision) {
  const routes = definition.transitions?.[nodeId] ?? { done: null };
  return { transitions: routes,
    ...(Object.keys(routes).length > 1 ? {
      nodes: Object.fromEntries(Object.entries(definition.nodes).map(([id, node]) => [id,
        { role: node.role, ...(node.taskId ? { taskId: node.taskId } : {}),
          ...(node.required !== undefined ? { required: node.required } : {}) }])),
      groups: Object.fromEntries(Object.entries(definition.groups ?? {}).map(([id, group]) => [id,
        group.members ? { members: group.members, ...(group.required ? { required: group.required } : {}) } :
          { member: group.member, ...(group.itemsFrom ? { itemsFrom: group.itemsFrom } :
            { items: group.items.map(item => ({ id: item.id, ...(item.taskId ? { taskId: item.taskId } : {}) })) }) }])),
      routes: definition.transitions,
    } : {}),
    approvalProblems: approvalProblems({ definition, visits }, revision) };
}

export function rolePrompt(definition, nodeId, previous, revision, visits = [], separateSystem = false, review, workspace, transitionSource = nodeId, context) {
  const node = definition.nodes[nodeId];
  if (node.role === 'committee') {
    return [
      separateSystem ? '' : roleSystemPrompt(node.role),
      `Original research request\n${definition.task}`,
      `Submitted report\n${previous?.summary ?? ''}`,
    ].filter(Boolean).join('\n\n');
  }
  const research = Object.hasOwn(researchRoles, node.role);
  const nextId = definition.transitions?.[transitionSource]?.approve;
  const nextNode = nextId == null ? undefined : definition.nodes[nextId];
  const verification = nextNode?.role === 'verifier' && nextNode.required !== false
    ? `A required verifier (${nextId}) runs immediately after approve and receives this review.`
    : 'No immediate required verifier is guaranteed after this review. If a missing execution check is necessary to decide correctness, return blocked with that check.';
  const history = node.role === 'orchestrator' ? visits.flatMap((visit, index) => visit.verdict ? [{
    visit: index + 1, node: visit.node, role: definition.nodes[visit.node]?.role ?? 'group',
    sessionId: visit.sessionId, revision: visit.revision, result: visit.verdict,
  }] : []) : undefined;
  return [
    separateSystem ? '' : research ? researchInstructions : commonInstructions,
    separateSystem ? '' : research ? researchRoles[node.role].system : roleInstructions[node.role],
    context ? '' : node.instructions ?? '',
    !context && node.role === 'orchestrator' ? `Workflow control context:\n${JSON.stringify(workflowControlContext(definition, nodeId, visits, revision))}` : '',
    node.role === 'scientist' ? scientistPhase(researchGraph(definition), visits) : '',
    node.role === 'reviewer' ? `Workflow verification context: ${verification}` : '',
    node.role === 'verifier' && definition.merge
      ? 'This workflow will create a Git commit. On approve, the first line of your summary becomes its title. Use DWF <type>: <description>, then a blank line and your verification report.' : '',
    workspace ? `Project workspace: ${workspace.path}` : '',
    workspace?.instructions?.length ? `Inherited project instructions captured at workflow start (outermost first):\n${JSON.stringify(workspace.instructions)}` : '',
    context ? `Task/context data:\n${JSON.stringify(context)}` : `Поручение пользователя:\n${definition.task}`,
    `Workspace snapshot recorded and checked by DWF: ${revision}`,
    review && !context ? `Материалы ревью (полный diff относительно начала задачи, path относительно Project workspace):\n${JSON.stringify({
      ...review, path: workspace ? relative(workspace.path, review.path) : review.path,
    })}` : '',
    context ? '' : history ? `Завершённые этапы workflow (по порядку):\n${JSON.stringify(history)}` :
      previous ? `Предыдущий результат участника:\n${JSON.stringify(previous)}` : '',
    separateSystem ? '' : resultInstructions(node.role),
  ].filter(Boolean).join('\n\n');
}
