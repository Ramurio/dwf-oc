import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, open, link, unlink, rename, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode, isSessionNotFoundError } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { publicError, withServiceLock } from './run-store.mjs';
import { roleAgents, rolePermissions, roleSystemPrompt, participantVisits } from './workflow-definition.mjs';
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

async function serviceConfig(directory, participants = {}) {
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
  const skillNames = new Set([...bundledSkills.map(skill => skill.name), 'tdd', 'diagnosing-bugs', 'codebase-design']);
  const skillIds = new Set();
  for (const source of skillDirectories) {
    const ids = await readdir(source).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const id of ids) {
      if (skillNames.has(id.match(/^dwf-(.+)-[a-f0-9]{16}$/)?.[1])) skillIds.add(id);
    }
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
      { mode: 'primary', system: roleSystemPrompt(role), permissions: rolePermissions(role) }])),
    ...Object.fromEntries(Object.values(participants).map(item => [item.id, item.agent])) };
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
    const pluginReady = !client.dwfProfile || (await client.plugin.list({ location: { directory: workspace } }))
      .data.some(plugin => plugin.id === 'dwf.role-tools' && plugin.state.status === 'active');
    const ready = pluginReady && Object.values(agents).every(id => available.data.some(agent => agent.id === id && agent.system));
    if (ready) {
      const expected = Object.entries(agents).flatMap(([role, id]) =>
        id === (role === 'planner' ? plannerId : roleAgents[role]) ? roleSkills[role] ?? [] : []);
      if (expected.length === 0) return;
      const skills = await client.skill.list({ location: { directory: workspace } });
      if (expected.every(item => skills.data.some(skill =>
        skill.id === item.id && skill.content.trim() === item.body))) return;
    }
    if (Date.now() >= deadline) throw publicError('OpenCode не загрузил промпты, скиллы или инструменты DWF. Проверь плагины и файловый наблюдатель общего профиля.');
    await pause(100);
  }
}

async function connectLegacy(root, participants, launch) {
  const directory = join(root, 'opencode');
  const state = join(directory, 'state');
  const registration = join(state, 'opencode', 'service.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withServiceLock(root, async () => {
    const config = await serviceConfig(directory, participants);
    const env = { ...launch.env, OPENCODE_CONFIG_DIR: join(directory, 'config'),
      XDG_CONFIG_HOME: join(directory, 'xdg-config'), XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: state,
      OPENCODE_DB: join(directory, 'opencode.sqlite'), OPENCODE_CONFIG: '',
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_DISABLE_FILEWATCHER: 'false',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, update: 'disable', snapshots: false,
        mcp: { servers: {} }, agents: { ...config.agents, 'dwf-planner': planner } }) };
    const port = env.DWF_OPENCODE_PORT ?? process.env.DWF_OPENCODE_PORT ?? '0';
    if (!/^\d+$/.test(port) || Number(port) > 65535) throw publicError('Неверный внутренний порт сервиса.');
    // Refuse replacement even if a live service reports a different version than its registration.
    const endpoint = await Service.ensure({ file: registration, version: OPENCODE_VERSION,
      command: [...launch.commandPrefix ?? [], executable, 'serve', '--service', '--hostname', '127.0.0.1', '--port', port], env,
      onStart(reason) {
        if (reason === 'version-mismatch') throw publicError('Версия общего сервиса OpenCode отличается. Требуется явное обновление.');
      } });
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
    return client;
  });
}

export function openCodeProfile(env = process.env) {
  const home = env.HOME || homedir();
  const paths = {
    HOME: home,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || join(home, '.config'),
    XDG_DATA_HOME: env.XDG_DATA_HOME || join(home, '.local', 'share'),
    XDG_CACHE_HOME: env.XDG_CACHE_HOME || join(home, '.cache'),
    XDG_STATE_HOME: env.XDG_STATE_HOME || join(home, '.local', 'state'),
  };
  paths.OPENCODE_CONFIG_DIR = env.OPENCODE_CONFIG_DIR || join(paths.XDG_CONFIG_HOME, 'opencode');
  for (const key of ['OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_TEST_HOME']) {
    if (env[key]) paths[key] = env[key];
  }
  return { registration: join(paths.XDG_STATE_HOME, 'opencode', 'service.json'),
    configDirectory: paths.OPENCODE_CONFIG_DIR, env: paths };
}

async function sharedAgents(directory, participants = {}) {
  const agents = { [plannerId]: planner,
    ...Object.fromEntries(Object.entries(roleAgents).map(([role, id]) => [id,
      { mode: 'primary', system: roleSystemPrompt(role), permissions: rolePermissions(role) }])),
    ...Object.fromEntries(Object.values(participants).map(item => [item.id, item.agent])) };
  const agentDirectory = join(directory, 'agents');
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  for (const [id, { system, ...agent }] of Object.entries(agents)) {
    // Native agent files avoid changing the user's providers, plugins and policies.
    await writeOnce(join(agentDirectory, `${id}.md`),
      `---\n${JSON.stringify({ ...agent, hidden: true })}\n---\n${system}\n`);
  }
  for (const skill of bundledSkills) {
    const target = join(directory, 'skills', skill.id);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeOnce(join(target, 'SKILL.md'), skill.content);
  }
  const plugins = join(directory, 'plugins');
  await mkdir(plugins, { recursive: true, mode: 0o700 });
  const filename = join(plugins, 'dwf-tools.js');
  const content = await readFile(new URL('./opencode-tools.mjs', import.meta.url), 'utf8');
  const previous = await readFile(filename, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (content !== previous) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeOnce(temporary, content);
    await rename(temporary, filename);
  }
}

export async function connect(root, participants, launch = {}) {
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
  if (version !== `opencode v${OPENCODE_VERSION}`) throw publicError('Установленная версия OpenCode несовместима с DWF.');
  // Older runs keep their original database and sessions until they finish.
  if (launch.profile === 'legacy') return connectLegacy(root, participants, launch);
  const profile = launch.profile ?? openCodeProfile({ ...process.env, ...launch.env });
  const lock = join(dirname(profile.registration), 'dwf');
  await mkdir(lock, { recursive: true, mode: 0o700 });
  return withServiceLock(lock, async () => {
    await sharedAgents(profile.configDirectory, participants);
    const port = launch.env?.DWF_OPENCODE_PORT ?? process.env.DWF_OPENCODE_PORT ?? '0';
    if (!/^\d+$/.test(port) || Number(port) > 65535) throw publicError('Неверный внутренний порт сервиса.');
    const endpoint = await Service.ensure({ file: profile.registration, version: OPENCODE_VERSION,
      command: [...launch.commandPrefix ?? [], executable, 'serve', '--service', '--hostname', '127.0.0.1', '--port', port],
      env: { ...launch.env, ...profile.env, OPENCODE_DISABLE_AUTOUPDATE: 'true' },
      onStart(reason) {
        if (reason === 'version-mismatch') throw publicError('Версия общего сервиса OpenCode отличается. Требуется явное обновление.');
      } });
    return Object.assign(OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }),
      { dwfProfile: profile });
  });
}

export async function checkModel(client, workspace, selected, reasoning) {
  const models = await client.model.list({ location: { directory: workspace } });
  const name = `${selected.provider}/${selected.modelId}`;
  const model = models.data.find(item => item.providerID === selected.provider && item.id === selected.modelId);
  if (!model) throw publicError(`Модель ${name} отсутствует в общем каталоге OpenCode. Проверь opencode models и opencode auth list.`);
  if (!model.enabled) throw publicError(`Модель ${name} отключена в общем профиле OpenCode. Проверь opencode auth list.`);
  if (reasoning !== undefined && !model.variants.some(item => item.id === reasoning)) {
    throw publicError(`Модель ${name} не поддерживает reasoning ${reasoning}. Доступны ${model.variants.map(item => item.id).join(', ')}.`);
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
  // Sessions keep their create-time permissions. Reentry (including an older
  // raw-only session) must be able to read the new saved context documents.
  // Preserve every existing rule; add only DWF's generated artifact directories.
  const permissionKey = async rule => {
    const resource = rule.action === 'external_directory' && rule.resource.endsWith('/*')
      ? join(await realpath(dirname(rule.resource)).catch(() => dirname(rule.resource)), '*') : rule.resource;
    return JSON.stringify([rule.action, resource, rule.effect]);
  };
  const existing = new Set(await Promise.all((session.permissions ?? []).map(permissionKey)));
  const missing = [];
  for (const grant of run.artifactPermissions ?? []) {
    if (!existing.has(await permissionKey(grant))) missing.push(grant);
  }
  if (missing.length) {
    await client.session.update({ sessionID: run.sessionId,
      permissions: [...(session.permissions ?? []), ...missing] });
  }
  if (session.location && session.location.directory !== run.request.session.location.directory) {
    await client.session.move({ sessionID: run.sessionId, directory: run.request.session.location.directory });
  }
  // The native inbox reconciles the persisted ID both before and after promotion to history.
  await client.session.prompt({ sessionID: run.sessionId, id: run.inputId, text: run.request.text });
}

function shellProcesses() {
  return execFileSync('ps', ['-ax', '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8' })
    .trim().split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return match && !match[3].startsWith('Z')
        ? [{ pid: Number(match[1]), group: Number(match[2]), started: match[4] }] : [];
    });
}

export async function captureStopSessions(client, state) {
  const visits = participantVisits(state.visits);
  const sessions = new Set(visits.map(visit => visit.sessionId));
  const directories = new Set([state.workspace.path, ...visits.map(visit => visit.workspace?.path).filter(Boolean)]);
  state.stopShells ??= [];
  for (const directory of directories) {
    const shells = await client.shell.list({ location: { directory } });
    const processes = shellProcesses();
    for (const shell of shells.data.filter(shell => sessions.has(shell.metadata?.sessionID))) {
      const process = processes.find(item => item.pid === shell.pid) ??
        (processes.some(item => item.group === shell.pid) ? { pid: shell.pid, group: shell.pid } : undefined);
      if (process && !state.stopShells.some(item => item.id === shell.id)) {
        state.stopShells.push({ id: shell.id, directory, ...process });
      }
    }
  }
}

async function stopShellProcess(target) {
  const live = () => {
    const processes = shellProcesses();
    const leader = processes.find(item => item.pid === target.pid);
    if (leader && leader.started !== target.started) return [];
    return target.group === target.pid ? processes.filter(item => item.group === target.group)
      : processes.filter(item => item.pid === target.pid);
  };
  if (!live().length) return;
  const pid = target.group === target.pid ? -target.pid : target.pid;
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await pause(150);
  if (!live().length) return;
  try { process.kill(pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!live().length) return;
    await pause(100);
  }
  throw publicError('Не удалось подтвердить завершение процесса участника. Остановка будет повторена.');
}

export async function interruptSessions(client, state) {
  const visits = participantVisits(state.visits);
  const sessions = new Set(visits.map(visit => visit.sessionId));
  for (const sessionID of sessions) {
    try {
      const session = await client.session.get({ sessionID });
      if (session.metadata?.dwfRunId !== state.id) throw publicError('Сессия остановки принадлежит другому запуску.');
      for (const input of await client.session.inbox.list({ sessionID })) {
        await client.session.inbox.cancel({ sessionID, inboxID: input.id });
      }
      await client.session.interrupt({ sessionID, resume: false });
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
    }
  }
}

export async function stopSessions(client, state) {
  await interruptSessions(client, state);
  await captureStopSessions(client, state);
  // Terminate before removing native records, so interrupted cleanup remains retryable.
  for (const target of state.stopShells ?? []) await stopShellProcess(target);
  const visits = participantVisits(state.visits);
  const sessions = new Set(visits.map(visit => visit.sessionId));
  const directories = new Set([state.workspace.path, ...visits.map(visit => visit.workspace?.path).filter(Boolean)]);
  for (const directory of directories) {
    const location = { directory };
    const shells = await client.shell.list({ location });
    for (const shell of shells.data) {
      if (shell.status === 'running' && sessions.has(shell.metadata?.sessionID)) {
        await client.shell.remove({ id: shell.id, location });
      }
    }
  }
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
    if (outcome?.status === 'succeeded') {
      const [active, inbox] = await Promise.all([
        client.session.active(), client.session.inbox.list({ sessionID: run.sessionId }),
      ]);
      if (active[run.sessionId] || inbox.length) outcome = undefined;
    }
    if (client.shell) {
      const shells = await client.shell.list({ location: run.request.session.location });
      const owned = shells.data.filter(shell => shell.metadata?.sessionID === run.sessionId);
      const processes = owned.some(shell => shell.pid) ? shellProcesses() : [];
      if (owned.some(shell => shell.status === 'running' || processes.some(item => item.group === shell.pid ||
        item.pid === shell.pid && Math.abs(Date.parse(item.started) - shell.time.started) < 5000))) {
        outcome = undefined;
      }
    }
    if (outcome?.status === 'succeeded') {
      const latest = await readMessages(client, run.sessionId);
      const checked = outcomeFromMessages(latest, run.inputId);
      if (JSON.stringify(checked) !== JSON.stringify(outcome)) outcome = undefined;
      messages = latest;
    }
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
  let result;
  const parts = [];
  for (const message of messages.slice(start + 1)) {
    if (message.type === 'user') {
      if (result) return result;
      throw publicError('До завершения исходного поручения появился неподдерживаемый следующий ввод.');
    }
    if (result && ['assistant', 'synthetic'].includes(message.type)) {
      answer = undefined;
      result = undefined;
      parts.length = 0;
    }
    if (message.type === 'assistant') {
      answer = message;
      if (message.error || !['stop', 'length'].includes(message.finish)) parts.length = 0;
      else parts.push(...message.content.filter(block => block.type === 'text').map(block => block.text));
    }
    if (message.type !== 'idle') continue;
    if (message.outcome !== 'succeeded') {
      result = { status: 'failed', error: message.outcome === 'interrupted'
        ? 'Поручение участника прервано.' : message.error?.type === 'output-limit'
          ? 'Ответ участника остался оборванным после штатных продолжений по лимиту длины.'
          : 'Модель завершила поручение с ошибкой.' };
      continue;
    }
    if (!answer || answer.finish !== 'stop' || answer.time.completed === undefined || answer.error) {
      result = { status: 'failed', error: 'Участник не завершил текстовый ответ нормально.' };
      continue;
    }
    const text = parts.join('');
    result = text.trim() ? { status: 'succeeded', result: text, answerId: answer.id }
      : { status: 'failed', error: 'Участник не вернул текстовый результат.' };
  }
  return result;
}
