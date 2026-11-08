import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { admit, checkRoleAgents, connect, readExecution, stopSessions } from './opencode-runtime.mjs';
import { claimWorkflow, getWorkflow, updateWorkflow, workflowHasOwner, publicError } from './run-store.mjs';
import { parseVerdict, rolePermissions, rolePrompt, roleAgents, checkApprovals } from './workflow-definition.mjs';
import { mergeWorkspace, snapshot, writeReviewDiff } from './workflow-git.mjs';

export function publicWorkflow(state) {
  const current = state.visits.at(-1);
  let result = state.result;
  if (state.status === 'succeeded' && result?.commit) {
    result = { ...result,
      integration: { status: 'merged', branch: state.workspace.branch, commit: result.commit },
      summary: `DWF подтвердил локальный merge в ${state.workspace.branch}. Коммит ${result.commit}.\n\nОтчёт участника до интеграции\n${result.summary}` };
  }
  return { runId: state.id, status: state.status, workspace: state.workspace.path,
    current: current && { node: current.node, role: state.definition.nodes[current.node].role,
      sessionId: current.sessionId, visit: state.visits.length,
      ...(current.startedAt ? { startedAt: current.startedAt } : {}),
      ...(current.progress ? { progress: current.progress } : {}) },
    history: state.visits.map(visit => ({ node: visit.node, sessionId: visit.sessionId,
      ...(visit.verdict ? { result: visit.verdict, revision: visit.revision } : {}) })),
    ...(state.controls ? { controls: state.controls } : {}),
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
  const permissions = participant?.agent.permissions ?? state.rolePermissions?.[node.role] ?? rolePermissions(node.role).filter(rule =>
    rule.action !== 'skill' || state.roleAgents?.[node.role] === roleAgents[node.role]);
  return { id: state.id, sessionId: visit.sessionId, inputId: visit.inputId,
    request: { text: visit.prompt, session: { title: `DWF ${node.role} ${visit.node}`,
      agent: participant?.id ?? state.roleAgents?.[node.role] ?? 'build', model: participant?.model ?? state.model, location: { directory: state.workspace.path },
      metadata: { dwfRunId: state.id },
      permissions: [...permissions, ...(visit.review ? [{ action: 'external_directory',
        resource: join(dirname(visit.review.path), '*'), effect: 'allow' }] : [])] } } };
}

export async function runWorkflow(root, id) {
  const owner = randomUUID();
  if (!claimWorkflow(root, id, owner)) {
    acknowledge();
    return;
  }
  let state = getWorkflow(root, id);
  const save = complete => updateWorkflow(root, state, owner, complete);
  try {
    if (state.status !== 'running') { save(true); acknowledge(); return; }
    let client = await connect(root, state.participants);
    if (state.roleAgents) await checkRoleAgents(client, state.workspace.path, state.roleAgents);
    let acknowledged = false;
    while (state.status === 'running') {
      save(false);
      const stop = state.controls?.find(command => command.kind === 'stop' && command.status === 'pending');
      if (stop) {
        try { await stopSessions(client, state); }
        catch (error) {
          if (error.publicMessage) throw error;
          state.service = 'unavailable';
          save(false);
          await pause(1000);
          try { client = await connect(root, state.participants); } catch { /* Retry this durable stop. */ }
          continue;
        }
        for (const command of state.controls) if (command.status === 'pending') command.status = 'cancelled';
        stop.status = 'applied';
        state.status = 'cancelled';
        delete state.service;
        save(true);
        break;
      }
      let visit = state.visits.at(-1);
      if (!visit || visit.verdict) {
        const steering = state.controls?.find(command => command.kind === 'steer' && command.status === 'pending');
        const next = steering?.node ?? (visit ? state.definition.transitions[visit.node][visit.verdict.outcome] : state.definition.entry);
        if (next === null) {
          if (!updateWorkflow(root, state, owner, false, true)) continue;
          const revision = snapshot(state.workspace);
          checkApprovals(state, revision);
          if (state.definition.merge) {
            state.result = { summary: visit.verdict.summary, commit: mergeWorkspace(state.workspace, revision) };
          } else state.result = visit.verdict;
          state.status = 'succeeded';
          save(true);
          break;
        }
        const node = state.definition.nodes[next];
        const revision = snapshot(state.workspace);
        if (!steering && state.participants?.[next]?.memory === false) delete state.sessions[next];
        state.sessions[next] ??= 'ses_' + randomUUID();
        const inputId = 'msg_' + randomUUID();
        // A reviewer session from an older release lacks permission to read review artifacts.
        const earlierReview = state.visits.find(item => item.node === next);
        const review = node.role === 'reviewer' && state.workspace.mode !== 'directory' && (!earlierReview || earlierReview.review) ? writeReviewDiff(state.workspace, revision,
          join(root, 'workflows', id, 'reviews', `${inputId}.diff`)) : undefined;
        visit = { node: next, sessionId: state.sessions[next], inputId, revision, startedAt: Date.now(),
          ...(review ? { review } : {}),
          prompt: rolePrompt(state.definition, next, visit?.verdict, revision, state.visits, Boolean(state.roleAgents), review, state.workspace) };
        if (steering) {
          visit.prompt += `\n\nУточнение пользователя для этого участника:\n${steering.text}`;
          visit.steering = steering.id;
          steering.status = 'delivered';
        }
        state.visits.push(visit);
        save(false);
      }
      if (!visit.admitted) {
        await admit(client, request(state, visit));
        visit.admitted = true;
        save(false);
      }
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
        try { client = await connect(root, state.participants); } catch { /* Retain the pending visit and retry service discovery. */ }
        continue;
      }
      delete state.service;
      if (!outcome) { await pause(300); continue; }
      if (outcome.status !== 'succeeded') throw publicError(outcome.error);
      const role = state.definition.nodes[visit.node].role;
      if (role !== 'worker' && snapshot(state.workspace) !== visit.revision) {
        throw publicError('Проверяющий участник изменил рабочее дерево. Требуется новая проверка.');
      }
      visit.verdict = parseVerdict(outcome.result, role);
      visit.revision = snapshot(state.workspace);
      if (visit.steering) state.controls.find(command => command.id === visit.steering).status = 'applied';
      if (visit.verdict.outcome === 'blocked') throw publicError(visit.verdict.summary);
      save(false);
    }
    if (!acknowledged) acknowledge();
  } catch (error) {
    state.status = 'failed';
    state.error = error.publicMessage ?? 'Контроллер workflow завершился с ошибкой. Рабочее дерево сохранено.';
    try { save(true); } catch { /* A replacement controller owns the current state. */ }
    acknowledge();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runWorkflow(process.argv[2], process.argv[3]);
}
