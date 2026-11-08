import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, open, link, unlink, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode, isSessionNotFoundError } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { publicError, withServiceLock } from './run-store.mjs';
import { roleAgents, rolePermissions, roleSystemPrompt } from './workflow-definition.mjs';
import { roleSkills, bundledSkills } from './role-skills.mjs';

export const OPENCODE_VERSION = '2.2.5';
const executable = fileURLToPath(new URL('./node_modules/.bin/opencode', import.meta.url));
const instructions = 'Prepare a written plan for the assigned task. Distinguish agreed requirements from proposals. Preserve project files.';
const planner = { mode: 'primary', system: instructions,
  permissions: rolePermissions('planner') };
const plannerId = `dwf-planner-${createHash('sha256').update(JSON.stringify(planner)).digest('hex').slice(0, 16)}`;
const disabledPlugins = [
  '-opencode.tools', '-opencode.skill', '-opencode.config.compatibility',
];
const enabledPlugins = ['opencode.config.skill', 'opencode.tool.skill'];
const managedPlugins = [...disabledPlugins, ...enabledPlugins];
const isManagedPlugin = plugin => typeof plugin === 'string' &&
  managedPlugins.some(entry => entry.replace(/^-/, '') === plugin.replace(/^-/, ''));

async function writeOnce(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
    await file.close();
    try { await link(temporary, filename); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally {
    await file.close();
    await unlink(temporary);
  }
}

async function serviceConfig(directory) {
  const configDirectory = join(directory, 'config');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const skillDirectory = join(directory, 'skills');
  const skillDirectories = [join(directory, 'worker-skills'), skillDirectory];
  for (const skill of bundledSkills) {
    const target = join(skillDirectory, skill.id);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeOnce(join(target, 'SKILL.md'), skill.content);
  }
  // Retain immutable skill versions so sessions created by earlier releases can finish.
  const skillIds = new Set();
  for (const source of skillDirectories) {
    const ids = await readdir(source).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const id of ids) if (/^dwf-(code-work|tdd|diagnosing-bugs|codebase-design|code-review|code-verify|workflow-summary|task-planning)-[a-f0-9]{16}$/.test(id)) skillIds.add(id);
  }
  const skillPolicies = [{ action: 'skill.use', resource: '*', effect: 'deny' },
    ...[...skillIds].sort().map(id => ({ action: 'skill.use', resource: id, effect: 'allow' }))];
  const filename = join(configDirectory, 'dwf-profile.json');
  const supplied = { file: process.env.OPENCODE_CONFIG
    ? await readFile(process.env.OPENCODE_CONFIG, 'utf8') : null,
  content: process.env.OPENCODE_CONFIG_CONTENT ?? null };
  await writeOnce(filename, JSON.stringify(supplied));
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  if (Object.keys(supplied).some(key => supplied[key] !== null && supplied[key] !== saved[key])) {
    throw publicError('Общий сервис DWF уже настроен с другим OPENCODE_CONFIG. Его конфигурация не изменена.');
  }
  // Preserve native JSONC syntax; the native config loader parses this file.
  if (saved.file !== null) {
    await writeOnce(join(configDirectory, 'opencode.jsonc'), saved.file);
  }
  // Keep versioned agents so an existing run retains its original system prompt.
  const agentsFile = join(configDirectory, 'opencode.json');
  let managed = {};
  try { managed = JSON.parse(await readFile(agentsFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const agents = { [plannerId]: planner,
    ...Object.fromEntries(Object.entries(roleAgents).map(([role, id]) => [id,
      { mode: 'primary', system: roleSystemPrompt(role), permissions: rolePermissions(role) }])) };
  const content = JSON.stringify({ ...managed,
    skills: skillDirectories,
    policies: [...(managed.policies ?? []).filter(policy => policy.action !== 'skill.use'), ...skillPolicies],
    plugins: [...(managed.plugins ?? []).filter(plugin => !isManagedPlugin(plugin)), ...managedPlugins],
    agents: { ...managed.agents, ...agents } });
  if (content !== JSON.stringify(managed)) {
    const temporary = `${agentsFile}.${randomUUID()}.tmp`;
    try {
      await writeOnce(temporary, content);
      await rename(temporary, agentsFile);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  const config = saved.content ? JSON.parse(saved.content) : {};
  return { ...config, skills: skillDirectories,
    policies: [...(config.policies ?? []).filter(policy => policy.action !== 'skill.use'), ...skillPolicies],
    plugins: [...(config.plugins ?? []).filter(plugin => !isManagedPlugin(plugin)), ...managedPlugins] };
}

export async function checkRoleAgents(client, workspace, agents) {
  const deadline = Date.now() + 15000;
  while (true) {
    const available = await client.agent.list({ location: { directory: workspace } });
    const ready = Object.values(agents).every(id => available.data.some(agent => agent.id === id && agent.system));
    if (ready) {
      const expected = Object.entries(agents).flatMap(([role, id]) =>
        id === (role === 'planner' ? plannerId : roleAgents[role]) ? roleSkills[role] ?? [] : []);
      if (expected.length === 0) return;
      const skills = await client.skill.list({ location: { directory: workspace } });
      if (expected.every(item => skills.data.some(skill =>
        skill.id === item.id && skill.content.trim() === item.body))) return;
    }
    if (Date.now() >= deadline) throw publicError('OpenCode не загрузил промпты или скиллы DWF. Если сервис запущен старой версией DWF, перезапусти его после завершения активных запусков.');
    await pause(100);
  }
}

export async function connect(root) {
  const directory = join(root, 'opencode');
  const state = join(directory, 'state');
  const registration = join(state, 'opencode', 'service.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withServiceLock(root, async () => {
    const config = await serviceConfig(directory);
    const env = { OPENCODE_CONFIG_DIR: join(directory, 'config'),
      XDG_CONFIG_HOME: join(directory, 'xdg-config'), XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: state,
      OPENCODE_DB: join(directory, 'opencode.sqlite'), OPENCODE_CONFIG: '',
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, update: 'disable', snapshots: false,
        mcp: { servers: {} }, agents: { ...config.agents, 'dwf-planner': planner } }) };
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
    if (version !== `opencode v${OPENCODE_VERSION}`) throw publicError('Установленная версия OpenCode несовместима с DWF.');
    // Refuse replacement even if a live service reports a different version than its registration.
    const endpoint = await Service.ensure({ file: registration, version: OPENCODE_VERSION,
      command: [executable, 'serve', '--service', '--hostname', '127.0.0.1', '--port', '0'], env,
      onStart(reason) {
        if (reason === 'version-mismatch') throw publicError('Версия общего сервиса OpenCode отличается. Требуется явное обновление.');
      } });
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    return client;
  });
}

export async function checkModel(client, workspace, selected, reasoning) {
  const models = await client.model.list({ location: { directory: workspace } });
  const model = models.data.find(item => item.providerID === selected.provider && item.id === selected.modelId && item.enabled);
  if (!model) throw publicError('Выбранная модель отсутствует в каталоге OpenCode или недоступна.');
  if (reasoning !== undefined && !model.variants.some(item => item.id === reasoning)) {
    throw publicError('Выбранная модель не поддерживает DWF_PLANNER_REASONING; уровень не был изменён автоматически.');
  }
  return { providerID: selected.provider, id: selected.modelId,
    ...(reasoning === undefined ? {} : { variant: reasoning }) };
}

export async function admit(client, run) {
  let session;
  try { session = await client.session.get({ sessionID: run.sessionId }); }
  catch (error) {
    if (!isSessionNotFoundError(error)) throw error;
    try { session = await client.session.create({ id: run.sessionId, ...run.request.session }); }
    catch (createError) {
      // A concurrent observer may already have created this exact persisted session.
      session = await client.session.get({ sessionID: run.sessionId }).catch(() => { throw createError; });
    }
  }
  if (session.metadata?.dwfRunId !== run.id) throw publicError('Сессия OpenCode не принадлежит этому запуску DWF.');
  // The native inbox reconciles the persisted ID both before and after promotion to history.
  await client.session.prompt({ sessionID: run.sessionId, id: run.inputId, text: run.request.text });
}

export function sessionRequest(workspace, model, runId, task) {
  return { session: { title: `DWF planner ${runId}`, agent: plannerId, model,
    location: { directory: workspace }, metadata: { dwfRunId: runId },
    permissions: planner.permissions }, text: task };
}

async function readMessages(client, sessionId) {
  const messages = [];
  let cursor;
  do {
    // The cursor carries ordering; the API rejects an additional order parameter.
    const page = await client.message.list({ sessionID: sessionId, limit: 100,
      ...(cursor ? { cursor } : { order: 'asc' }) });
    messages.push(...page.data);
    if (page.data.length === 0) break;
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return messages;
}

export async function readOutcome(client, run) {
  return (await readExecution(client, run)).outcome;
}

export async function readExecution(client, run) {
  let messages = await readMessages(client, run.sessionId);
  let outcome = outcomeFromMessages(messages, run.inputId);
  // Pages are live: idle may appear after an earlier page captured a still-streaming answer.
  // Reading again after observing idle obtains the completed answer and all its text parts.
  if (outcome !== undefined) {
    messages = await readMessages(client, run.sessionId);
    outcome = outcomeFromMessages(messages, run.inputId);
  }
  return { outcome, progress: progressFromMessages(messages, run.inputId) };
}

export function progressFromMessages(messages, inputId) {
  const start = messages.findIndex(message => message.id === inputId && message.type === 'user');
  if (start < 0) return undefined;
  const progress = { startedAt: messages[start].time?.created };
  for (const message of messages.slice(start)) {
    if (message.type === 'user' && message.id !== inputId) break;
    const timestamps = Object.values(message.time ?? {}).filter(value => typeof value === 'number');
    if (timestamps.length) progress.updatedAt = Math.max(progress.updatedAt ?? 0, ...timestamps);
    if (message.type !== 'assistant') continue;
    const content = message.content ?? [];
    const text = content.filter(part => part.type === 'text').map(part => part.text).join('');
    if (text.trim() && message.finish !== 'stop') progress.message = text;
    const tools = content.filter(part => part.type === 'tool');
    if (tools.length) progress.tools = tools.map(tool => ({ name: tool.name, status: tool.state.status }));
    for (const tool of tools) {
      const times = Object.values(tool.time ?? {}).filter(value => typeof value === 'number');
      if (times.length) progress.updatedAt = Math.max(progress.updatedAt ?? 0, ...times);
    }
    if (message.retry) progress.retry = { attempt: message.retry.attempt, at: message.retry.at };
    else delete progress.retry;
  }
  return progress;
}

export function outcomeFromMessages(messages, inputId) {
  const start = messages.findIndex(item => item.id === inputId && item.type === 'user');
  if (start < 0) return undefined;
  let answer;
  const parts = [];
  for (const message of messages.slice(start + 1)) {
    if (message.type === 'user') throw publicError('До завершения исходного поручения появился неподдерживаемый следующий ввод.');
    if (message.type === 'assistant') {
      answer = message;
      if (message.error || !['stop', 'length'].includes(message.finish)) parts.length = 0;
      else parts.push(...message.content.filter(block => block.type === 'text').map(block => block.text));
    }
    if (message.type !== 'idle') continue;
    if (message.outcome !== 'succeeded') {
      return { status: 'failed', error: message.outcome === 'interrupted'
        ? 'Поручение участника прервано.' : message.error?.type === 'output-limit'
          ? 'Ответ участника остался оборванным после штатных продолжений по лимиту длины.'
          : 'Модель завершила поручение с ошибкой.' };
    }
    if (!answer || answer.finish !== 'stop' || answer.time.completed === undefined || answer.error) {
      return { status: 'failed', error: 'Участник не завершил текстовый ответ нормально.' };
    }
    const result = parts.join('');
    return result.trim() ? { status: 'succeeded', result, answerId: answer.id }
      : { status: 'failed', error: 'Участник не вернул текстовый результат.' };
  }
  return undefined;
}
