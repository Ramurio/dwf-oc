import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { publicError } from './run-store.mjs';
import { roleSkills, bundledSkills } from './role-skills.mjs';

export const outcomes = {
  worker: ['done'], reviewer: ['approve', 'changes'],
  verifier: ['approve', 'changes'], orchestrator: ['done'],
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
  if (Object.keys(value).some(key => !['task', 'entry', 'nodes', 'groups', 'transitions', 'merge', 'roles', 'workspace'].includes(key))) reject('неизвестное поле.');
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
    if (Object.keys(node).some(key => !['role', 'instructions', 'required', ...settings].includes(key)) ||
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
    if (!object(routes) || Object.keys(routes).some(key => !expected.includes(key))) reject('неверные переходы ' + id);
    for (const outcome of expected) {
      if (!Object.hasOwn(routes, outcome)) reject(`нужен переход ${id}.${outcome}`);
      if (routes[outcome] !== null && (!identifier(routes[outcome]) || !Object.hasOwn(entries, routes[outcome]))) reject('неизвестный адресат перехода.');
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
        try { objects.push({ value: JSON.parse(text.slice(start, index + 1)), end: index + 1 }); }
        catch { /* Ordinary prose may contain balanced braces. */ }
      }
    }
  }
  return objects;
}

export function parseVerdict(text, role) {
  const unfenced = text.replace(/```(?:json)?\s*\n([\s\S]*)```/g, '\n$1\n');
  const objects = verdictObjects(unfenced);
  if (objects.length !== 1 || unfenced.slice(objects[0].end).trim()) {
    throw publicError('Участник вернул неверный JSON результата.');
  }
  const result = objects[0].value;
  if (!object(result) || ![...outcomes[role], 'blocked'].includes(result.outcome) ||
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
  return { memory: true, ...definition.roles?.[node.role], ...node };
}

export function participantAgent(role, config) {
  const agent = { mode: 'primary', system: roleSystemPrompt(role), permissions: rolePermissions(role, config) };
  const id = `dwf-${role}-${createHash('sha256').update(JSON.stringify({ system: agent.system,
    permissions: agent.permissions })).digest('hex').slice(0, 16)}`;
  return { id, agent };
}

export function checkApprovals(state, revision) {
  const required = [];
  for (const [id, node] of Object.entries(state.definition.nodes)) {
    if (!['reviewer', 'verifier'].includes(node.role) || node.required === false) continue;
    const maps = Object.entries(state.definition.groups ?? {}).filter(([, group]) => group.member === id);
    for (const [groupId] of maps) {
      const latest = state.visits.findLast(visit => visit.node === groupId);
      if (!latest) throw publicError(`Для завершения нужны результаты ${groupId}.`);
      for (const child of latest.children) required.push({ id: child.participant, role: node.role,
        visit: participantVisits(state.visits).findLast(visit => visit.participant === child.participant) });
    }
    const ordinary = participantVisits(state.visits).findLast(visit => visit.node === id && !visit.item);
    if (!maps.length || ordinary) required.push({ id, role: node.role, visit: ordinary });
  }
  for (const { id, visit } of required) {
    if (visit?.verdict?.outcome !== 'approve' || visit.revision !== revision) {
      throw publicError(`Для завершения нужно одобрение ${id} текущей версии.`);
    }
  }
  if (state.definition.merge && !['reviewer', 'verifier'].every(role => required.some(item => item.role === role))) {
    throw publicError('Для merge нужны фактические одобрения reviewer и verifier.');
  }
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
  ].join('\n'),
  verifier: [
    'Independently verify the result against the original requirements. Run the necessary checks and reproduce user scenarios with the available tools. Use temporary data. Preserve project files.',
    'For Git workflows your workspace contains only the transferable candidate files. Install declared dependencies if needed. Base your checks on this workspace and report missing required files.',
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
    visit: index + 1, node: visit.node, role: definition.nodes[visit.node]?.role ?? 'group',
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
    review ? `Материалы ревью (полный diff относительно начала задачи, path относительно Project workspace):\n${JSON.stringify({
      ...review, path: workspace ? relative(workspace.path, review.path) : review.path,
    })}` : '',
    history ? `Завершённые этапы workflow (по порядку):\n${JSON.stringify(history)}` :
      previous ? `Предыдущий результат участника:\n${JSON.stringify(previous)}` : '',
    separateSystem ? '' : resultInstructions(node.role),
  ].filter(Boolean).join('\n\n');
}
