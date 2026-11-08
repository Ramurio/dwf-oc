import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, relative, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { OpenCode, ClientError, isSessionNotFoundError } from '@opencode/client';
import { Service } from '@opencode/client/service';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const executable = join(projectDirectory, 'node_modules/.bin/opencode');
const model = { providerID: 'openai', id: 'gpt-6.1-sol-ultrafast', variant: 'high' };
const version = '2.2.5';

async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

function git(project, args) {
  return execFileSync('git', args, { cwd: project, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

export async function createAttempt(root, project, prompt, stateDirectory) {
  if (!prompt.trim()) throw new Error('Поручение тестеру пустое.');
  const source = await realpath(git(project, ['rev-parse', '--show-toplevel']));
  const storageRoot = await canonical(resolve(root));
  const storagePath = relative(source, storageRoot);
  if (!storagePath || storagePath !== '..' && !storagePath.startsWith('..' + sep) && !isAbsolute(storagePath)) {
    throw new Error('Каталог проб должен находиться вне исходного проекта.');
  }
  if (git(source, ['status', '--porcelain'])) throw new Error('Для повторяемой пробы нужен чистый исходный проект.');
  const base = { source, branch: git(source, ['symbolic-ref', '--short', 'HEAD']),
    commit: git(source, ['rev-parse', 'HEAD']) };
  const directory = join(storageRoot, 'attempts', randomUUID());
  const workspace = join(directory, 'project');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', source, workspace],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  git(workspace, ['checkout', '--quiet', '-B', base.branch, base.commit]);
  git(workspace, ['remote', 'remove', 'origin']);
  const inherited = [];
  for (let parent = dirname(source); ; parent = dirname(parent)) {
    try { inherited.unshift(await readFile(join(parent, 'AGENTS.md'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(parent) === parent) break;
  }
  if (inherited.length) await writeFile(join(directory, 'AGENTS.md'), inherited.join('\n\n'), { mode: 0o600 });
  const attempt = { id: basename(directory), directory, workspace,
    root: storageRoot, stateDirectory: resolve(stateDirectory), base, model,
    sessionId: 'ses_' + randomUUID(), inputId: 'msg_' + randomUUID(), createdAt: Date.now(), prompt };
  await writeFile(join(directory, 'prompt.txt'), prompt, { mode: 0o600 });
  await save(join(directory, 'attempt.json'), attempt);
  return attempt;
}

function environment(profile, stateDirectory) {
  return { OPENCODE_CONFIG_DIR: join(profile, 'config'), OPENCODE_CONFIG: '',
    OPENCODE_DB: join(profile, 'opencode.sqlite'),
    XDG_CONFIG_HOME: join(profile, 'xdg-config'), XDG_DATA_HOME: join(profile, 'data'),
    XDG_CACHE_HOME: join(profile, 'cache'), XDG_STATE_HOME: join(profile, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', DWF_STATE_DIR: stateDirectory,
    PATH: join(projectDirectory, 'node_modules/.bin') + delimiter + (process.env.PATH ?? '') };
}

export async function authorizeTester(client, stateDirectory) {
  if ((await client.credential.list()).length !== 0) return;
  try {
    const credentials = JSON.parse(execFileSync(executable, ['auth', 'export', 'openai', '--standalone'],
      { env: { ...process.env, ...environment(join(stateDirectory, 'opencode'), stateDirectory) },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }));
    for (const credential of credentials.filter(item => item.active)) {
      await client.credential.create({ integrationID: credential.integrationID,
        label: credential.label, value: credential.value, activate: true });
    }
  } catch { throw new Error('Не удалось подключить существующий вход OpenCode к профилю тестера.'); }
}

export async function connectTester(root, stateDirectory, prepare = false, launch = {}) {
  const profile = join(root, 'opencode');
  const configDirectory = join(profile, 'config');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  try { await access(join(configDirectory, 'opencode.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; prepare = true; }
  if (prepare) {
    const skills = join(profile, 'skills');
    await cp(launch.skillDirectory ?? join(homedir(), '.codex/skills/dwf-oc'), join(skills, 'dwf-oc'), { recursive: true });
    await save(join(configDirectory, 'opencode.json'), { update: 'disable', snapshots: false,
      mcp: { servers: {} }, skills: [skills],
      plugins: ['-opencode.skill', '-opencode.config.compatibility', 'opencode.config.skill', 'opencode.tool.skill'],
      policies: [{ action: 'skill.use', resource: '*', effect: 'deny' },
        { action: 'skill.use', resource: 'dwf-oc', effect: 'allow' }] });
  }
  const endpoint = await Service.ensure({ file: join(profile, 'state/opencode/service.json'), version,
    command: [...launch.commandPrefix ?? [], executable, 'serve', '--service', '--hostname', '127.0.0.1', '--port', String(launch.port ?? 0)],
    env: { ...launch.env, ...environment(profile, stateDirectory),
      PATH: join(projectDirectory, 'node_modules/.bin') + delimiter + (launch.env?.PATH ?? process.env.PATH ?? '') },
    onStart(reason) { if (reason === 'version-mismatch') throw new Error('Версия OpenCode тестера изменилась.'); } });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  // Transfer through the native credential API without writing secrets to the test journal.
  if (launch.authorize !== false) await authorizeTester(client, launch.credentialStateDirectory ?? stateDirectory);
  return client;
}

export async function admitTester(client, attempt) {
  let session;
  try { session = await client.session.get({ sessionID: attempt.sessionId }); }
  catch (error) {
    if (!isSessionNotFoundError(error)) throw error;
    try {
      session = await client.session.create({ id: attempt.sessionId, title: `DWF tester ${attempt.id}`,
        agent: 'build', model: attempt.model, location: { directory: attempt.workspace },
        metadata: { testerAttemptId: attempt.id },
        permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    } catch (createError) {
      session = await client.session.get({ sessionID: attempt.sessionId }).catch(() => { throw createError; });
    }
  }
  if (session.metadata?.testerAttemptId !== attempt.id) throw new Error('Сессия принадлежит другой пробе.');
  await client.session.prompt({ sessionID: attempt.sessionId, id: attempt.inputId, text: attempt.prompt });
}

export async function checkTester(client, attempt) {
  const location = { directory: attempt.workspace };
  const available = await client.model.list({ location });
  if (!available.data.some(item => item.providerID === model.providerID && item.id === model.id &&
    item.enabled && item.variants.some(variant => variant.id === model.variant))) {
    throw new Error('Тестеру недоступна GPT-6.1 Sol Ultrafast с reasoning high.');
  }
  const deadline = Date.now() + 15000;
  for (;;) {
    const skills = await client.skill.list({ location });
    if (skills.data.some(skill => skill.id === 'dwf-oc')) {
      await save(join(attempt.directory, 'skills.json'), skills.data);
      return;
    }
    if (Date.now() >= deadline) throw new Error('OpenCode не загрузил скилл dwf-oc.');
    await pause(100);
  }
}

async function messagesFor(client, sessionId) {
  const messages = [];
  let cursor;
  do {
    const page = await client.message.list({ sessionID: sessionId, limit: 100,
      ...(cursor ? { cursor } : { order: 'asc' }) });
    messages.push(...page.data);
    cursor = page.data.length ? page.cursor.next : undefined;
  } while (cursor);
  return messages;
}

export function visibleMessages(messages) {
  return messages.map(message => message.type === 'assistant'
    ? { ...message, content: message.content.filter(part => part.type !== 'reasoning') } : message);
}

export function testerState(attempt, messages) {
  const start = messages.findIndex(message => message.type === 'user' && message.id === attempt.inputId);
  const turn = start < 0 ? [] : messages.slice(start + 1);
  const lastIdle = turn.findLastIndex(message => message.type === 'idle');
  const resumed = turn.slice(lastIdle + 1).some(message =>
    ['assistant', 'synthetic', 'user'].includes(message.type));
  const idle = resumed ? undefined : turn[lastIdle];
  const assistants = turn.filter(message => message.type === 'assistant');
  const last = assistants.at(-1);
  let report = '';
  for (const message of assistants) {
    if (message.error || !['stop', 'length'].includes(message.finish)) report = '';
    else report += message.content.filter(part => part.type === 'text').map(part => part.text).join('');
  }
  const tools = assistants.flatMap(message => message.content.filter(part => part.type === 'tool'));
  const incomplete = idle?.outcome === 'succeeded' &&
    (last?.finish !== 'stop' || last.time?.completed === undefined || last.error || !report.trim());
  return { attemptId: attempt.id, sessionId: attempt.sessionId, workspace: attempt.workspace,
    status: incomplete ? 'failed' : idle?.outcome ?? 'running', messageCount: messages.length,
    lastMessage: last?.id, lastTool: tools.at(-1)?.name, lastToolStatus: tools.at(-1)?.state.status,
    ...(idle ? { report, error: incomplete ? 'OpenCode завершил сессию без полного итогового отчёта.' : idle.error } : {}) };
}

export async function inspectTester(client, attempt) {
  let messages = await messagesFor(client, attempt.sessionId);
  let state = testerState(attempt, messages);
  if (state.status !== 'running') {
    messages = await messagesFor(client, attempt.sessionId);
    state = testerState(attempt, messages);
    if (messages.findLast(message => message.type === 'idle')?.outcome === 'succeeded') {
      const [shells, active, inbox] = await Promise.all([
        client.shell.list({ location: { directory: attempt.workspace } }),
        client.session.active(), client.session.inbox.list({ sessionID: attempt.sessionId }),
      ]);
      const pendingShells = shells.data.filter(shell =>
        shell.status === 'running' && shell.metadata.sessionID === attempt.sessionId).map(shell => shell.id);
      if (pendingShells.length || active[attempt.sessionId] || inbox.length) {
        state.status = 'running';
        state.pendingShells = pendingShells;
        delete state.report;
        delete state.error;
      }
    }
    if (state.status !== 'running') {
      messages = await messagesFor(client, attempt.sessionId);
      const latest = testerState(attempt, messages);
      if (JSON.stringify(latest) !== JSON.stringify(state)) {
        state = { ...latest, status: 'running' };
        delete state.report;
        delete state.error;
      }
    }
  }
  await save(join(attempt.directory, 'messages.json'), visibleMessages(messages));
  await save(join(attempt.directory, 'state.json'), state);
  if (state.report !== undefined) await writeFile(join(attempt.directory, 'report.md'), state.report, { mode: 0o600 });
  return state;
}

async function observe(attempt, watch) {
  let client = await connectTester(attempt.root, attempt.stateDirectory);
  await admitTester(client, attempt);
  let previous;
  while (true) {
    let state;
    try { state = await inspectTester(client, attempt); }
    catch (error) {
      if (!watch || !(error instanceof ClientError) || error.reason !== 'Transport') throw error;
      process.stderr.write('Наблюдение временно недоступно; переподключаюсь к той же сессии.\n');
      await pause(2000);
      client = await connectTester(attempt.root, attempt.stateDirectory);
      continue;
    }
    const output = JSON.stringify(state);
    if (output !== previous) process.stdout.write(output + '\n');
    previous = output;
    if (!watch || state.status !== 'running') return state;
    await pause(1000);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { project: { type: 'string' }, 'prompt-file': { type: 'string' },
      watch: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write('node acceptance/tester.mjs start --project <repo> --prompt-file <file>\n' +
      'node acceptance/tester.mjs inspect <attempt-directory> [--watch]\n');
    return;
  }
  if (positionals[0] === 'start' && positionals.length === 1 && values.project && values['prompt-file']) {
    const stateDirectory = process.env.DWF_STATE_DIR ?? join(homedir(), '.dwf');
    if (!isAbsolute(stateDirectory)) throw new Error('DWF_STATE_DIR должен быть абсолютным путём.');
    const attempt = await createAttempt(join(stateDirectory, 'tester'), values.project,
      await readFile(values['prompt-file'], 'utf8'), stateDirectory);
    process.stdout.write(JSON.stringify({ attempt: attempt.directory, sessionId: attempt.sessionId,
      workspace: attempt.workspace, base: attempt.base }) + '\n');
    const client = await connectTester(attempt.root, attempt.stateDirectory, true);
    await checkTester(client, attempt);
    await admitTester(client, attempt);
    const state = await observe(attempt, true);
    process.exitCode = state.status === 'succeeded' ? 0 : 1;
    return;
  }
  if (positionals[0] === 'inspect' && positionals.length === 2) {
    const attempt = JSON.parse(await readFile(join(resolve(positionals[1]), 'attempt.json'), 'utf8'));
    const state = await observe(attempt, values.watch);
    process.exitCode = ['running', 'succeeded'].includes(state.status) ? 0 : 1;
    return;
  }
  throw new Error('Используй --help для справки запускателя тестера.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
