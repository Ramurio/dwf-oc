import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { admit, checkRoleAgents, connect, readExecution, stopSessions, captureStopSessions, interruptSessions } from './opencode-runtime.mjs';
import { claimWorkflow, getWorkflow, updateWorkflow, workflowHasOwner, publicError, withWorkflowAction } from './run-store.mjs';
import { parseVerdict, rolePermissions, rolePrompt, roleAgents, checkApprovals, workflowCommitTitle,
  participantVisits, validateItems } from './workflow-definition.mjs';
import { researchGraph, researchResult, scientistPhase, validateScientistVerdict } from './research-workflow.mjs';
import { mergeWorkspace, snapshot, writeReviewDiff, verificationWorkspace } from './workflow-git.mjs';
import { prepareGroup, groupVerdict, integrateGroup } from './workflow-groups.mjs';
import { admissionStage } from './workflow-admission.mjs';

export function publicWorkflow(state) {
  const current = state.visits.at(-1);
  let result = state.result;
  if (state.status === 'succeeded' && result?.commit) {
    result = { ...result,
      integration: { status: 'merged', branch: state.workspace.branch, commit: result.commit },
      summary: `DWF подтвердил локальный merge в ${state.workspace.branch}. Коммит ${result.commit}.\n\nОтчёт участника до интеграции\n${result.summary}` };
  }
  return { runId: state.id, status: state.status, workspace: state.workspace.path,
    current: current && { node: current.node, role: state.definition.nodes[current.node]?.role ?? 'group',
      sessionId: current.sessionId, visit: state.visits.length,
      ...(current.participant ? { participant: current.participant } : {}),
      ...(current.children ? { members: current.children.map(child => ({ participant: child.participant, node: child.node,
        sessionId: child.sessionId, status: child.error ? 'failed' : child.verdict ? 'completed' : 'running',
        ...(child.progress ? { progress: child.progress } : {}) })) } : {}),
      ...(current.startedAt ? { startedAt: current.startedAt } : {}),
      ...(current.progress ? { progress: current.progress } : {}) },
    history: state.visits.map(visit => ({ node: visit.node, sessionId: visit.sessionId,
      ...(visit.verdict ? { result: visit.verdict, revision: visit.revision } : {}) })),
    ...(state.controls ? { controls: state.controls.map(({ target, ...command }) => command) } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(state.service ? { service: { status: 'unavailable' } } : {}),
    ...(result ? { result } : {}) };
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
  return { id: state.id, sessionId: visit.sessionId, inputId: input.inputId,
    request: { text: input.prompt, session: { title: `DWF ${node.role} ${visit.node}`,
      agent: participant?.id ?? state.roleAgents?.[node.role] ?? 'build', model: participant?.model ?? state.model,
      location: { directory: visit.workspace?.path ?? state.workspace.path },
      metadata: { dwfRunId: state.id },
      permissions: [...permissions, ...(visit.review ? [{ action: 'external_directory',
        resource: join(dirname(visit.review.path), '*'), effect: 'allow' }] : [])] } } };
}

function finishParticipant(state, visit, outcome) {
  const role = state.definition.nodes[visit.node].role;
  const revision = snapshot(visit.workspace ?? state.workspace);
  if (role !== 'worker' && revision !== visit.revision) {
    throw publicError('Рабочее дерево изменилось во время проверки. Требуется новая проверка.');
  }
  if (outcome.status !== 'succeeded') throw publicError(outcome.error);
  let verdict;
  try {
    verdict = parseVerdict(outcome.result, role);
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

export async function runWorkflow(root, id) {
  const owner = randomUUID();
  if (!claimWorkflow(root, id, owner)) {
    acknowledge();
    return;
  }
  const state = getWorkflow(root, id);
  const research = researchGraph(state.definition);
  const save = complete => updateWorkflow(root, state, owner, complete);
  if (state.status !== 'running') { save(true); acknowledge(); return; }
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
          for (const command of state.controls) if (command.status === 'pending') command.status = 'cancelled';
          stop.status = 'applied';
          state.status = 'cancelled';
          delete state.service;
        });
        break;
      }
      let visit = state.visits.at(-1);
      const stage = visit && admissionStage(visit);
      if (stage === 'finished' && !visit.verdict) throw publicError(visit.error);
      if (!visit || stage === 'finished') {
        const steering = state.controls?.find(command => command.kind === 'steer' && command.status === 'pending');
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
              state.error = `Группа ${visit.node} завершилась с результатом ${visit.verdict.outcome}.`;
              state.status = 'failed';
            });
            continue;
          }
          if (!state.finalizing) {
            await withWorkflowAction(root, state, owner, () => {
              if (state.controls?.some(command => command.status === 'pending')) return;
              checkApprovals(state, snapshot(state.workspace));
              state.finalizing = true;
            });
            continue;
          }
          await withWorkflowAction(root, state, owner, () => {
            if (state.controls?.some(command => command.status === 'pending')) return;
            const revision = snapshot(state.workspace);
            checkApprovals(state, revision);
            if (state.definition.merge) {
              state.result = { summary: visit.verdict.summary,
                commit: mergeWorkspace(state.workspace, revision, workflowCommitTitle(state, revision)) };
            } else state.result = report ?? visit.verdict;
            state.status = 'succeeded';
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
              state.status = 'failed';
              state.error = `Не найден участник workflow ${next}.`;
            });
            continue;
          }
          const revision = snapshot(state.workspace);
          const participant = steered?.participant ?? next;
          const sessionId = steering ? steered?.sessionId ?? state.sessions[participant] ?? 'ses_' + randomUUID()
            : state.participants?.[next]?.memory === false ? 'ses_' + randomUUID()
              : state.sessions[participant] ?? 'ses_' + randomUUID();
          const inputId = 'msg_' + randomUUID();
          const workspace = node.role === 'verifier' ? verificationWorkspace(root, id, state.workspace, revision, inputId) : state.workspace;
          // A reviewer session from an older release lacks permission to read review artifacts.
          const earlierReview = state.visits.find(item => item.node === next);
          const review = node.role === 'reviewer' && state.workspace.mode !== 'directory' && (!earlierReview || earlierReview.review) ? writeReviewDiff(state.workspace, revision,
            join(root, 'workflows', id, 'reviews', `${inputId}.diff`)) : undefined;
          visit = { node: next, participant, sessionId, inputId, revision, startedAt: Date.now(),
            admissionStarted: false,
            ...(steered?.item ? { item: steered.item } : {}),
            ...(node.role === 'verifier' ? { workspace } : {}),
            ...(review ? { review } : {}),
            prompt: rolePrompt(state.definition, next, visit?.verdict, revision, state.visits, Boolean(state.roleAgents), review, workspace) };
          if (steering) {
            if (steered?.item) visit.prompt += `\n\nЭлемент параллельной группы:\n${JSON.stringify(steered.item)}`;
            visit.prompt += `\n\nУточнение пользователя для этого участника:\n${steering.text}`;
            visit.steering = steering.id;
            steering.status = 'delivered';
          }
          state.visits.push(visit);
          save(false);
        }
      }
      if (admissionStage(visit) === 'prepared') {
        await withWorkflowAction(root, state, owner, () => {
          if (state.controls?.some(command => command.status === 'pending' && command.kind === 'stop')) {
            state.visits.pop();
            return;
          }
          const steering = state.controls?.find(command => command.status === 'pending' && command.kind === 'steer');
          if (steering && !visit.steering) {
            const child = visit.children?.find(item => item.participant === steering.node);
            if (!child) {
              for (const command of state.controls ?? []) {
                const target = visit.children?.find(item => item.participant === command.node);
                if (command.kind === 'steer' && command.status === 'pending' && target) {
                  command.target ??= { node: target.node, participant: target.participant,
                    ...(target.item ? { item: target.item } : {}) };
                }
              }
              state.visits.pop();
              return;
            }
            child.prompt += `\n\nУточнение пользователя для этого участника:\n${steering.text}`;
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
        const awaitingAdmission = visit.children.filter(child => admissionStage(child, visit) === 'admission_started');
        // The group's barrier and each child's acknowledgement are separate facts.
        // Saved verdicts/errors are terminal even in older records without admitted.
        if (admissionStage(visit) === 'admission_started' || awaitingAdmission.length) {
          await withWorkflowAction(root, state, owner, async () => {
            if (state.controls?.some(command => command.status === 'pending' && command.kind === 'stop')) return;
            await Promise.all(awaitingAdmission.map(async child => {
              try {
                await admit(client, request(state, child));
                child.admitted = true;
                state.sessions[child.participant] = child.sessionId;
              }
              catch (error) {
                if (error.publicMessage) child.error = error.publicMessage;
                else state.service = 'unavailable';
              }
            }));
            visit.admitted = visit.children.every(child => ['admitted', 'finished'].includes(admissionStage(child, visit)));
          });
          if (admissionStage(visit) !== 'admitted') { client = undefined; await pause(300); continue; }
        }
        if (!acknowledged) { acknowledge(); acknowledged = true; }
        const active = visit.children.filter(child => admissionStage(child, visit) === 'admitted');
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
        if (visit.children.every(child => admissionStage(child, visit) === 'finished')) {
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
            await admit(client, request(state, visit));
            visit.admitted = true;
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
        if (!state.controls?.some(command => command.kind === 'steer' && command.status === 'pending')) throw error;
        visit.verdict = { outcome: 'blocked', summary: error.publicMessage };
      }
      if (visit.steering) state.controls.find(command => command.id === visit.steering).status = 'applied';
      if (visit.verdict?.outcome === 'blocked' && !state.controls?.some(command => command.status === 'pending')) throw publicError(visit.verdict.summary);
      save(false);
    } catch (error) {
      if (error.code === 'DWF_OWNER_LOST') break;
      try {
        await withWorkflowAction(root, state, owner, () => {
          if (state.controls?.some(command => command.kind === 'stop' && command.status === 'pending')) {
            state.service = 'unavailable';
            return;
          }
          if (state.controls?.some(command => command.kind === 'steer' && command.status === 'pending')) {
            const visit = state.visits.at(-1);
            if (visit && !visit.verdict) visit.verdict = { outcome: visit.children ? 'failed' : 'blocked',
              summary: error.publicMessage ?? 'Выполнение этапа прервано уточнением.' };
            return;
          }
          state.status = 'failed';
          state.error = error.publicMessage ?? 'Контроллер workflow завершился с ошибкой. Рабочее дерево сохранено.';
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
