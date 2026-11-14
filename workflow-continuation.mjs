import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { publicError, withWorkflowContinuation, getWorkflow, getRun, workflowHasOwner } from './run-store.mjs';
import { connect, observeAttempt } from './opencode-runtime.mjs';
import { snapshot, verificationWorkspace, writeReviewDiff } from './workflow-git.mjs';
import { controlVisit, implementContext, invalidateForContinuation } from './workflow-implements.mjs';
import { prepareRoleInput } from './role-context.mjs';
import { admissionStage } from './workflow-admission.mjs';
import { taskBinding } from './task-packages.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parentOf = (state, visit) => state.visits.find(v => v.children?.includes(visit));
const prepared = (state, visit) => admissionStage(visit, parentOf(state, visit) ?? visit) === 'prepared';
const children = v => (v.children ?? [v]).filter(v => !v.recoveredBy);
const roleOf = (state, v) => state.definition.nodes[v.node]?.role;
const authority = state => ({ taskRevisions: state.taskRevisions ?? [],
  controls: (state.controls ?? []).map(({ resumedBy, ...command }) => command) });
const permissionRecord = (state, visit) => state.recoveryHistory?.find(r => r.id === (visit?.continuationAuthorization ?? visit?.recoveryId));
function permissionCurrent(state, visit) {
  const record = permissionRecord(state, visit);
  if (!record?.resolution) return true;
  if (record.authority && JSON.stringify(record.authority) !== JSON.stringify(authority(state))) return false;
  try { return (visit.recoveryId !== record.id || snapshot(visit.workspace ?? state.workspace) === visit.revision) &&
    record.plan.workspaces.every(w => snapshot({ ...state.workspace, path: w.path }) === w.revision); }
  catch { return false; }
}
async function permissionEvidenceCurrent(client, state, visit, current, observe = observeAttempt) {
  const record = permissionRecord(state, visit);
  if (!record?.resolution || current.present || current.pending) return true;
  if (!permissionCurrent(state, visit)) return false;
  for (const observation of record.plan.observations) {
    const origin = state.visits.flatMap(v => v.children ?? [v]).find(v => v.inputId === observation.inputId);
    if (!origin || !record.resolution.decisions.some(d => d.attemptId === (origin.correction?.inputId ?? origin.inputId))) continue;
    const native = await observe(client, state, origin);
    if (JSON.stringify(native) !== JSON.stringify(observation.nativeEvidence ?? observation.native)) return false;
  }
  return true;
}
function preparedContinuation(state) {
  const visit = state?.visits && controlVisit(state);
  return state?.status === 'running' && state.recovery?.status === 'resumed' &&
    visit?.admissionStarted === false && !permissionRecord(state, visit)?.resolution;
}

// All observations and the saved decision are fenced by the same SQLite write
// transaction as takeover, controls and finalization. No model input is sent here.
export async function continueWorkflow(root, id, options = {}, dependencies = {}) {
  let saved;
  try { saved = getWorkflow(root, id) ?? getRun(root, id); }
  catch (error) {
    if (error instanceof SyntaxError) throw publicError('Повреждено сохранённое JSON-состояние DWF. Данные не изменены; нужна проверенная резервная копия.');
    throw error;
  }
  if (!saved) throw publicError('Запуск не найден в состоянии DWF.');
  if (!saved.definition && saved.status !== 'failed') {
    if (options.resolution) throw publicError('Решение устарело: legacy-запуск работает или завершён.');
    return saved;
  }
  const preparedRetry = preparedContinuation(saved);
  let preparedClient = dependencies.client, connectionError;
  if (saved && saved.status !== 'succeeded' && !preparedRetry &&
      !(saved.status === 'running' && workflowHasOwner(root, id)) &&
      !(saved.status === 'cancelled' && !options.resumeCancelled) && !preparedClient) {
    // connectLegacy uses the same service lock database; acquire it BEFORE the
    // continuation transaction. Session observations still happen under fencing.
    try { preparedClient = await connect(root, saved.participants, { profile: saved.opencode ?? saved.request?.opencode ?? 'legacy' }); }
    catch (error) { connectionError = error; }
  }
  return withWorkflowContinuation(root, id, async (state, ownership) => {
    if (state.status === 'succeeded' || state.status === 'running' && (ownership.owned || preparedContinuation(state))) {
      if (options.resolution) throw publicError('Решение устарело: запуск уже работает или завершён.');
      return;
    }
    if (state.status === 'cancelled' && !options.resumeCancelled) {
      throw publicError('Запуск явно остановлен. Для продолжения нужен --resume-cancelled.');
    }
    const original = structuredClone(state);
    const previous = { status: state.status, error: state.error, result: state.result };
    let plan;
    try {
      const revision = snapshot(state.workspace);
      if (connectionError) throw connectionError;
      const client = preparedClient;
      const current = controlVisit(state);
      // A failure-stop may have interrupted independent implement inputs as well.
      const targets = [...new Set([...(current && current.kind !== 'implements' ? children(current) : []),
        ...Object.values(state.implements?.instances ?? {}).flatMap(instance => {
          const v = state.visits.find(v => v.inputId === instance.currentInputId);
          return v && !v.verdict ? [v] : [];
        })])];
      const observations = [];
      for (const visit of targets) {
        const workspace = visit.workspace ?? state.workspace;
        observations.push({ inputId: visit.inputId, revision: snapshot(workspace),
          native: prepared(state, visit) ? { absent: true } : visit.verdict && visit.verdict.outcome !== 'blocked' ? { saved: true } : await (dependencies.observe ?? observeAttempt)(client, state, visit) });
      }
      for (const observation of observations) {
        observation.nativeEvidence = structuredClone(observation.native);
        const visit = targets.find(v => v.inputId === observation.inputId);
        const prior = state.recoveryHistory?.find(r => r.id === (visit.continuationAuthorization ?? visit.recoveryId));
        if (prior?.resolution && !await permissionEvidenceCurrent(client, state, visit, observation.native, dependencies.observe ?? observeAttempt)) {
          observation.native.uncertain = prior.resolution.decisions.map(d => ({
            ...prior.plan.observations.flatMap(o => o.native.uncertain ?? []).find(op => op.id === d.operationId), id: d.operationId,
            kind: 'stale_permission', reason: 'Files, commands, requirements or native operation changed after permission, before confirmed admission; a fresh decision is required.' }));
        }
      }
      const workspaces = [state.workspace, ...targets.map(v => v.workspace).filter(Boolean), ...Object.values(state.implements?.instances ?? {}).map(i => i.workspace).filter(Boolean),
        ...(state.definition.merge ? [{ ...state.workspace, path: state.workspace.source }] : [])];
      plan = { revision, workspaces: [...new Map(workspaces.map(w => [w.path, w])).values()].map(w => ({ path: w.path, revision: snapshot(w) })), observations };
      const problems = observations.flatMap(observation => {
        const visit = targets.find(v => v.inputId === observation.inputId);
        return (observation.native.uncertain ?? []).map(operation => ({
          operationId: operation.id, attemptId: visit.correction?.inputId ?? visit.inputId,
          ...operation, revision: observation.revision,
        }));
      });
      // The token covers files, native results, active/inbox state and requirements;
      // timestamps of observers/repeated continue calls do not create new authority.
      const token = hash({ plan, taskRevisions: state.taskRevisions, visits: state.visits.map(v => [v.inputId, v.verdict, v.error]),
        operations: state.implements, controls: state.controls });
      const templates = problems.map(({ id: _id, ...operation }) => ({ runId: id, token,
        operationId: operation.operationId, attemptId: operation.attemptId, revision: operation.revision,
        action: 'choose: confirm|retry|abort', evidence: '' }));
      const resolution = options.resolution;
      if (resolution) {
        if (resolution.runId !== id || resolution.token !== token || !Array.isArray(resolution.decisions) ||
          resolution.decisions.length !== problems.length || resolution.decisions.some(d => !d || typeof d !== 'object') || new Set(resolution.decisions.map(d => d.operationId)).size !== problems.length ||
          resolution.decisions.some(d => !['confirm', 'retry', 'abort'].includes(d.action) || typeof d.evidence !== 'string' || !d.evidence.trim() ||
            !problems.some(p => p.operationId === d.operationId && p.attemptId === d.attemptId && p.revision === d.revision))) {
          throw publicError('Решение устарело или не соответствует операциям/попыткам/ревизиям. Повторите continue без resolution-file.');
        }
      }
      if (problems.length && !resolution) {
        state.recovery = { status: 'blocked', reason: 'Неизвестен результат внешнего действия. Нужен явный выбор confirm|retry|abort.',
          boundary: current?.inputId ?? 'preparation', token, problems,
          resolutionTemplate: { runId: id, token, decisions: templates.map(({ runId: _run, token: _token, ...d }) => d) } };
        return;
      }
      if (resolution?.decisions.some(d => d.action === 'abort')) {
        if (JSON.stringify(state.recoveryHistory?.at(-1)?.resolution) === JSON.stringify(resolution) && state.recovery?.status === 'aborted') return;
        record(state, { ...previous, plan, resolution, status: 'aborted' });
        state.recovery = { status: 'aborted', reason: 'Пользователь прекратил восстановление. Прогресс сохранён.' };
        return;
      }
      if (state.status === 'running' && current?.admissionStarted === false && !problems.length && !resolution) return;
      const recovery = { id: randomUUID(), ...previous, authority: authority(state), plan, ...(resolution ? { resolution } : {}), status: 'resumed' };
      // A checking group is one graph boundary, even when a later standalone
      // verifier is current. Inspect its live members, not just top-level visits.
      const latestChecks = new Map();
      for (const boundary of state.visits) {
        if (boundary.implementId || boundary.recoveredBy) continue;
        for (const v of children(boundary)) if (['reviewer', 'verifier'].includes(roleOf(state, v))) {
          latestChecks.set(v.participant ?? v.node, { visit: v, boundary });
        }
      }
      const staleChecks = [...latestChecks.values()].filter(({ visit }) => visit.revision !== revision);
      // Rewinding checks must never displace an unfinished graph operation. In
      // particular, a worker retry/native attachment is still the current stage;
      // its normal outgoing edges will schedule checking after it actually ends.
      const executing = observations.some(o => o.native.active || o.native.pending);
      const unfinishedWork = targets.some(v => (!v.verdict || v.verdict.outcome === 'blocked') &&
        !['reviewer', 'verifier'].includes(roleOf(state, v)));
      const recheck = !executing && !unfinishedWork ?
        (staleChecks.find(({ visit }) => roleOf(state, visit) === 'reviewer') ?? staleChecks[0])?.boundary : undefined;
      const checkingRewind = Boolean(recheck);

      // Preserve all failure/stop records. Acknowledged and successful inputs are
      // never reset to prepared; a retry is a NEW input in the existing session.
      for (const observation of observations) {
        const visit = targets.find(v => v.inputId === observation.inputId);
        const native = observation.native;
        const blockedReport = visit.verdict?.outcome === 'blocked';
        if (visit.verdict && !blockedReport || checkingRewind && ['reviewer', 'verifier'].includes(roleOf(state, visit))) continue;
        if (native.active || native.pending) {
          if (visit.error) { visit.errorHistory ??= []; visit.errorHistory.push(visit.error); delete visit.error; }
          continue;
        }
        if (native.outcome?.status === 'succeeded' && !visit.error && !visit.executionError && !blockedReport) continue;
        const decisions = resolution?.decisions.filter(d => d.attemptId === (visit.correction?.inputId ?? visit.inputId)) ?? [];
        if (native.absent && prepared(state, visit) && !decisions.length) continue;
        if (native.absent && !visit.admitted && !visit.error && !state.executionStopped && state.status !== 'cancelled' && !decisions.length) continue;
        if (!native.outcome && !native.absent && !native.inactive && !visit.error) continue;
        if (native.sessionMissing && !visit.admitted && !visit.error && !visit.progress && !visit.execution && decisions.length && decisions.every(d => d.action === 'retry')) {
          // A lost admission acknowledgement still replays the ORIGINAL ID and
          // bytes. Explicit permission handles possible loss of native history.
          visit.continuationAuthorization = recovery.id;
          continue;
        }
        retryVisit(root, state, visit, current?.children?.includes(visit) ? current : undefined,
          recovery.id, Boolean(native.sessionMissing), decisions);
      }
      if (recheck?.children) {
        const retained = children(recheck).filter(v => !['reviewer', 'verifier'].includes(roleOf(state, v)));
        const next = { node: recheck.node, inputId: 'group_' + randomUUID(), revision, startedAt: Date.now(),
          admissionStarted: false, children: [...retained], recoveryOf: recheck.inputId, recoveryId: recovery.id,
          // Retained writer results are evidence, not new inputs or new external
          // operations. If already integrated, their patches must not run again.
          ...(retained.length ? { writerBaseRevision: recheck.writerBaseRevision ?? recheck.revision,
            integratedWriterInputs: recheck.integratedWriterInputs ??
              (recheck.integratedRevision ? retained.filter(v => roleOf(state, v) === 'worker').map(v => v.inputId) : []) } : {}) };
        for (const old of children(recheck).filter(v => ['reviewer', 'verifier'].includes(roleOf(state, v)))) {
          const observation = observations.find(o => o.inputId === old.inputId);
          const decisions = resolution?.decisions.filter(d => d.attemptId === (old.correction?.inputId ?? old.inputId)) ?? [];
          // Use the same retry preparation as an ordinary child: the actual input
          // receives recoveryId and scoped decisions before its bytes are frozen.
          retryVisit(root, state, old, next, recovery.id, Boolean(observation?.native.sessionMissing), decisions);
        }
        recheck.recoveredBy = next.inputId; state.visits.push(next);
      } else if (recheck) {
        const observation = observations.find(o => o.inputId === recheck.inputId);
        const decisions = resolution?.decisions.filter(d => d.attemptId === (recheck.correction?.inputId ?? recheck.inputId)) ?? [];
        retryVisit(root, state, recheck, undefined, recovery.id, Boolean(observation?.native.sessionMissing), decisions);
      }
      const changedInstances = Object.values(state.implements?.instances ?? {}).filter(i => i.workspace &&
        ['ready', 'integrated'].includes(i.status) && i.candidateRevision !== snapshot(i.workspace));
      for (const instance of changedInstances) invalidateForContinuation(state, instance);
      if (changedInstances.length && current?.kind !== 'implements') {
        const manager = state.visits.findLast(v => !v.implementId && roleOf(state, v) === 'orchestrator');
        if (manager) retryVisit(root, state, manager, undefined, recovery.id, false, []);
      }
      // A failed aggregate is recomputed from retained successful members and new
      // attempts only, including recoverable Git application boundaries.
      if (recheck !== current && current?.children && (current.verdict?.outcome === 'failed' || current.verdict?.integrationError)) {
        current.resultHistory ??= [];
        current.resultHistory.push({ verdict: current.verdict, recoveryId: recovery.id });
        delete current.verdict;
      }
      // Changed common files invalidate old approvals by revision, not by erasing
      // their reports. Recheck only the first stale checking stage; normal graph
      // transitions perform subsequent stages.
      if (current?.verdict && !current.children && !state.visits.some(v => v.recoveryId === recovery.id && !v.implementId)) {
        if (current.verdict.outcome === 'blocked') {
          const observation = observations.find(o => o.inputId === current.inputId);
          const decisions = resolution?.decisions.filter(d => d.attemptId === (current.correction?.inputId ?? current.inputId)) ?? [];
          retryVisit(root, state, current, undefined, recovery.id, Boolean(observation?.native.sessionMissing), decisions);
        }
      }
      // Native error fields remain in the original attempt. Recovered stop controls
      // are historical facts, not pending stop commands for the new execution.
      for (const command of state.controls ?? []) if (command.kind === 'stop') command.resumedBy ??= recovery.id;
      record(state, recovery);
      state.recovery = { status: 'resumed', id: recovery.id, boundary: controlVisit(state)?.inputId ?? 'preparation', revision };
      state.status = 'running';
      delete state.result;
      delete state.error;
      delete state.pendingFailure;
      delete state.executionStopped;
      delete state.service;
      if (state.visits.some(v => v.recoveryId === recovery.id)) delete state.finalizing;
    } catch (error) {
      if (error.publicMessage?.startsWith('Решение устарело')) throw error;
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, original);
      state.recovery = { status: 'blocked', boundary: controlVisit(state)?.inputId ?? 'preparation',
        reason: error.publicMessage ?? `Не удалось проверить окружение/сессию: ${error.code ?? error.message}. Исправьте причину и повторите continue.` };
    }
  });
}

function record(state, entry) {
  state.recoveryHistory ??= [];
  state.recoveryHistory.push({ createdAt: Date.now(), ...entry });
}

function retryVisit(root, state, old, group, recoveryId, sessionMissing, decisions) {
  const inputId = 'msg_' + randomUUID();
  const instance = old.implementId && state.implements.instances[old.implementId];
  const role = roleOf(state, old);
  // A writer's private tree contains confirmed partial effects; do not replace
  // it with a fresh copy of the common candidate on retry.
  const source = group && role === 'worker' ? old.workspace ?? state.workspace : instance?.workspace ?? state.workspace;
  const revision = snapshot(source);
  const workspace = group && role === 'worker' ? source : group || role === 'verifier' ? verificationWorkspace(root, state.id, source, revision, inputId) : source;
  const review = role === 'reviewer' && source.mode !== 'directory' ? writeReviewDiff(source, revision,
    join(root, 'workflows', state.id, 'reviews', `${inputId}.diff`)) : undefined;
  const visit = { node: old.node, participant: old.participant ?? old.node,
    ...taskBinding(state, old.node, old.implementId ? { taskId: old.taskId } : old.item),
    ...(old.item ? { item: old.item } : {}), ...(old.required !== undefined ? { required: old.required } : {}),
    ...(instance ? { implementId: old.implementId } : {}),
    sessionId: sessionMissing ? 'ses_' + randomUUID() : old.sessionId, inputId, revision, startedAt: Date.now(), admissionStarted: false,
    ...(workspace !== state.workspace ? { workspace } : {}), ...(review ? { review } : {}), recoveryOf: old.correction?.inputId ?? old.inputId, recoveryId };
  const handoffId = old.taskContext?.otherReports?.handoffSource?.inputId;
  const predecessor = state.visits.flatMap(v => v.children ?? [v]).find(v => v.inputId === handoffId);
  const steering = state.controls?.find(c => c.id === old.steering || c.id === old.taskContext?.assignment?.steering?.id);
  old.recoveredBy = inputId;
  prepareRoleInput(root, state, visit, predecessor?.verdict ?? old.verdict, workspace, old.node, steering,
    { ...implementContext(state, instance), handoffInputId: handoffId,
      recovery: { id: recoveryId, previousInputId: old.correction?.inputId ?? old.inputId, sessionMissing, decisions } });
  if (state.legacyPlanner) visit.prompt = state.legacyPlanner.request.text;
  visit.prompt += `\n\nDWF continuation ${recoveryId}, new attempt after ${old.correction?.inputId ?? old.inputId}. Previous diagnostic: ${old.error ?? old.executionError ?? old.execution?.error ?? state.error ?? 'interrupted'}. Preserve completed work; inspect existing results before acting. Do not repeat completed external operations. ` +
    (sessionMissing ? 'The previous native session is unavailable. Saved requirements and reports are provided; lost native messages cannot be restored.\n' : '') +
    (decisions.length ? `Explicit user decisions for uncertain operations (confirm records the user witness, not a DWF verification):\n${JSON.stringify(decisions)}\n` : '');
  if (sessionMissing && !old.taskContext) visit.prompt += `\nSaved original input (historical evidence):\n${old.prompt}`;
  if (sessionMissing && old.taskContext) visit.prompt += `\nSaved previous task context (historical evidence):\n${JSON.stringify(old.taskContext)}`;
  if (group) group.children.push(visit);
  else state.visits.push(visit);
  if (instance) {
    old.implementHandled = true;
    instance.status = 'running';
    instance.phase = role;
    instance.currentInputId = inputId;
  }
}

// Recheck a revision-bound decision at the actual send boundary. A lost ack for
// an already accepted input still uses the same frozen ID/bytes, not a new grant.
export async function checkContinuationAdmission(client, state, visit) {
  if (!permissionRecord(state, visit)?.resolution) return;
  const native = await observeAttempt(client, state, visit);
  if (await permissionEvidenceCurrent(client, state, visit, native)) return;
  throw publicError('Решение восстановления устарело до отправки: файлы, требования, команды или native-состояние изменились. Вызовите continue и подтвердите актуальное состояние.');
}
