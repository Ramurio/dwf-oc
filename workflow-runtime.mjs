import { checkContinuationAdmission } from './workflow-continuation.mjs';
import { initializeImplements, publicImplements, controlVisit, implementTarget, implementContext, implementObservation,
  applyImplementDecision, advanceImplementState, checkImplementCandidates } from './workflow-implements.mjs';
import { acknowledgeContext } from './context-delivery.mjs';
import { prepareRoleInput } from './role-context.mjs';
import { taskBinding } from './task-packages.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { admit, checkRoleAgents, connect, readExecution, stopSessions, captureStopSessions, interruptSessions } from './opencode-runtime.mjs';
import { claimWorkflow, getWorkflow, updateWorkflow, workflowHasOwner, publicError, withWorkflowAction } from './run-store.mjs';
import { parseVerdict, rolePermissions, roleAgents, checkApprovals, workflowCommitTitle,
  participantVisits, validateItems, decisionOutcomes } from './workflow-definition.mjs';
import { researchGraph, researchResult, scientistPhase, validateScientistVerdict } from './research-workflow.mjs';
import { mergeWorkspace, snapshot, writeReviewDiff, verificationWorkspace } from './workflow-git.mjs';
import { prepareGroup, groupVerdict, integrateGroup } from './workflow-groups.mjs';
import { admissionStage } from './workflow-admission.mjs';

export function publicWorkflow(state) {
  const current = controlVisit(state);
  let result = state.result;
  if (state.status === 'succeeded' && result?.commit) {
    result = { ...result,
      integration: { status: 'merged', branch: state.workspace.branch, commit: result.commit },
      summary: `DWF подтвердил локальный merge в ${state.workspace.branch}. Коммит ${result.commit}.\n\nОтчёт участника до интеграции\n${result.summary}` };
  }
  return { runId: state.id, status: state.status, workspace: state.workspace.path,
    ...(state.definition.implements ? { implements: publicImplements(state) } : {}),
    ...(state.definition.taskPackages ? { taskPackages: state.definition.taskPackages, taskRevisions: state.taskRevisions ?? [] } : {}),
    current: current && { node: current.node, role: current.kind === 'implements' ? 'implements' : state.definition.nodes[current.node]?.role ?? 'group',
      sessionId: current.sessionId, inputId: current.inputId,
      ...(current.kind !== 'implements' ? { admission: admissionStage(current) } : {}),
      ...(current.recoveryOf ? { recoveryOf: current.recoveryOf, recoveryId: current.recoveryId } : {}), visit: state.visits.indexOf(current) + 1,
      ...(current.kind === 'implements' && !current.verdict && state.status === 'running' ? { waitingReason: 'implement_events', eventCursor: current.eventCursor } : {}),
      ...(current.taskId ? { taskId: current.taskId, taskVersion: current.taskVersion } : {}),
      ...(current.participant ? { participant: current.participant } : {}),
      ...(current.children ? { members: current.children.map(child => ({ participant: child.participant, node: child.node,
        sessionId: child.sessionId, inputId: child.inputId, ...taskIdentity(child),
        ...(child.recoveryOf ? { recoveryOf: child.recoveryOf } : {}),
        ...(child.recoveredBy ? { recoveredBy: child.recoveredBy } : {}), status: child.error ? 'failed' : child.verdict ? 'completed' : 'running',
        ...(child.progress ? { progress: child.progress } : {}) })) } : {}),
      ...(current.startedAt ? { startedAt: current.startedAt } : {}),
      ...(current.progress ? { progress: current.progress } : {}) },
    history: state.visits.map(visit => ({ node: visit.node, inputId: visit.inputId, sessionId: visit.sessionId, ...taskIdentity(visit),
      ...(visit.recoveryOf ? { recoveryOf: visit.recoveryOf } : {}),
      ...(visit.recoveredBy ? { recoveredBy: visit.recoveredBy } : {}),
      ...(visit.execution ? { execution: visit.execution, executionInputId: visit.executionInputId ?? visit.inputId } : {}),
      ...(visit.executionHistory ? { executionHistory: visit.executionHistory } : {}),
      ...(visit.executionError ? { executionError: visit.executionError } : {}),
      ...(visit.error ? { error: visit.error } : {}),
      ...(visit.errorHistory ? { errorHistory: visit.errorHistory } : {}),
      ...(visit.implementId ? { implementId: visit.implementId, participant: visit.participant } : {}),
      ...(visit.children ? { members: visit.children.map(child => ({ participant: child.participant, node: child.node, sessionId: child.sessionId, inputId: child.inputId, ...taskIdentity(child),
        ...(child.recoveryOf ? { recoveryOf: child.recoveryOf } : {}), ...(child.recoveredBy ? { recoveredBy: child.recoveredBy } : {}),
        ...(child.verdict ? { result: child.verdict, revision: child.revision } : {}), ...(child.error ? { error: child.error } : {}) })) } : {}),
      ...(visit.resultHistory ? { resultHistory: visit.resultHistory } : {}),
      ...(visit.verdict ? { result: visit.verdict, revision: visit.revision } : {}) })),
    ...(state.controls ? { controls: state.controls.map(({ target, ...command }) => command) } : {}),
    ...(state.recovery ? { recovery: state.recovery } : {}),
    ...(state.recoveryHistory ? { recoveryHistory: state.recoveryHistory } : {}),
    ...(state.failures ? { failures: state.failures } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(state.pendingFailure ? { pendingFailure: state.pendingFailure } : {}),
    ...(state.service ? { service: { status: 'unavailable' } } : {}),
    ...(result ? { result } : {}) };
}

function taskIdentity(visit) {
  return visit.taskId ? { taskId: visit.taskId, taskVersion: visit.taskVersion } : {};
}

export function watchEvent(previous, state) {
  if (!previous || state.status !== 'running' || (state.history?.length ?? 0) < (previous.history?.length ?? 0)) {
    return { type: 'snapshot', state };
  }
  const changes = {};
  const removed = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(state)])) {
    if (key === 'history') continue;
    if (!Object.hasOwn(state, key)) removed.push(key);
    else if (JSON.stringify(previous[key]) !== JSON.stringify(state[key])) changes[key] = state[key];
  }
  const historyUpdates = (state.history ?? []).flatMap((entry, index) =>
    JSON.stringify(previous.history?.[index]) === JSON.stringify(entry) ? [] : [{ index, entry }]);
  if (!Object.keys(changes).length && !removed.length && !historyUpdates.length) return undefined;
  return { type: 'update', runId: state.runId, changes,
    ...(removed.length ? { removed } : {}),
    ...(historyUpdates.length ? { historyUpdates } : {}) };
}

export async function ensureWorkflowRunner(root, id) {
  if (workflowHasOwner(root, id)) return;
  mkdirSync(join(root, 'workflows', id), { recursive: true, mode: 0o700 });
  const descriptor = openSync(join(root, 'workflows', id, 'controller.log'), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), root, id], {
      detached: true, stdio: ['ignore', descriptor, descriptor, 'ipc'], env: process.env,
    });
  } finally { closeSync(descriptor); }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(publicError('Контроллер не подтвердил запуск. Сохранённый runId: ' + id)), 15000);
    function finish(error) {
      clearTimeout(timer);
      child.removeAllListeners('message');
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      if (child.connected) child.disconnect();
      child.unref();
      error ? reject(error) : resolve();
    }
    child.once('error', finish);
    child.once('exit', () => finish(publicError('Контроллер завершился до подтверждения. Сохранённый runId: ' + id)));
    child.once('message', () => finish());
  });
}

function acknowledge() {
  if (process.connected) process.send({ ready: true });
}

function request(state, visit) {
  const node = state.definition.nodes[visit.node];
  const participant = state.participants?.[visit.node];
  const input = visit.correction ?? visit;
  const permissions = participant?.agent.permissions ?? state.rolePermissions?.[node.role] ?? rolePermissions(node.role).filter(rule =>
    rule.action !== 'skill' || state.roleAgents?.[node.role] === roleAgents[node.role]);
  const artifactPermissions = [
    ...(visit.review ? [{ action: 'external_directory', resource: join(dirname(visit.review.path), '*'), effect: 'allow' }] : []),
    ...(visit.contextDirectories ?? []).map(directory => ({ action: 'external_directory', resource: join(directory, '*'), effect: 'allow' })),
    ...(visit.contextDirectory ? [{ action: 'external_directory', resource: join(dirname(visit.contextDirectory), '*'), effect: 'allow' }] : []),
  ];
  return { id: state.id, sessionId: visit.sessionId, inputId: input.inputId,
    ...(artifactPermissions.length ? { artifactPermissions } : {}),
    request: { text: input.prompt, session: { title: `DWF ${node.role} ${visit.implementId ? visit.participant : visit.node}`,
      agent: participant?.id ?? state.roleAgents?.[node.role] ?? 'build', model: participant?.model ?? state.model,
      location: { directory: visit.workspace?.path ?? state.workspace.path },
      metadata: { dwfRunId: state.id, ...(visit.implementId ? { dwfImplementId: visit.implementId,
         dwfTaskId: visit.taskId, dwfParticipant: visit.participant } : {}) },
      permissions: [...permissions, ...artifactPermissions] } } };
}

function finishParticipant(state, visit, outcome) {
  const executionInputId = visit.correction?.inputId ?? visit.inputId;
  if (visit.execution && (visit.executionInputId ?? visit.inputId) !== executionInputId) {
    visit.executionHistory ??= [];
    visit.executionHistory.push({ inputId: visit.executionInputId ?? visit.inputId, outcome: visit.execution });
  }
  visit.executionInputId = executionInputId;
  visit.execution = outcome;
  const role = state.definition.nodes[visit.node].role;
  const revision = snapshot(visit.workspace ?? state.workspace);
  if (role !== 'worker' && !(role === 'planner' && state.legacyPlanner) && !(role === 'orchestrator' && state.implements) && revision !== visit.revision) {
    throw publicError('Рабочее дерево изменилось во время проверки. Требуется новая проверка.');
  }
  if (role === 'orchestrator' && state.implements) visit.completionRevision = revision;
  if (outcome.status !== 'succeeded') throw publicError(outcome.error);
  if (state.legacyPlanner && role === 'planner') {
    visit.verdict = { outcome: 'done', summary: outcome.result };
    return;
  }
  let verdict;
  try {
    verdict = parseVerdict(outcome.result, role, decisionOutcomes(state.definition, visit.node));
    if (role === 'scientist') {
      validateScientistVerdict(researchGraph(state.definition), state.visits.slice(0, -1),
        verdict, validateItems, message => { throw publicError(message); });
    }
  } catch (error) {
    if (role !== 'scientist' || visit.correction || !error.publicMessage) throw error;
    const phase = scientistPhase(researchGraph(state.definition), state.visits.slice(0, -1));
    visit.correction = { inputId: 'msg_' + randomUUID(),
      prompt: `DWF needs a corrected JSON response for this stage. ${error.publicMessage}\n${phase}\nA scout verdict has exactly two assignments with IDs foundations and recent. A research verdict has exactly four assignments with unique IDs and instructions.` };
    visit.admitted = false;
    // The correction is a separate saved input in this session. Do not reopen
    // preparation or change the already-crossed admissionStarted boundary.
    delete visit.progress;
    return;
  }
  visit.verdict = role === 'committee' ? { outcome: verdict.outcome, summary: verdict.summary } : verdict;
  if (role === 'worker') visit.revision = revision;
}

function failWorkflow(state, message) {
  state.failures ??= [];
  state.failures.push({ createdAt: Date.now(), message, inputId: controlVisit(state)?.inputId,
    boundary: state.finalizing ? 'finalization' : controlVisit(state) ? admissionStage(controlVisit(state)) : 'preparation' });
  if (state.implements) state.pendingFailure ??= message;
  else { state.status = 'failed'; state.error = message; }
}

async function tickImplementParticipants(root, state, owner, client) {
  await withWorkflowAction(root, state, owner, () => {
    if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) return;
    advanceImplementState(root, state);
    for (const visit of state.visits.filter(visit => visit.implementId && admissionStage(visit) === 'prepared')) {
      visit.admissionStarted = true;
    }
  });
  let available = true;
  const admitting = state.visits.filter(visit => visit.implementId && admissionStage(visit) === 'admission_started');
  if (admitting.length) await withWorkflowAction(root, state, owner, async () => {
    if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) return;
    await Promise.all(admitting.map(async visit => {
      try {
        await checkContinuationAdmission(client, state, visit);
        await admit(client, request(state, visit));
        visit.admitted = true;
        acknowledgeContext(visit);
        state.sessions[visit.participant] = visit.sessionId;
      } catch (error) {
        if (error.publicMessage) visit.error = error.publicMessage;
        else { state.service = 'unavailable'; available = false; }
      }
    }));
  });
  const active = state.visits.filter(visit => visit.implementId && admissionStage(visit) === 'admitted');
  const executions = await Promise.allSettled(active.map(visit => readExecution(client, request(state, visit))));
  if (executions.length) await withWorkflowAction(root, state, owner, () => {
    if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) return;
    for (const [index, execution] of executions.entries()) {
      const visit = active[index];
      try {
        if (execution.status === 'rejected') throw execution.reason;
        if (execution.value.progress) visit.progress = execution.value.progress;
        if (execution.value.outcome) finishParticipant(state, visit, execution.value.outcome);
      } catch (error) {
        if (error.publicMessage) visit.error = error.publicMessage;
        else { state.service = 'unavailable'; available = false; }
      }
      if (visit.steering && admissionStage(visit) === 'finished') {
        state.controls.find(command => command.id === visit.steering).status = 'applied';
      }
    }
  });
  if (available) delete state.service;
  return available;
}

export async function runWorkflow(root, id) {
  const owner = randomUUID();
  if (!claimWorkflow(root, id, owner)) {
    acknowledge();
    return;
  }
  const state = getWorkflow(root, id);
  initializeImplements(state);
  const research = researchGraph(state.definition);
  const save = complete => updateWorkflow(root, state, owner, complete);
  if (state.status !== 'running' || ['blocked', 'aborted'].includes(state.recovery?.status) && !state.controls?.some(c => c.kind === 'stop' && c.status === 'pending')) { save(true); acknowledge(); return; }
  let client;
  let acknowledged = false;
  while (state.status === 'running') {
    try {
      save(false);
      if (!client) {
        try { client = await connect(root, state.participants, { profile: state.opencode ?? 'legacy' }); }
        catch (error) {
          if (error.publicMessage) throw error;
          state.service = 'unavailable';
          save(false);
          await pause(1000);
          continue;
        }
        if (state.roleAgents) await checkRoleAgents(client, state.workspace.path, state.roleAgents);
      }
      const stop = state.controls?.find(command => command.kind === 'stop' && command.status === 'pending');
      if (stop) {
        await withWorkflowAction(root, state, owner, () => captureStopSessions(client, state));
        await withWorkflowAction(root, state, owner, async () => {
          await interruptSessions(client, state);
          await captureStopSessions(client, state);
        });
        await withWorkflowAction(root, state, owner, async () => {
          await stopSessions(client, state);
          for (const command of state.controls) if (command.status === 'pending' || (state.implements && command.status === 'delivered')) command.status = 'cancelled';
          stop.status = 'applied';
          state.status = 'cancelled';
          delete state.pendingFailure;
          delete state.service;
        });
        break;
      }
      if (state.pendingFailure) {
        await withWorkflowAction(root, state, owner, () => captureStopSessions(client, state));
        await withWorkflowAction(root, state, owner, async () => {
          await interruptSessions(client, state);
          await captureStopSessions(client, state);
        });
        await withWorkflowAction(root, state, owner, async () => {
          await stopSessions(client, state);
          state.error = state.pendingFailure;
          delete state.pendingFailure;
          delete state.service;
          state.executionStopped = true;
          for (const command of state.controls ?? []) if (['pending', 'delivered'].includes(command.status)) command.status = 'cancelled';
          state.status = 'failed';
        });
        break;
      }
      if (state.implements) {
        const available = await tickImplementParticipants(root, state, owner, client);
        if (!available) { client = undefined; await pause(300); continue; }
      }
      let visit = controlVisit(state);
      if (visit?.kind === 'implements' && !visit.verdict) {
        if (!acknowledged) { acknowledge(); acknowledged = true; }
        if (state.implements.events.length > visit.eventCursor || state.controls?.some(command =>
          command.kind === 'steer' && command.status === 'pending' && !implementTarget(state, command.node))) {
          visit.verdict = { outcome: 'done', summary: 'Получены новые события implement.',
            events: state.implements.events.slice(visit.eventCursor) };
          save(false);
        } else await pause(300);
        continue;
      }
      const stage = visit && admissionStage(visit);
      if (stage === 'finished' && !visit.verdict) throw publicError(visit.error);
      if (!visit || stage === 'finished') {
        const steering = state.controls?.find(command => command.kind === 'steer' && command.status === 'pending' && !implementTarget(state, command.node));
        const steered = steering && {
          ...participantVisits(state.visits).findLast(item => item.participant === steering.node),
          ...steering.target,
        };
        const report = research && researchResult(research, state.visits);
        const next = report ? null : steered?.node ?? steering?.node ??
          (visit ? state.definition.transitions[visit.node][visit.verdict.outcome] : state.definition.entry);
        if (next === null) {
          if (visit.children && visit.verdict.outcome !== 'done') {
            await withWorkflowAction(root, state, owner, () => {
              if (state.controls?.some(command => command.status === 'pending')) return;
              state.result = visit.verdict;
              failWorkflow(state, `Группа ${visit.node} завершилась с результатом ${visit.verdict.outcome}.`);
            });
            continue;
          }
          if (!state.finalizing) {
            await withWorkflowAction(root, state, owner, () => {
              if (state.controls?.some(command => command.status === 'pending')) return;
              checkImplementCandidates(state);
               checkApprovals(state, snapshot(state.workspace));
              state.finalizing = true;
            });
            continue;
          }
          await withWorkflowAction(root, state, owner, () => {
            if (state.controls?.some(command => command.status === 'pending')) return;
            const revision = snapshot(state.workspace);
            checkImplementCandidates(state);
             checkApprovals(state, revision);
            if (state.definition.merge) {
              state.result = { summary: visit.verdict.summary,
                commit: mergeWorkspace(state.workspace, revision, workflowCommitTitle(state, revision)) };
            } else state.result = state.legacyPlanner ? visit.verdict.summary : report ?? visit.verdict;
            state.status = 'succeeded';
          });
          continue;
        }
        if (next === 'implements' && state.definition.implements) {
          await withWorkflowAction(root, state, owner, () => {
            if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) return;
            applyImplementDecision(state, visit);
            state.visits.push({ node: 'implements', kind: 'implements', startedAt: Date.now(),
              inputId: 'implements_' + randomUUID(), eventCursor: visit.implementEventCursor ?? 0 });
          });
          continue;
        }
        if (state.definition.groups?.[next]) {
          visit = prepareGroup(root, state, next, visit?.verdict);
          state.visits.push(visit);
          save(false);
        } else {
          const node = state.definition.nodes[next];
          if (!node) {
            await withWorkflowAction(root, state, owner, () => {
              if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) return;
              failWorkflow(state, `Не найден участник workflow ${next}.`);
            });
            continue;
          }
          const previous = visit?.verdict;
          const handoffInputId = visit?.inputId;
          const revision = snapshot(state.workspace);
          const participant = steered?.participant ?? next;
          const sessionId = steering ? steered?.sessionId ?? state.sessions[participant] ?? 'ses_' + randomUUID()
            : state.participants?.[next]?.memory === false ? 'ses_' + randomUUID()
              : state.sessions[participant] ?? 'ses_' + randomUUID();
          const inputId = 'msg_' + randomUUID();
          const workspace = node.role === 'verifier' ? verificationWorkspace(root, id, state.workspace, revision, inputId) : state.workspace;
          const review = node.role === 'reviewer' && state.workspace.mode !== 'directory' ? writeReviewDiff(state.workspace, revision,
            join(root, 'workflows', id, 'reviews', `${inputId}.diff`)) : undefined;
          visit = { node: next, participant, sessionId, inputId, revision, startedAt: Date.now(),
            ...taskBinding(state, next, steered?.item),
            admissionStarted: false,
            ...(steered?.item ? { item: steered.item } : {}),
            ...(node.role === 'verifier' ? { workspace } : {}),
            ...(review ? { review } : {}),
             ...(node.role === 'orchestrator' && state.implements ? { implementEventCursor: state.implements.events.length, implementObserved: implementObservation(state) } : {}) };
          if (steering) {
            visit.steering = steering.id;
            steering.status = 'delivered';
          }
          prepareRoleInput(root, state, visit, previous, workspace, next, steering, { ...implementContext(state), handoffInputId });
          state.visits.push(visit);
          save(false);
        }
      }
      if (admissionStage(visit) === 'prepared') {
        await withWorkflowAction(root, state, owner, () => {
          if (state.controls?.some(command => command.status === 'pending' && command.kind === 'stop')) {
            state.visits.splice(state.visits.indexOf(visit), 1);
            return;
          }
          const steering = state.controls?.find(command => command.status === 'pending' && command.kind === 'steer' && !implementTarget(state, command.node));
          if (steering && !visit.steering) {
            const child = visit.children?.find(item => item.participant === steering.node);
            if (!child) {
              for (const command of state.controls ?? []) {
                const target = visit.children?.find(item => item.participant === command.node);
                if (command.kind === 'steer' && command.status === 'pending' && !implementTarget(state, command.node) && target) {
                  command.target ??= { node: target.node, participant: target.participant,
                    ...(target.item ? { item: target.item } : {}) };
                }
              }
              state.visits.splice(state.visits.indexOf(visit), 1);
              return;
            }
            // A changed prepared draft gets a fresh document namespace. Other
            // implement reports can arrive between group preparation and steer.
            // Even a raw-only legacy draft can have orphan documents from a
            // crashed, uncommitted preparation. Never reuse its namespace.
            child.inputId = 'msg_' + randomUUID();
            Object.assign(child, taskBinding(state, child.node, child.item));
            const previousControl = state.visits.slice(0, state.visits.indexOf(visit)).findLast(v => !v.implementId);
            prepareRoleInput(root, state, child, previousControl?.verdict, child.workspace ?? state.workspace, visit.node, steering,
              { handoffInputId: previousControl?.inputId });
            child.steering = steering.id;
            steering.status = 'delivered';
          }
          // Commit this boundary before any external send. From here on controls
          // cannot alter these inputs; late steering becomes a subsequent visit.
          // A lost acknowledgement retries the saved sessionId, inputId and full text.
          visit.admissionStarted = true;
        });
        continue;
      }
      if (visit.children) {
        const awaitingAdmission = visit.children.filter(child => !child.recoveredBy && admissionStage(child, visit) === 'admission_started');
        // The group's barrier and each child's acknowledgement are separate facts.
        // Saved verdicts/errors are terminal even in older records without admitted.
        if (admissionStage(visit) === 'admission_started' || awaitingAdmission.length) {
          await withWorkflowAction(root, state, owner, async () => {
            if (state.controls?.some(command => command.status === 'pending' && command.kind === 'stop')) return;
            await Promise.all(awaitingAdmission.map(async child => {
              try {
                child.admissionStarted = true;
                await checkContinuationAdmission(client, state, child);
                await admit(client, request(state, child));
                child.admitted = true;
                acknowledgeContext(child);
                state.sessions[child.participant] = child.sessionId;
              }
              catch (error) {
                if (error.publicMessage) child.error = error.publicMessage;
                else state.service = 'unavailable';
              }
            }));
            visit.admitted = visit.children.filter(child => !child.recoveredBy).every(child => ['admitted', 'finished'].includes(admissionStage(child, visit)));
          });
          if (admissionStage(visit) !== 'admitted') { client = undefined; await pause(300); continue; }
        }
        if (!acknowledged) { acknowledge(); acknowledged = true; }
        const active = visit.children.filter(child => !child.recoveredBy && admissionStage(child, visit) === 'admitted');
        const executions = await Promise.allSettled(active.map(child => readExecution(client, request(state, child))));
        for (const [index, execution] of executions.entries()) {
          const child = active[index];
          try {
            if (execution.status === 'rejected') throw execution.reason;
            if (execution.value.progress) child.progress = execution.value.progress;
            if (execution.value.outcome) finishParticipant(state, child, execution.value.outcome);
          } catch (error) {
            if (error.publicMessage) child.error = error.publicMessage;
            else { state.service = 'unavailable'; client = undefined; }
          }
          if (child.steering && admissionStage(child, visit) === 'finished') {
            state.controls.find(command => command.id === child.steering).status = 'applied';
          }
        }
        save(false);
        if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) continue;
        if (visit.children.filter(child => !child.recoveredBy).every(child => admissionStage(child, visit) === 'finished')) {
          await withWorkflowAction(root, state, owner, () => {
            if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) return;
            visit.verdict = groupVerdict(visit);
            if (visit.verdict.outcome === 'done') {
              try { integrateGroup(root, state, visit); }
              catch (error) { visit.verdict.outcome = 'failed'; visit.verdict.integrationError = error.publicMessage; }
            }
          });
        } else await pause(300);
        continue;
      }
      if (admissionStage(visit) === 'admission_started') {
        try {
          await withWorkflowAction(root, state, owner, async () => {
            if (state.controls?.some(command => command.status === 'pending' && command.kind === 'stop')) return;
            await checkContinuationAdmission(client, state, visit);
            await admit(client, request(state, visit));
            visit.admitted = true;
            acknowledgeContext(visit);
            state.sessions[visit.participant ?? visit.node] = visit.sessionId;
          });
        } catch (error) {
          if (error.publicMessage) throw error;
          state.service = 'unavailable';
          save(false);
          client = undefined;
          await pause(300);
          continue;
        }
      }
      // Only acknowledged inputs may be polled for a result.
      if (admissionStage(visit) !== 'admitted') continue;
      if (!acknowledged) { acknowledge(); acknowledged = true; }
      let outcome;
      try {
        const execution = await readExecution(client, request(state, visit));
        outcome = execution.outcome;
        if (execution.progress) visit.progress = execution.progress;
      }
      catch (error) {
        if (error.publicMessage) throw error;
        state.service = 'unavailable';
        save(false);
        await pause(1000);
        client = undefined;
        continue;
      }
      delete state.service;
      if (!outcome) { await pause(300); continue; }
      save(false);
      if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) continue;
      try {
        finishParticipant(state, visit, outcome);
      } catch (error) {
        visit.executionError = error.publicMessage ?? error.message;
        if (!state.controls?.some(command => command.kind === 'steer' && command.status === 'pending' && !implementTarget(state, command.node))) throw error;
        visit.verdict = { outcome: 'blocked', summary: error.publicMessage };
      }
      if (visit.steering) state.controls.find(command => command.id === visit.steering).status = 'applied';
      if (visit.verdict?.outcome === 'blocked' && !state.definition.transitions[visit.node].blocked &&
        !state.controls?.some(command => command.status === 'pending')) throw publicError(visit.verdict.summary);
      save(false);
    } catch (error) {
      if (error.code === 'DWF_OWNER_LOST') break;
      try {
        await withWorkflowAction(root, state, owner, () => {
          if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) {
            state.service = 'unavailable';
            return;
          }
          if (state.controls?.some(command => command.kind === 'steer' && command.status === 'pending' && !implementTarget(state, command.node))) {
            const visit = controlVisit(state);
            if (visit && !visit.verdict) visit.verdict = { outcome: visit.children ? 'failed' : 'blocked',
              summary: error.publicMessage ?? 'Выполнение этапа прервано уточнением.' };
            return;
          }
          failWorkflow(state, error.publicMessage ?? `Контроллер workflow: ${error.code ?? error.name}: ${error.message}. Рабочее дерево сохранено; исправьте причину и выполните dwf continue.`);
        });
      } catch { break; /* A replacement controller owns the current state. */ }
      if (state.status === 'running') { client = undefined; await pause(1000); }
    }
  }
  if (!acknowledged) acknowledge();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runWorkflow(process.argv[2], process.argv[3]);
}
