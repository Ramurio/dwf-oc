import { admissionStage } from './workflow-admission.mjs';
import { publicError } from './run-store.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.isWellFormed() && Boolean(value.trim());
const identifier = value => text(value) && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const reject = message => { throw publicError('Task packages: ' + message); };
function fields(value, allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key));
}
function unique(values) { return new Set(values).size === values.length; }

export function validateTaskReference(definition, taskId) {
  if (taskId !== undefined && (!identifier(taskId) || !definition.taskPackages?.some(task => task.id === taskId))) {
    reject('неизвестная ссылка taskId.');
  }
}

export function validateTaskPackages(definition) {
  const packages = definition.taskPackages;
  if (packages !== undefined) {
    if (!Array.isArray(packages) || !packages.length) reject('нужен непустой массив taskPackages.');
    for (const task of packages) {
      if (!fields(task, ['formatVersion', 'id', 'beadsId', 'requirements', 'acceptanceCriteria', 'dependencies', 'decisions', 'artifacts']) ||
        task.formatVersion !== 1 || !identifier(task.id) || !text(task.requirements) ||
        (task.beadsId !== undefined && !identifier(task.beadsId))) reject('неверный пакет или версия формата.');
      if (!Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.every(text)) reject('acceptanceCriteria должен быть массивом точных строк.');
      if (!Array.isArray(task.dependencies) || !task.dependencies.every(identifier) || !unique(task.dependencies)) reject('неверные dependencies.');
      if (!Array.isArray(task.decisions) || task.decisions.some(decision =>
        !fields(decision, ['id', 'text', 'source']) || !identifier(decision.id) || !text(decision.text) || !text(decision.source)) ||
        !unique(task.decisions.map(decision => decision.id))) reject('неверные decisions или их происхождение.');
      if (!Array.isArray(task.artifacts) || task.artifacts.some(artifact =>
        !fields(artifact, ['id', 'uri']) || !identifier(artifact.id) || !text(artifact.uri)) ||
        !unique(task.artifacts.map(artifact => artifact.id))) reject('неверные artifacts.');
    }
    if (!unique(packages.map(task => task.id)) || !unique(packages.filter(task => task.beadsId !== undefined).map(task => task.beadsId))) {
      reject('повторная идентичность задачи или Beads ID.');
    }
    const remaining = new Map(packages.map(task => [task.id, new Set(task.dependencies)]));
    for (const task of packages) {
      if (task.dependencies.some(id => id === task.id || !remaining.has(id))) reject('неизвестная или собственная зависимость.');
    }
    while (remaining.size) {
      const ready = [...remaining].filter(([, deps]) => !deps.size).map(([id]) => id);
      if (!ready.length) reject('цикл dependencies.');
      for (const id of ready) remaining.delete(id);
      for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
    }
  }
  for (const node of Object.values(definition.nodes ?? {})) validateTaskReference(definition, node?.taskId);
  for (const group of Object.values(definition.groups ?? {})) {
    if (packages !== undefined && Array.isArray(group?.items)) for (const item of group.items) validateTaskReference(definition, item?.taskId);
  }
}

// A visit pins the package version used in its saved input, not the current version.
export function taskBinding(state, nodeId, item) {
  // Legacy group items allowed arbitrary metadata, including a field named taskId.
  const taskId = (state.definition.taskPackages ? item?.taskId : undefined) ?? state.definition.nodes[nodeId]?.taskId;
  validateTaskReference(state.definition, taskId);
  return taskId === undefined ? {} : { taskId,
    taskVersion: 1 + (state.taskRevisions ?? []).filter(revision => revision.taskId === taskId).length };
}

export function taskPackageAt(state, taskId, version) {
  if (taskId === undefined) reject('нужен taskId.');
  validateTaskReference(state.definition, taskId);
  const revisions = (state.taskRevisions ?? []).filter(revision => revision.taskId === taskId);
  const current = 1 + revisions.length;
  version ??= current;
  if (!Number.isSafeInteger(version) || version < 1 || version > current) reject('неизвестная версия пакета.');
  return structuredClone({ ...state.definition.taskPackages.find(task => task.id === taskId), version,
    revisions: revisions.filter(revision => revision.version <= version) });
}

export function validateTaskState(state, saved) {
  if (state.taskRevisions !== undefined && !Array.isArray(state.taskRevisions)) reject('неверный журнал версий.');
  // Enforce saved invariants before considering the legacy no-definition shape.
  if (saved) {
    if (JSON.stringify(saved.definition?.taskPackages) !== JSON.stringify(state.definition?.taskPackages) ||
      (saved.definition?.taskPackages && JSON.stringify(saved.definition) !== JSON.stringify(state.definition))) reject('исходный снимок неизменяем.');
    if (JSON.stringify(saved.inputSnapshot) !== JSON.stringify(state.inputSnapshot)) reject('исходный ввод неизменяем.');
    const before = saved.taskRevisions ?? [];
    if (JSON.stringify((state.taskRevisions ?? []).slice(0, before.length)) !== JSON.stringify(before)) reject('история версий неизменяема.');
    if (saved.definition) {
      const inputs = workflow => (workflow.visits ?? []).flatMap(group =>
        (group.children ?? [group]).map(visit => ({ visit, group })));
      const current = new Map(inputs(state).map(input => [input.visit.inputId, input]));
      for (const { visit, group } of inputs(saved)) {
        if (admissionStage(visit, group) === 'prepared') continue;
        const nextInput = current.get(visit.inputId);
        const next = nextInput?.visit;
        if (!saved.definition.taskPackages && visit.taskContext === undefined && next?.taskContext === undefined) continue;
        if (!next || admissionStage(next, nextInput.group) === 'prepared' || next.inputId !== visit.inputId || next.taskId !== visit.taskId || next.taskVersion !== visit.taskVersion ||
          ((visit.taskContext !== undefined || next.taskContext !== undefined) && (JSON.stringify(next.taskContext) !== JSON.stringify(visit.taskContext) ||
            next.prompt !== visit.prompt || next.contextDirectory !== visit.contextDirectory))) {
          reject('привязка замороженного ввода неизменяема.');
        }
      }
    }
  }
  // Some early store records have no graph definition at all.
  if (!state.definition) {
    if (state.taskRevisions !== undefined || saved?.definition) reject('отсутствует сохранённое определение.');
    return;
  }
  validateTaskPackages(state.definition);
  const versions = new Map((state.definition.taskPackages ?? []).map(task => [task.id, 1]));
  for (const revision of state.taskRevisions ?? []) {
    if (!fields(revision, ['taskId', 'version', 'kind', 'text', 'source', 'createdAt']) ||
      !versions.has(revision.taskId) || revision.version !== versions.get(revision.taskId) + 1 ||
      !['clarification', 'decision'].includes(revision.kind) || !text(revision.text) || !text(revision.source) ||
      !Number.isSafeInteger(revision.createdAt) || revision.createdAt < 0) reject('неверная версия или происхождение уточнения.');
    versions.set(revision.taskId, revision.version);
  }
  for (const visit of (state.visits ?? []).flatMap(visit => visit.children ?? [visit])) {
    const expected = taskBinding(state, visit.node, visit.item).taskId;
    if (visit.taskId !== expected || (expected !== undefined &&
      (!Number.isSafeInteger(visit.taskVersion) || visit.taskVersion < 1 || visit.taskVersion > versions.get(expected))) ||
      (expected === undefined && visit.taskVersion !== undefined)) reject('посещение связано с неверной задачей или версией.');
  }
}

export function recordTaskSteering(state, command, kind = 'clarification') {
  const visits = (state.visits ?? []).flatMap(visit => visit.children ?? [visit]);
  const visit = visits.findLast(visit => visit.participant === command.node);
  const [implementId, implementRole] = command.node.split('/');
  const implement = Object.hasOwn(state.definition.implements?.instances ?? {}, implementId) && state.definition.implements.instances[implementId];
  const node = implement ? implement[implementRole ?? 'worker'] : Object.hasOwn(state.definition.nodes, command.node) ? command.node : visit?.node;
  const binding = taskBinding(state, node, implement ? { taskId: implement.taskId } : visit?.item);
  if (!binding.taskId) return;
  state.taskRevisions ??= [];
  state.taskRevisions.push({ taskId: binding.taskId, version: binding.taskVersion + 1,
    kind, text: command.text, source: `steer:${command.id}`, createdAt: command.createdAt });
  command.taskId = binding.taskId;
  command.taskVersion = binding.taskVersion + 1;
}
