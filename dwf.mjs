#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createRun, getRun, markAdmitted, publicError, publicOutcome, saveOutcome,
  createWorkflow, getWorkflow, savePreset, presets, queueWorkflowCommand } from './run-store.mjs';
import { admit, checkModel, checkRoleAgents, connect, readOutcome, sessionRequest } from './opencode-runtime.mjs';
import { validateWorkflow, outcomes, groupOutcomes, roleTools, roleAgents, rolePermissions, participantSettings, participantAgent } from './workflow-definition.mjs';
import { ensureWorkflowRunner, publicWorkflow, watchEvent } from './workflow-runtime.mjs';
import { prepareWorkspace } from './workflow-git.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => process.stdout.write(JSON.stringify(value) + '\n');
function parse(text, message) {
  try { return JSON.parse(text); } catch { throw publicError(message); }
}
function stateRoot() {
  const directory = process.env.DWF_STATE_DIR ?? join(homedir(), '.dwf');
  if (!isAbsolute(directory)) throw publicError('DWF_STATE_DIR должен быть абсолютным путём.');
  return resolve(directory);
}
async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}
async function start(workflowFile, supplied) {
  const workflow = supplied ?? parse(await readFile(workflowFile, 'utf8'), 'Файл workflow содержит неверный JSON.');
  const graph = object(workflow) && Object.hasOwn(workflow, 'nodes');
  if (graph) validateWorkflow(workflow);
  else if (!object(workflow) || Object.keys(workflow).length !== 1 || !object(workflow.planner) ||
    Object.keys(workflow.planner).length !== 1 || typeof workflow.planner.task !== 'string' || !workflow.planner.task.trim()) {
    throw publicError('Ожидается workflow {"planner":{"task":"непустое поручение"}}.');
  }
  const usesDefaultModel = !graph || Object.keys(workflow.nodes).some(name => !participantSettings(workflow, name).model);
  const selected = parse(usesDefaultModel ? process.env.DWF_PLANNER_MODEL ?? '{"provider":"openai","modelId":"gpt-6.1-sol-ultrafast"}'
    : '{"provider":"openai","modelId":"gpt-6.1-sol-ultrafast"}',
    'Задайте DWF_PLANNER_MODEL как JSON с provider и modelId.');
  if (!object(selected) || typeof selected.provider !== 'string' || !selected.provider.trim() ||
    typeof selected.modelId !== 'string' || !selected.modelId.trim() || Object.keys(selected).some(key => !['provider', 'modelId'].includes(key))) {
    throw publicError('DWF_PLANNER_MODEL требует непустые строки provider и modelId.');
  }
  const root = await canonical(stateRoot());
  const workspace = await realpath(process.cwd());
  const inside = relative(workspace, root);
  if (!inside || inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) {
    throw publicError('Каталог состояния должен находиться вне рабочего проекта.');
  }
  process.umask(0o077);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const participants = graph ? Object.fromEntries(Object.entries(workflow.nodes).map(([name, node]) => {
    const settings = participantSettings(workflow, name);
    return [name, { ...participantAgent(node.role, settings), memory: settings.memory }];
  })) : undefined;
  const client = await connect(root, participants);
  const model = graph ? { providerID: selected.provider, id: selected.modelId,
    variant: process.env.DWF_PLANNER_REASONING ?? 'high' } :
    await checkModel(client, workspace, selected, process.env.DWF_PLANNER_REASONING ?? 'high');
  const id = randomUUID();
  if (graph) {
    for (const [name, node] of Object.entries(workflow.nodes)) {
      const settings = participantSettings(workflow, name);
      const selectedModel = settings.model ?? selected;
      const reasoning = settings.reasoning === null ? undefined : settings.reasoning ?? model.variant;
      participants[name].model = await checkModel(client, workspace, selectedModel, reasoning);
    }
    await checkRoleAgents(client, workspace, Object.fromEntries(Object.entries(participants).map(([name, item]) => [name, item.id])));
    const working = prepareWorkspace(root, workspace, id, workflow.workspace);
    createWorkflow(root, { id, definition: workflow, model, workspace: working, roleAgents,
      participants,
      rolePermissions: Object.fromEntries(Object.keys(roleAgents).map(role => [role, rolePermissions(role)])),
      status: 'running', sessions: {}, visits: [] });
    await ensureWorkflowRunner(root, id);
    json({ runId: id });
    return;
  }
  const run = { id, sessionId: `ses_${randomUUID()}`, inputId: `msg_${randomUUID()}`,
    request: sessionRequest(workspace, model, id, workflow.planner.task) };
  await checkRoleAgents(client, workspace, { planner: run.request.session.agent });
  createRun(root, run);
  await admit(client, run);
  markAdmitted(root, id);
  json({ runId: id });
}
async function inspect(runId) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId ?? '')) {
    throw publicError('Неверный идентификатор запуска.');
  }
  const root = stateRoot();
  const workflow = getWorkflow(root, runId);
  if (workflow) {
    if (workflow.status === 'running') await ensureWorkflowRunner(root, runId);
    return publicWorkflow(getWorkflow(root, runId));
  }
  let run = getRun(root, runId);
  if (!run) throw publicError('Запуск не найден в состоянии DWF.');
  if (run.status === 'running') {
    let outcome;
    try {
      const client = await connect(root);
      if (!run.admitted) {
        await admit(client, run);
      }
      outcome = await readOutcome(client, run);
    } catch (error) {
      return { ...publicOutcome(run), service: { status: 'unavailable',
        message: error.publicMessage ?? 'Не удалось уточнить состояние через OpenCode. Возвращено последнее сохранённое состояние.' } };
    }
    if (!run.admitted) markAdmitted(root, runId);
    if (outcome) {
      saveOutcome(root, runId, outcome);
      run = getRun(root, runId);
    }
  }
  return publicOutcome(run);
}

async function watch(runId) {
  let previous;
  while (true) {
    const state = await inspect(runId);
    const event = watchEvent(previous, state);
    if (event) json(event);
    previous = state;
    if (state.status !== 'running') return;
    await pause(500);
  }
}

async function control(runId, kind, node, file) {
  const root = stateRoot();
  const command = queueWorkflowCommand(root, runId, kind, node,
    file ? await readFile(file, 'utf8') : undefined);
  await ensureWorkflowRunner(root, runId);
  if (kind === 'steer') {
    json({ runId, command });
    return;
  }
  while (true) {
    const state = await inspect(runId);
    if (state.status !== 'running') { json(state); return; }
    await pause(200);
  }
}

async function startPreset(name, taskFile) {
  if (!taskFile) throw publicError('Использование: dwf start --preset <имя> --task-file <файл задания>');
  const task = await readFile(taskFile, 'utf8');
  const definition = presets(stateRoot()).find(item => item.name === name)?.definition;
  if (!definition) throw publicError('Пресет не найден.');
  await start(null, { ...definition, task });
}

async function presetCommand(args) {
  if (args.length === 1 && args[0] === 'list') {
    json({ presets: presets(stateRoot()).map(item => item.name) });
    return;
  }
  if (args.length !== 4 || args[0] !== 'save' || args[2] !== '--file' ||
    !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(args[1])) {
    throw publicError('Использование: dwf preset list | dwf preset save <имя> --file <workflow.json>.');
  }
  const definition = validateWorkflow(parse(await readFile(args[3], 'utf8'), 'Неверный JSON workflow.'));
  const root = stateRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  savePreset(root, args[1], definition);
  json({ preset: args[1] });
}
const [command, ...args] = process.argv.slice(2);
const usage = {
  start: ['dwf start --file workflow.json', 'dwf start --preset <имя> --task-file <файл задания>',
    'Запускает workflow в текущем проекте и возвращает runId.'],
  inspect: ['dwf inspect <run-id> [--watch]',
    'Без --watch возвращает один JSON. С --watch выводит JSON-события snapshot/update до завершения.',
    'Закрытие наблюдения оставляет workflow работающим.'],
  schema: ['dwf schema', 'Показывает формат workflow, роли и результаты переходов.'],
  preset: ['dwf preset list', 'dwf preset save <имя> --file workflow.json'],
  steer: ['dwf steer <run-id> <участник> --message-file <файл>', 'Передаёт уточнение участнику на границе ответа.'],
  stop: ['dwf stop <run-id>', 'Останавливает workflow и возвращает подтверждённое терминальное состояние.'],
};
try {
  if (['--help', '-h'].includes(command) && args.length === 0) {
    process.stdout.write([
      'DWF — независимое исполнение поручений',
      '',
      'Workflow из ролей worker, reviewer, verifier, orchestrator.',
      '  dwf start --file workflow.json',
      '  dwf start --preset <имя> --task-file <файл задания>',
      '  dwf inspect <run-id> [--watch]',
      '  dwf steer <run-id> <участник> --message-file <файл>',
      '  dwf stop <run-id>',
      '  dwf schema',
      '  dwf preset list',
      '  dwf preset save <имя> --file workflow.json',
      '',
      'Прежний формат одного планнера также поддерживается.',
      '  {"planner":{"task":"Поручение с контекстом"}}',
      '',
      'start возвращает runId. inspect возвращает состояние и готовый результат.',
      'inspect --watch выводит полный snapshot при подключении и завершении, между ними — компактные update.',
      'Команда schema показывает пример ролей и переходов.',
      '',
    ].join('\n'));
  } else if (Object.hasOwn(usage, command) && args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(usage[command].join('\n') + '\n');
  } else if (command === 'preset' && ['list', 'save'].includes(args[0]) && args.length === 2 && ['--help', '-h'].includes(args[1])) {
    process.stdout.write(usage.preset.join('\n') + '\n');
  } else if (command === 'start' && args.length === 2 && args[0] === '--file') await start(args[1]);
  else if (command === 'start' && args.length === 4 && args[0] === '--preset' && args[2] === '--task-file') await startPreset(args[1], args[3]);
  else if (command === 'inspect' && args.length === 1) json(await inspect(args[0]));
  else if (command === 'inspect' && args.length === 2 && args[1] === '--watch') await watch(args[0]);
  else if (command === 'stop' && args.length === 1) await control(args[0], 'stop');
  else if (command === 'steer' && args.length === 4 && args[2] === '--message-file') await control(args[0], 'steer', args[1], args[3]);
  else if (command === 'schema' && args.length === 0) json({ example: {
    task: 'Поручение и критерии готовности', entry: 'execute',
    nodes: { execute: { role: 'worker' } }, transitions: { execute: { done: null } },
  },
    roles: outcomes, tools: roleTools,
    settings: ['model', 'reasoning', 'tools', 'skills', 'memory'],
    groups: { fixed: { members: ['participantOne', 'participantTwo'], required: ['participantOne', 'participantTwo'] },
      map: { member: 'participant', itemsFrom: 'planningParticipant' },
      items: [{ id: 'uniqueItem', task: 'Task for this participant' }], outcomes: groupOutcomes },
    workspace: ['worktree', 'directory'], terminal: 'null',
    merge: 'true — локальный merge проверенной версии в исходную ветку' });
  else if (command === 'preset') await presetCommand(args);
  else throw publicError('Справка: dwf --help');
} catch (error) {
  process.stderr.write((error.publicMessage ?? 'Не удалось прочитать или выполнить запуск. Проверьте конфигурацию и данные.') + '\n');
  process.exitCode = 1;
}
