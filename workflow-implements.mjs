import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { implementRoles } from './implement-definition.mjs';
import { taskBinding } from './task-packages.mjs';
import { admissionStage } from './workflow-admission.mjs';
import { prepareRoleInput } from './role-context.mjs';
import { git, snapshot, verificationWorkspace, writeReviewDiff } from './workflow-git.mjs';
import { publicError } from './run-store.mjs';

const fail = message => { throw publicError('Implement: ' + message); };
export const controlVisit = state => state.visits.findLast(visit => !visit.implementId);
const visitsOf = (state, id) => state.visits.filter(visit => visit.implementId === id);
export const implementObservation = state => Object.fromEntries(Object.values(state.implements?.instances ?? {}).map(instance =>
  [instance.id, { status: instance.status, resultVersion: instance.resultVersion, currentInputId: instance.currentInputId }]));
const conflictOf = instance => instance.refresh?.status === 'conflict' ? instance.refresh :
  instance.integration?.status === 'conflict' ? instance.integration : undefined;
const currentOf = (state, instance) => state.visits.find(visit => visit.inputId === instance.currentInputId);
const emit = (state, instance, type, details = {}) => state.implements.events.push({
  sequence: state.implements.events.length + 1, implementId: instance.id, taskId: instance.taskId,
  type, ...details, createdAt: Date.now(),
});

export function initializeImplements(state) {
  if (!state.definition.implements || state.implements) return;
  state.implements = { events: [], instances: Object.fromEntries(Object.entries(state.definition.implements.instances)
    .map(([id, config]) => [id, { id, taskId: config.taskId, status: 'pending' }])) };
}

export function implementTarget(state, target) {
  if (!state.definition.implements || typeof target !== 'string') return;
  const [id, role, extra] = (target ?? '').split('/');
  if (!Object.hasOwn(state.definition.implements.instances, id) || extra !== undefined || (role !== undefined && !implementRoles.includes(role))) return;
  return { id, role: role ?? 'worker' };
}

export function publicImplements(state) {
  if (!state.definition.implements) return;
  const instances = state.implements?.instances ?? {};
  return { concurrency: state.definition.implements.concurrency,
    instances: Object.entries(state.definition.implements.instances).map(([id, config]) => {
      const instance = instances[id] ?? { id, taskId: config.taskId, status: 'pending' };
      const task = state.definition.taskPackages.find(task => task.id === instance.taskId);
      const dependencies = task.dependencies;
      const waitingFor = dependencies.filter(taskId => !Object.values(instances).some(item => item.taskId === taskId && item.status === 'integrated'));
      const current = currentOf(state, instance);
      return { ...instance, ...(task.title ? { title: task.title } : {}), ...(task.beadsId ? { beadsId: task.beadsId } : {}), dependencies,
        ...(instance.status === 'pending' ? { waitingReason: 'assignment' } :
          instance.status === 'queued' ? { waitingReason: waitingFor.length ? 'dependencies' : 'concurrency', waitingFor } :
          ['ready', 'changes_requested', 'blocked', 'conflict', 'stale'].includes(instance.status) ? { waitingReason: 'controller' } : {}),
        ...(state.status === 'cancelled' ? { executionStatus: 'cancelled' } : state.executionStopped ? { executionStatus: 'stopped' } : {}),
        participants: implementRoles.map(role => ({ role, node: config[role], participant: `${id}/${role}`,
          sessionId: state.sessions[`${id}/${role}`] ?? visitsOf(state, id).findLast(visit => visit.node === config[role])?.sessionId })),
        ...(current ? { current: { role: state.definition.nodes[current.node].role, inputId: current.inputId,
          sessionId: current.sessionId, status: admissionStage(current),
          ...(current.progress ? { progress: current.progress } : {}) } } : {}),
        results: visitsOf(state, id).filter(visit => visit.verdict || visit.error).map(visit => ({
          inputId: visit.inputId, participant: visit.participant, revision: visit.revision,
          taskId: visit.taskId, taskVersion: visit.taskVersion, result: visit.verdict, error: visit.error,
        })),
      };
    }), events: state.implements?.events ?? [] };
}

export function implementContext(state, instance, previous) {
  if (!instance) return state.implements ? { implements: publicImplements(state) } : {};
  return { implement: { id: instance.id, taskId: instance.taskId, cycle: instance.cycle, assignment: instance.assignment, controllerInputId: instance.controllerInputId,
    dependencies: state.definition.taskPackages.find(task => task.id === instance.taskId).dependencies.map(taskId => {
      const dependency = Object.values(state.implements.instances).find(item => item.taskId === taskId);
      return { taskId, id: dependency.id, revision: dependency.integratedRevision, resultVersion: dependency.resultVersion, result: dependency.result };
    }), candidateRevision: instance.candidateRevision,
    ...(conflictOf(instance) ? { conflict: conflictOf(instance) } : {}) } };
}

function dependencyResults(state, instance) {
  const dependencies = state.definition.taskPackages.find(task => task.id === instance.taskId).dependencies;
  return Object.fromEntries(dependencies.map(taskId => [taskId,
    Object.values(state.implements.instances).find(item => item.taskId === taskId).resultVersion]));
}
function dependencyProblems(state, instance) {
  const expected = dependencyResults(state, instance);
  return Object.entries(expected).flatMap(([taskId, version]) => {
    const dependency = Object.values(state.implements.instances).find(item => item.taskId === taskId);
    return !instance.dependencyInvalidated && dependency.status === 'integrated' && instance.dependencyResults?.[taskId] === version ? [] :
      [`Implement ${instance.id} требует актуальный объединённый результат зависимости ${taskId}.`];
  });
}
function reopenImplement(state, instance) {
  instance.refreshCandidate = true;
  // Propagate invalidation, not termination: active native inputs finish in their
  // own sessions and then report invalidated instead of advancing their cycle.
  const changed = new Set([instance.taskId]);
  for (let size = 0; size !== changed.size;) {
    size = changed.size;
    for (const dependent of Object.values(state.implements.instances)) {
      if (changed.has(dependent.taskId)) continue;
      const dependencies = state.definition.taskPackages.find(task => task.id === dependent.taskId).dependencies;
      if (!dependencies.some(taskId => changed.has(taskId))) continue;
      changed.add(dependent.taskId);
      if (!dependent.workspace) continue;
      dependent.refreshCandidate = true;
      dependent.dependencyInvalidated = true;
      if (!['running', 'queued'].includes(dependent.status)) {
        dependent.status = 'changes_requested';
        emit(state, dependent, 'invalidated', { problems: dependencyProblems(state, dependent) });
      }
    }
  }
}

function refreshImplementCandidate(root, state, instance) {
  const operation = instance.refresh;
  // A revision after integration (or after a dependency changed) starts from a
  // current combined snapshot and reapplies only still-unintegrated local edits.
  // Both old candidate and scratch result are retained, including conflicts.
  operation.candidateWorkspace = ensureWorkspace(root, state, instance.workspace, operation.candidateRevision, operation.id + '_candidate');
  operation.workspace = ensureWorkspace(root, state, state.workspace, operation.baseRevision, operation.id);
  git(operation.workspace.path, ['read-tree', '--reset', '-u', operation.baseRevision]);
  git(operation.workspace.path, ['clean', '-fd']);
  operation.patch = writeReviewDiff({ ...instance.workspace, base: operation.patchBase }, operation.candidateRevision,
    join(root, 'workflows', state.id, 'implements', `${operation.id}.diff`));
  try {
    if (operation.patch.bytes) git(operation.workspace.path, ['apply', '--3way', '--index', operation.patch.path]);
    operation.status = 'refreshed';
  } catch (error) {
    operation.status = 'conflict';
    operation.error = error.publicMessage;
    operation.conflicts = git(operation.workspace.path, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  }
  operation.resultRevision = snapshot(operation.workspace);
  const current = snapshot(instance.workspace);
  if (snapshot(state.workspace) !== operation.baseRevision ||
    snapshot(operation.candidateWorkspace) !== operation.candidateRevision ||
    (current !== operation.candidateRevision && current !== operation.resultRevision)) fail('кандидат или база обновления изменились после подготовки операции.');
  if (current !== operation.resultRevision) {
    git(instance.workspace.path, ['read-tree', '--reset', '-u', operation.candidateRevision]);
    git(instance.workspace.path, ['read-tree', '--reset', '-u', operation.resultRevision]);
  }
  if (snapshot(instance.workspace) !== operation.resultRevision) fail('обновлённый кандидат не соответствует операции.');
  instance.workspace.base = operation.baseRevision;
  instance.baseRevision = operation.baseRevision;
  instance.patchBase = operation.baseRevision;
  instance.dependencyResults = operation.dependencyResults;
  delete instance.dependencyInvalidated;
  instance.refreshCandidate = false;
  // This refresh rebases all unintegrated edits (including conflict resolution)
  // onto the current combined tree. The old integration scratch is only audit
  // evidence now: installing it would restore the old dependency files while
  // leaving dependencyResults at the new versions. Retire it in this same
  // replayable transaction, keeping every original workspace and patch.
  if (instance.integration?.status === 'conflict') {
    instance.integration.status = 'superseded';
    instance.integration.supersededBy = operation.id;
    instance.conflictHistory ??= [];
    instance.conflictHistory.push(structuredClone(instance.integration));
  }
  instance.refreshHistory ??= [];
  instance.refreshHistory.push(structuredClone(operation));
}

// Validate the whole decision before recording any operation. Replaying a saved
// controller verdict is harmless; operations are keyed by that input ID.
export function applyImplementDecision(state, visit) {
  if (visit.implementDecisionApplied) return;
  const actions = visit.verdict.implements ?? [];
  if (!Array.isArray(actions)) fail('результат orchestrator требует массив implements.');
  const seen = new Set();
  const stale = [];
  const requireStatus = (instance, allowed, message) => {
    if (allowed.includes(instance.status)) return;
    if (visit.implementObserved && JSON.stringify(visit.implementObserved[instance.id]) !== JSON.stringify(implementObservation(state)[instance.id])) {
      stale.push({ instance, message });
    } else fail(message);
  };
  for (const action of actions) {
    const instance = state.implements.instances[action?.id];
    if (!action || typeof action !== 'object' || seen.has(action.id) || !instance ||
      !['admit', 'revise', 'integrate'].includes(action.action) ||
      Object.keys(action).some(key => !['id', 'action', 'assignment'].includes(key))) fail('неверное или повторное действие orchestrator.');
    seen.add(action.id);
    if (action.action === 'admit') requireStatus(instance, ['pending'], 'повторный допуск ' + action.id);
    if (action.action === 'revise') requireStatus(instance, ['ready', 'changes_requested', 'blocked', 'conflict', 'stale', 'integrated'], 'экземпляр не ожидает доработки ' + action.id);
    if (action.action !== 'integrate' && (typeof action.assignment !== 'string' || !action.assignment.trim())) fail('нужно конкретное поручение ' + action.id);
    if (action.action === 'integrate') {
      if (action.assignment !== undefined) fail('integrate не принимает assignment.');
      requireStatus(instance, ['ready'], 'объединение требует готовый результат ' + action.id);
    }
  }
  if (stale.length) {
    for (const { instance, message } of stale) emit(state, instance, 'decision_rejected', {
      reason: message, controllerInputId: visit.inputId, observed: visit.implementObserved[instance.id], current: implementObservation(state)[instance.id],
    });
    visit.implementDecisionApplied = true;
    return; // no partial actions from an obsolete control snapshot
  }
  for (const action of actions) {
    const instance = state.implements.instances[action.id];
    if (action.action === 'integrate') {
      instance.integration = { id: 'integration_' + randomUUID(), status: 'prepared', controllerInputId: visit.inputId,
        candidateRevision: instance.candidateRevision,
        candidateWorkspace: visitsOf(state, instance.id).findLast(visit => visit.node === state.definition.implements.instances[instance.id].verifier)?.workspace };
      instance.status = 'integrating';
    } else {
      if (instance.status === 'integrated') reopenImplement(state, instance);
      instance.assignment = action.assignment;
      instance.status = 'queued';
      instance.nextRole = 'worker';
      instance.controllerInputId = visit.inputId;
      delete instance.assignmentSteeringId;
    }
  }
  visit.implementDecisionApplied = true;
}

function ensureWorkspace(root, state, workspace, revision, id) {
  const path = join(root, 'workflows', state.id, 'verification', id);
  if (existsSync(path)) {
    if (git(path, ['rev-parse', 'HEAD^{tree}']) !== revision) fail('сохранённое дерево операции не соответствует исходному снимку.');
    return { ...workspace, path };
  }
  return verificationWorkspace(root, state.id, workspace, revision, id);
}

function prepareVisit(root, state, instance, role, previous) {
  const config = state.definition.implements.instances[instance.id];
  const node = config[role];
  const participant = `${instance.id}/${role}`;
  const inputId = 'msg_' + randomUUID();
  const revision = snapshot(instance.workspace);
  const workspace = role === 'verifier' ? verificationWorkspace(root, state.id, instance.workspace, revision, inputId) : instance.workspace;
  const review = role === 'reviewer' ? writeReviewDiff(instance.workspace, revision,
    join(root, 'workflows', state.id, 'reviews', `${inputId}.diff`)) : undefined;
  const item = { id: instance.id, taskId: instance.taskId };
  const visit = { node, participant, implementId: instance.id, item, ...taskBinding(state, node, item),
    inputId, sessionId: state.sessions[participant] ?? 'ses_' + randomUUID(), revision, startedAt: Date.now(),
    admissionStarted: false, workspace, ...(review ? { review } : {}),
    ...(conflictOf(instance) ? { contextDirectories: [conflictOf(instance).workspace.path,
      conflictOf(instance).candidateWorkspace.path,
      ...(conflictOf(instance).resolution ? [conflictOf(instance).resolution.candidateWorkspace.path,
        conflictOf(instance).resolution.conflictWorkspace.path] : []),
      join(root, 'workflows', state.id, 'implements')] } : {}), };
  const steering = state.controls?.find(command => command.id === instance.assignmentSteeringId);
  prepareRoleInput(root, state, visit, previous, workspace, role === 'reviewer' ? node : undefined, steering,
    { ...implementContext(state, instance), handoffInputId: instance.resultInputId });
  instance.currentInputId = inputId;
  instance.phase = role;
  state.visits.push(visit);
  return visit;
}

export function candidateApprovalProblems(state, instance) {
  const revision = snapshot(instance.workspace);
  const config = state.definition.implements.instances[instance.id];
  const version = taskBinding(state, config.worker, { taskId: instance.taskId }).taskVersion;
  return [...dependencyProblems(state, instance), ...implementRoles.flatMap(role => {
    const visit = visitsOf(state, instance.id).findLast(visit => visit.node === config[role]);
    return visit?.verdict?.outcome === (role === 'worker' ? 'done' : 'approve') && visit.revision === revision && visit.taskVersion === version ? [] :
      [`Implement ${instance.id} требует ${role === 'worker' ? 'результат' : 'одобрение'} ${role} текущего кандидата.`];
  })];
}

export function checkImplementCandidates(state) {
  for (const instance of Object.values(state.implements?.instances ?? {})) {
    if (instance.status === 'integrated') {
      const problem = candidateApprovalProblems(state, instance)[0];
      if (problem) fail(problem);
    }
  }
}

// Called inside the controller's ownership transaction. Git operations carry a
// persisted ID and are replayable before the next external admission.
export function integrateImplement(root, state, instance) {
  const operation = instance.integration;
  const problems = candidateApprovalProblems(state, instance);
  if (problems.length || snapshot(instance.workspace) !== operation.candidateRevision) {
    instance.status = 'changes_requested';
    operation.status = 'stale';
    emit(state, instance, 'invalidated', { problems });
    return;
  }
  if (!operation.baseRevision) fail('операция объединения не подготовлена и не сохранена.');
  const combined = ensureWorkspace(root, state, state.workspace, operation.baseRevision, operation.id);
  if (!operation.resultRevision) {
    // No participant can see this scratch tree until conflict is durably saved.
    // A crash after apply resets/replays only this private scratch tree.
    git(combined.path, ['read-tree', '--reset', '-u', operation.baseRevision]);
    git(combined.path, ['clean', '-fd']);
    const patch = writeReviewDiff(instance.workspace, operation.candidateRevision,
      join(root, 'workflows', state.id, 'implements', `${operation.id}.diff`));
    operation.patch = patch;
    try {
      if (patch.bytes) git(combined.path, ['apply', '--3way', '--index', patch.path]);
      operation.resultRevision = snapshot(combined);
    } catch (error) {
      operation.status = 'conflict';
      operation.error = error.publicMessage;
      operation.conflicts = git(combined.path, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      instance.status = 'conflict';
      emit(state, instance, 'conflict', { operation: structuredClone(operation) });
      return;
    }
  }
  const current = snapshot(state.workspace);
  if (current !== operation.baseRevision && current !== operation.resultRevision) fail('общий кандидат изменился во время объединения.');
  if (current !== operation.resultRevision) {
    git(state.workspace.path, ['read-tree', '--reset', '-u', operation.baseRevision]);
    git(state.workspace.path, ['read-tree', '--reset', '-u', operation.resultRevision]);
  }
  if (snapshot(state.workspace) !== operation.resultRevision) fail('объединённый кандидат не соответствует операции.');
  operation.status = 'integrated';
  instance.status = 'integrated';
  instance.integratedRevision = operation.resultRevision;
  instance.appliedRevision = operation.candidateRevision;
  instance.patchBase = operation.candidateRevision;
  instance.resultVersion = (instance.resultVersion ?? 0) + 1;
  instance.integrations ??= [];
  instance.integrations.push(structuredClone(operation));
  emit(state, instance, 'integrated', { revision: operation.resultRevision, operationId: operation.id, resultVersion: instance.resultVersion });
}

function resumeConflict(root, state, instance) {
  const operation = instance.integration;
  if (operation?.status !== 'conflict' || operation.resolutionStarted) return true;
  if (!operation.resolution) {
    // This tick preserves and pins both originals, then COMMITs the replacement
    // intent. Never reset the worker directory inside this preparation tick.
    const id = 'resolution_' + randomUUID();
    const candidateRevision = snapshot(instance.workspace);
    const conflictRevision = snapshot(operation.workspace);
    operation.resolution = { id, status: 'prepared', candidateRevision, conflictRevision,
      combinedRevision: snapshot(state.workspace),
      candidateWorkspace: ensureWorkspace(root, state, instance.workspace, candidateRevision, id + '_candidate'),
      conflictWorkspace: ensureWorkspace(root, state, operation.workspace, conflictRevision, id + '_conflict') };
    return false;
  }
  const intent = operation.resolution;
  // SQLite rollback does not roll Git back. After a crash the worker tree may
  // be either the preserved original or the intended replacement, never a new
  // snapshot to silently relabel as the original. Reject unexpected late edits.
  if (snapshot(state.workspace) !== intent.combinedRevision ||
    snapshot(operation.workspace) !== intent.conflictRevision ||
    snapshot(intent.candidateWorkspace) !== intent.candidateRevision ||
    snapshot(intent.conflictWorkspace) !== intent.conflictRevision) fail('деревья операции разрешения конфликта изменились.');
  const current = snapshot(instance.workspace);
  if (current !== intent.candidateRevision && current !== intent.conflictRevision) fail('рабочий кандидат изменился после подготовки разрешения конфликта.');
  if (current !== intent.conflictRevision) {
    // Track all preserved files first so the next reset also removes files that
    // were untracked in the original index. Their bytes remain in the pinned copy.
    git(instance.workspace.path, ['read-tree', '--reset', '-u', intent.candidateRevision]);
    git(instance.workspace.path, ['read-tree', '--reset', '-u', intent.conflictRevision]);
  }
  if (snapshot(instance.workspace) !== intent.conflictRevision) fail('рабочий кандидат не соответствует разрешаемому конфликту.');
  instance.candidateRevision = intent.conflictRevision;
  instance.workspace.base = operation.baseRevision;
  instance.baseRevision = operation.baseRevision;
  instance.patchBase = operation.baseRevision;
  intent.status = 'replaced';
  operation.resolutionStarted = true;
  instance.conflictHistory ??= [];
  instance.conflictHistory.push(structuredClone(operation));
  return true;
}

export function advanceImplementState(root, state) {
  if (!state.implements) return;
  // Prepared candidate replacements pin the common tree too. Finish them in a
  // transaction with no common-tree write, even if native admission is waiting
  // for dependencies or a cycle slot. Otherwise our own independent integration
  // invalidates their intent, and a crash cannot replay the replacement safely.
  let replacementTick = false;
  for (const instance of Object.values(state.implements.instances)) {
    if (instance.status !== 'queued') continue;
    if (instance.refreshCandidate && instance.refresh?.status === 'prepared') {
      replacementTick = true;
      const waitingForDependency = Object.keys(instance.refresh.dependencyResults).some(taskId =>
        !Object.values(state.implements.instances).some(dependency => dependency.taskId === taskId && dependency.status === 'integrated'));
      if (waitingForDependency || JSON.stringify(instance.refresh.dependencyResults) !== JSON.stringify(dependencyResults(state, instance))) {
        instance.refresh.status = 'superseded';
      } else refreshImplementCandidate(root, state, instance);
    }
    if (instance.integration?.status === 'conflict' && !instance.integration.resolutionStarted && instance.integration.resolution) {
      replacementTick = true;
      resumeConflict(root, state, instance);
    }
  }
  const integrating = Object.values(state.implements.instances).find(instance => instance.status === 'integrating');
  if (integrating && !replacementTick) {
    const operation = integrating.integration;
    if (!operation.baseRevision) {
      // Persist the expected parent and operation path in one tick BEFORE any
      // apply/read-tree side effect. Other integrations wait for this operation.
      operation.baseRevision = snapshot(state.workspace);
      operation.workspace = { ...state.workspace,
        path: join(root, 'workflows', state.id, 'verification', operation.id), base: operation.baseRevision };
    } else integrateImplement(root, state, integrating);
  }
  for (const instance of Object.values(state.implements.instances)) {
    const current = currentOf(state, instance);
    if (instance.status === 'running' && current && admissionStage(current) === 'finished' && !current.implementHandled) {
      current.implementHandled = true;
      instance.resultInputId = current.inputId;
      instance.result = current.verdict ?? { outcome: 'blocked', summary: current.error };
      if (current.error || current.verdict.outcome === 'blocked' || current.verdict.outcome === 'changes') {
        instance.status = current.verdict?.outcome === 'changes' ? 'changes_requested' : 'blocked';
        emit(state, instance, current.verdict?.outcome === 'changes' ? 'changes' : 'blocked', { result: instance.result, participant: current.participant });
        if (!current.error && current.verdict.outcome === 'changes' && ['reviewer', 'verifier'].includes(instance.phase) &&
          !dependencyProblems(state, instance).length && !state.controls?.some(command =>
            command.kind === 'steer' && command.status === 'pending' && implementTarget(state, command.node)?.id === instance.id)) {
          // Corrections belong to this cycle, not a new manager assignment. Keep
          // its concurrency slot and original worker session, including findings.
          instance.status = 'running';
          instance.cycle = (instance.cycle ?? 0) + 1;
          prepareVisit(root, state, instance, 'worker', current.verdict);
        }
      } else if (dependencyProblems(state, instance).length) {
        instance.status = 'changes_requested';
        instance.refreshCandidate = true;
        emit(state, instance, 'invalidated', { problems: dependencyProblems(state, instance) });
      } else if (state.controls?.some(command => command.kind === 'steer' && command.status === 'pending' && implementTarget(state, command.node)?.id === instance.id)) {
        instance.status = 'changes_requested';
      } else if (instance.phase === 'worker') {
        instance.candidateRevision = current.revision;
        prepareVisit(root, state, instance, 'reviewer', current.verdict);
      } else if (instance.phase === 'reviewer') {
        prepareVisit(root, state, instance, 'verifier', current.verdict);
      } else {
        const problems = candidateApprovalProblems(state, instance);
        instance.status = problems.length ? 'changes_requested' : 'ready';
        instance.candidateRevision = snapshot(instance.workspace);
        emit(state, instance, problems.length ? 'invalidated' : 'ready', { revision: instance.candidateRevision, result: instance.result, problems });
      }
    }
  }
  // Apply addressed controls only after the previous native input has finished.
  const dispatched = new Set();
  for (const command of state.controls ?? []) {
    const target = command.kind === 'steer' && command.status === 'pending' && implementTarget(state, command.node);
    if (!target || dispatched.has(target.id)) continue;
    const instance = state.implements.instances[target.id];
    const current = currentOf(state, instance);
    if (instance.status === 'integrated') reopenImplement(state, instance);
    if (instance.steering || (instance.status === 'running' && current && admissionStage(current) !== 'finished')) continue;
    dispatched.add(target.id);
    instance.assignment = command.text;
    instance.assignmentSteeringId = command.id;
    delete instance.controllerInputId;
    instance.nextRole = target.role;
    instance.status = 'queued';
    instance.steering = command.id;
    command.status = 'delivered';
  }
  let running = Object.values(state.implements.instances).filter(instance => instance.status === 'running').length;
  for (const instance of Object.values(state.implements.instances)) {
    if (instance.status !== 'queued' || running >= state.definition.implements.concurrency) continue;
    const dependencies = state.definition.taskPackages.find(task => task.id === instance.taskId).dependencies;
    if (dependencies.some(taskId => !Object.values(state.implements.instances).some(item => item.taskId === taskId && item.status === 'integrated'))) continue;
    if (!instance.workspace) {
      instance.baseRevision = snapshot(state.workspace);
      instance.dependencyResults = dependencyResults(state, instance);
      instance.workspace = { ...ensureWorkspace(root, state, state.workspace, instance.baseRevision, 'implement_' + instance.id), base: instance.baseRevision };
    }
    if (instance.refreshCandidate) {
      if (!instance.refresh || !['prepared'].includes(instance.refresh.status)) {
        const id = 'refresh_' + randomUUID();
        instance.refresh = { id, status: 'prepared', baseRevision: snapshot(state.workspace),
          candidateRevision: snapshot(instance.workspace), patchBase: instance.patchBase ?? instance.workspace.base,
          dependencyResults: dependencyResults(state, instance) };
      }
      continue; // only the replacement phase at the start of a later tick may apply it
    }
    if (instance.integration?.status === 'conflict' && !instance.integration.resolutionStarted) {
      if (!instance.integration.resolution) resumeConflict(root, state, instance);
      continue; // commit the intent before any candidate reset
    }
    if ((instance.nextRole ?? 'worker') === 'worker') instance.cycle = (instance.cycle ?? 0) + 1;
    const visit = prepareVisit(root, state, instance, instance.nextRole ?? 'worker', instance.result);
    if (instance.steering) { visit.steering = instance.steering; delete instance.steering; }
    instance.status = 'running';
    delete instance.nextRole;
    running++;
  }
}

// Drift during a stopped run is a new candidate, never an approval of the old
// worker result under a new revision. Preserve all reports and notify manager.
export function invalidateForContinuation(state, instance) {
  if (instance.status === 'integrated') reopenImplement(state, instance);
  instance.status = 'queued';
  instance.nextRole = 'worker';
  emit(state, instance, 'invalidated', { reason: 'Candidate files changed while execution was stopped; fresh worker/checking results are required.' });
}
