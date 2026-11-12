import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Before, After, Given, When, Then, setDefaultTimeout } from '@cucumber/cucumber';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { assertExecutionStopped, captureOwnedExecution, cliJson, command, createSandbox,
  originalStillWorking, plannerResult, readJson, snapshot, watchStates, within,
  taggedProcesses, timeout, transcript, waitFor, writeJson } from './harness.mjs';
import { assertHigh as assertControlledHigh, createControlledHttpProvider, hash,
  nativeProviderConfig } from './controlled-http-provider.mjs';
import { outcomes, roleSystemPrompt } from '../workflow-definition.mjs';
import { roleSkills, bundledSkills } from '../role-skills.mjs';

const startTimeout = timeout('DWF_TEST_START_TIMEOUT_MS', 15000);
const readyTimeout = timeout('DWF_TEST_READY_TIMEOUT_MS', 15000);
const resultTimeout = timeout('DWF_TEST_RESULT_TIMEOUT_MS', 20000);
const realTimeout = timeout('DWF_TEST_REAL_TIMEOUT_MS', 180000);
setDefaultTimeout(startTimeout * 2 + readyTimeout + Math.max(resultTimeout, realTimeout) + 10000);
const modulePath = name => fileURLToPath(new URL(name, import.meta.url));
const events = world => transcript(join(world.sandbox.control, 'provider.jsonl'));

Before(async function () {
  this.sandbox = await createSandbox();
  this.cli = command(process.env.DWF_TEST_CLI,
    [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))]);
  this.workflowFile = join(this.sandbox.root, 'workflow.json');
  this.limit = resultTimeout;
  this.beforeFiles = await snapshot(this.sandbox.workspace);
});

After(async function () {
  if (!this.sandbox) return;
  try {
    // Только свидетельства тестовых модулей и разрешённая метаинформация CLI.
    this.attach(JSON.stringify({ provider: await events(this),
      lifetimeFailure: this.lifetimeFailure, runId: this.runId,
      executionStopWitness: this.executionStopWitness,
      serviceStartup: this.serviceStartup,
      clients: this.sandbox.records.map(record => ({ pid: record.child.pid,
        exited: record.exited, outcome: record.outcome, spawnError: record.spawnError?.code })) }, null, 2),
    'application/json');
  } finally {
    // The fixture stays alive through savedAgain's product-process shutdown and inspect.
    try { await this.controlledModel?.close(); }
    finally {
      try { await this.sandbox.cleanup(); }
      finally { if (this.observerLink) await rm(this.observerLink, { force: true }); }
    }
  }
});

async function prepare(world, task) {
  world.task = task;
  await writeJson(world.workflowFile, { planner: { task } });
}

Given('подготовлен workflow с одним планнером и заданием', async function () {
  await prepare(this, `Составь следующий небольшой шаг работы над dynamicwf. Идентификатор поручения: ${randomUUID()}`);
});

async function configureControlled(world, finishes, reply) {
  world.controlled = true;
  const env = world.sandbox.env;
  const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'USER', 'LOGNAME', 'SHELL',
    'DWF_STATE_DIR', 'DWF_ACCEPTANCE_TOKEN', 'DWF_ACCEPTANCE_CONTROL_DIR', 'XDG_RUNTIME_DIR']);
  for (const name of Object.keys(env)) if (!keep.has(name)) delete env[name];
  const isolation = join(world.sandbox.root, 'opencode-isolation');
  for (const name of ['home', 'config', 'xdg-config', 'data', 'cache', 'state', 'tmp']) {
    await mkdir(join(isolation, name), { recursive: true, mode: 0o700 });
  }
  Object.assign(env, {
    HOME: join(isolation, 'home'), OPENCODE_TEST_HOME: join(isolation, 'home'), OPENCODE_CONFIG_DIR: join(isolation, 'config'),
    XDG_CONFIG_HOME: join(isolation, 'xdg-config'), XDG_DATA_HOME: join(isolation, 'data'),
    XDG_CACHE_HOME: join(isolation, 'cache'), XDG_STATE_HOME: join(isolation, 'state'), TMPDIR: join(isolation, 'tmp'),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_FILEWATCHER: 'true', OPENCODE_DISABLE_FFF: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  });
  world.controlledModel = await createControlledHttpProvider({ directory: world.sandbox.control, token: world.sandbox.token, finishes, reply });
  const configFile = join(world.sandbox.root, 'controlled-opencode.json');
  await writeJson(configFile, nativeProviderConfig(world.controlledModel.baseURL));
  env.OPENCODE_CONFIG = configFile; // Ordinary native provider config; no product import/callback hook.
  world.sandbox.env.DWF_PLANNER_MODEL = JSON.stringify({ provider: 'dwf-acceptance', modelId: 'planner' });
}

Given('ответ тестового модельного провайдера удерживается до разрешения теста', async function () {
  await configureControlled(this);
});

Given('тестовый провайдер завершает первый ответ по длине', async function () {
  await configureControlled(this, ['length', 'stop']);
});

Given('планнер настроен на уровень рассуждения high', function () {
  this.sandbox.env.DWF_PLANNER_REASONING = 'high';
});

Given('ответ планнера проверяет загрузку скилла планирования', async function () {
  const skill = roleSkills.planner[0];
  this.expectedPlannerText = 'Plan prepared using the assigned planning method.';
  await configureControlled(this, undefined, ({ userTexts, systemTexts, tools, toolResults }) => {
    assert.deepEqual(tools.map(tool => tool.function.name), ['skill']);
    assert(systemTexts.some(text => text.startsWith('Prepare a written plan')));
    const context = [...userTexts, ...systemTexts, JSON.stringify(tools)].join('\n');
    const ids = [...context.matchAll(/<id>([^<]+)<\/id>/g)].map(match => match[1]);
    assert.deepEqual(ids, [skill.id]);
    for (const other of bundledSkills.filter(item => item.id !== skill.id)) assert(!context.includes(other.id));
    if (toolResults.length === 0) {
      assert(!context.includes(skill.body));
      return { toolCalls: [{ name: 'skill', arguments: { id: skill.id } }] };
    }
    assert.equal(toolResults.length, 1);
    assert(toolResults[0].includes(skill.body));
    return this.expectedPlannerText;
  });
});

Then('планнер завершает план с единственным доступным скиллом', async function () {
  this.final = await waitFor(async () => {
    const state = await inspect(this);
    assert.notEqual(state.status, 'failed', state.error);
    return state.status === 'succeeded' && state;
  }, resultTimeout, 'завершение планнера после загрузки скилла');
  assert.equal(this.final.result, this.expectedPlannerText);
  const received = (await events(this)).filter(event => event.type === 'received');
  assert.equal(received.length, 2);
  received.forEach(assertControlledHigh);
});

Given('подготовлен workflow ролей с независимыми проверяющими', async function () {
  const counts = {};
  await configureControlled(this, undefined, ({ prompt, userTexts, systemTexts, tools, toolResults, previousAnswers }) => {
    const role = Object.keys(outcomes).find(role => systemTexts.some(text => text.startsWith(roleSystemPrompt(role))));
    assert(role, 'В системном контексте должен быть собственный промпт роли');
    assert(prompt.includes('inherited-project-context-witness'), 'Инструкции родителя должны дойти до модели');
    assert(prompt.includes('Project workspace:'), 'Модель должна знать границу рабочего дерева');
    assert(!systemTexts.some(text => text.includes('You are an AI agent running in OpenCode') || text.includes('# Harness')),
      'Системный контекст не должен наследовать основной промпт build');
    assert(!prompt.includes('Your final response must be JSON'), 'Протокол результата должен быть в system');
    assert(!userTexts.some(text => text.includes('Ты участник DWF')), 'Поручения не должны содержать шаблонную самопрезентацию');
    const toolNames = tools.map(tool => tool.function.name).sort();
    const expectedTools = ['read', 'glob', 'grep'];
    if (role !== 'orchestrator') expectedTools.push('webfetch', 'websearch');
    if (role === 'worker') expectedTools.push('edit', 'write', 'shell');
    if (roleSkills[role]?.length) expectedTools.push('skill');
    if (role === 'verifier') expectedTools.push('shell');
    assert.deepEqual(toolNames, expectedTools.sort(), `Фактические инструменты ${role}`);
    const context = [...userTexts, ...systemTexts, JSON.stringify(tools)].join('\n');
    assert(!context.includes('dwf-forbidden-'), 'Названия и содержимое тестовых скиллов должны отсутствовать');
    const skills = roleSkills[role] ?? [];
    const catalog = [...context.matchAll(/<id>([^<]+)<\/id>/g)].map(match => match[1]);
    assert.deepEqual(catalog.sort(), skills.map(skill => skill.id).sort());
    if (skills.length) {
      if (toolResults.length < skills.length) {
        const skill = skills[toolResults.length];
        assert(!context.includes(skill.body), 'Тело скилла загружается по вызову');
        return { content: `Preparing ${role} checks.`, toolCalls: [{ name: 'skill', arguments: { id: skill.id } }] };
      }
      skills.forEach((skill, index) => assert(toolResults[index].includes(skill.body),
        `Нативный инструмент должен вернуть содержимое ${skill.name}`));
    } else {
      assert(!/(available[_ -]skills|<skills>|^#{1,6}\s+skills?\b)/im.test(context), 'У остальных ролей отсутствует каталог скиллов');
    }
    for (const skill of bundledSkills.filter(item => !skills.includes(item))) {
      assert(!context.includes(skill.id), 'Роль не видит названий чужих скиллов');
    }
    const iteration = previousAnswers.length + 1;
    if (role === 'worker' && !toolResults.some(text => text.includes(`dwf-written-${iteration}`))) {
      return { toolCalls: [{ name: 'shell', arguments: {
        command: `printf '%s\\n' 'implementation-${iteration}' > change.txt; printf '%s\\n' 'dwf-written-${iteration}'`,
      } }] };
    }
    if (role === 'reviewer') {
      const review = JSON.parse(prompt.match(/Материалы ревью[^\n]*\n([^\n]+)/)?.[1] ?? 'null');
      assert(review, 'Reviewer должен получить материалы своего снимка');
      assert(prompt.includes(`Workspace snapshot recorded and checked by DWF: ${review.revision}`));
      if (!toolResults.some(text => text.includes(`+implementation-${iteration}`))) {
        return { toolCalls: [{ name: 'read', arguments: { path: review.path } }] };
      }
      this.reviewMaterials ??= [];
      const workspace = prompt.match(/^Project workspace: (.+)$/m)?.[1];
      assert(workspace, 'Reviewer должен получить рабочий каталог для относительного пути');
      this.reviewMaterials.push({ ...review, path: resolve(workspace, review.path) });
    }
    assert(!prompt.includes('Work within the current project'), 'Постоянные инструкции должны быть в system');
    assert(prompt.includes('Проверить обмен замечаниями'), 'Поручение должно остаться в пользовательском сообщении');
    counts[role] = (counts[role] ?? 0) + 1;
    if (role === 'worker' && counts[role] > 1) {
      assert(userTexts.length > 1, 'Доработка должна сохранять пользовательскую историю');
      assert(previousAnswers.length > 0, 'Доработка должна сохранять прошлый ответ worker');
      assert(prompt.includes('feedback-'), 'Worker должен получить замечания проверяющего');
    }
    if (role === 'orchestrator') {
      this.orchestratorHistory = JSON.parse(prompt.match(/Завершённые этапы workflow \(по порядку\):\n([^\n]+)/)?.[1] ?? 'null');
      assert(Array.isArray(this.orchestratorHistory), 'Orchestrator должен получить историю завершённых этапов');
    }
    const outcome = ['reviewer', 'verifier'].includes(role)
      ? (counts[role] === 1 ? 'changes' : 'approve') : 'done';
    return JSON.stringify({ outcome, summary: 'feedback-' + role });
  });
  const skillSources = [
    join(this.sandbox.workspace, '.opencode', 'skills', 'dwf-forbidden-project'),
    join(this.sandbox.env.OPENCODE_CONFIG_DIR, 'skills', 'dwf-forbidden-global'),
    join(this.sandbox.root, 'explicit-skills', 'dwf-forbidden-explicit'),
  ];
  for (const directory of skillSources) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), '---\nname: dwf-forbidden-skill\ndescription: dwf-forbidden-description\n---\ndwf-forbidden-content\n');
  }
  const config = await readJson(this.sandbox.env.OPENCODE_CONFIG);
  config.skills = [join(this.sandbox.root, 'explicit-skills')];
  config.policies = [{ action: 'skill.use', resource: '*', effect: 'allow' }];
  await writeJson(this.sandbox.env.OPENCODE_CONFIG, config);
  this.sandbox.env.DWF_PLANNER_REASONING = 'high';
  const git = args => execFileSync('git', args, { cwd: this.sandbox.workspace,
    env: this.sandbox.env, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Workflow test']);
  git(['config', 'user.email', 'workflow@example.invalid']);
  await writeFile(join(this.sandbox.workspace, 'README.md'), 'Workflow fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  await writeFile(join(this.sandbox.root, 'AGENTS.md'), 'inherited-project-context-witness\n');
  await writeJson(this.workflowFile, {
    task: 'Проверить обмен замечаниями', entry: 'work',
    nodes: { work: { role: 'worker' }, review: { role: 'reviewer' },
      verify: { role: 'verifier' }, finish: { role: 'orchestrator' } },
    transitions: { work: { done: 'review' }, review: { approve: 'verify', changes: 'work' },
      verify: { approve: 'finish', changes: 'work' }, finish: { done: null } },
  });
});

When('тест разрешает все ответы участников workflow', async function () {
  await writeJson(join(this.sandbox.control, 'release.json'), { token: this.sandbox.token, all: true });
});

Given('процесс заканчивается проверкой verifier и локальным merge', async function () {
  const definition = await readJson(this.workflowFile);
  delete definition.nodes.finish;
  delete definition.transitions.finish;
  definition.transitions.verify.approve = null;
  definition.merge = true;
  await writeJson(this.workflowFile, definition);
});

Given('после сводки включено локальное слияние', async function () {
  const definition = await readJson(this.workflowFile);
  definition.merge = true;
  await writeJson(this.workflowFile, definition);
  this.mergeAfterSummary = true;
});

When('наблюдатель получает прогресс и переподключается до завершения', async function () {
  let watcher = this.sandbox.spawn(this.cli, ['inspect', this.runId, '--watch']);
  const states = () => watchStates(watcher.stdout);
  await waitFor(() => states().length > 0, readyTimeout, 'первое состояние watch');
  const first = (await events(this)).find(event => event.type === 'received');
  assert(first, 'Первый модельный запрос должен быть принят');
  await writeJson(join(this.sandbox.control, 'release.json'), { token: this.sandbox.token, callId: first.callId });
  const progress = await waitFor(() => states().find(state =>
    state.current?.progress?.tools?.some(tool => tool.name === 'skill' && tool.status === 'completed')),
  readyTimeout, 'прогресс настоящего инструмента OpenCode');
  assert.equal(progress.current.progress.message, 'Preparing worker checks.');
  assert(progress.current.progress.updatedAt >= progress.current.startedAt);
  watcher.child.kill('SIGTERM');
  await within(watcher.close, readyTimeout, 'закрытие наблюдателя');
  assert.equal((await inspect(this)).status, 'running');
  assert.equal((await events(this)).filter(event => event.type === 'received').length, 2);
  watcher = this.sandbox.spawn(this.cli, ['inspect', this.runId, '--watch']);
  await waitFor(() => states().length > 0, readyTimeout, 'повторное подключение watch');
  assert.equal(states()[0].current.progress.message, progress.current.progress.message);
  await writeJson(join(this.sandbox.control, 'release.json'), { token: this.sandbox.token, all: true });
  assert.equal((await within(watcher.exit, 45000, 'завершение watch после merge')).code, 0);
  await within(watcher.close, readyTimeout, 'закрытие вывода watch');
  assert.equal(watcher.stderr, '');
  const final = states().at(-1);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.result.integration.status, 'merged');
  assert.deepEqual(final, await inspect(this));
});

Given('общий сервис OpenCode уже работает без ролевых промптов DWF', async function () {
  const state = this.sandbox.env.XDG_STATE_HOME;
  const endpoint = await Service.ensure({ file: join(state, 'opencode', 'service.json'), version: '2.2.5',
    command: [modulePath('../node_modules/.bin/opencode'), 'serve', '--service', '--hostname', '127.0.0.1', '--port', '0'],
    env: { ...this.sandbox.env, OPENCODE_DISABLE_FILEWATCHER: 'false' } });
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const agents = await client.agent.list({ location: { directory: this.sandbox.workspace } });
  assert(!agents.data.some(agent => agent.id.startsWith('dwf-')));
  const skills = await client.skill.list({ location: { directory: this.sandbox.workspace } });
  assert(skills.data.length > 0, 'До настройки DWF сервис должен действительно видеть скиллы');
  this.existingService = await readJson(join(state, 'opencode', 'service.json'));
  assert(this.existingService.pid, 'Должен быть известен PID существующего сервиса');
});

async function assertSkillCatalog(world) {
  const endpoint = await Service.discover({
    file: join(world.sandbox.env.XDG_STATE_HOME, 'opencode', 'service.json'),
  });
  assert(endpoint, 'Сервис OpenCode должен быть доступен');
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const run = await inspect(world);
  const skills = await client.skill.list({ location: { directory: run.workspace } });
  const skillIds = skills.data.map(skill => skill.id);
  for (const skill of bundledSkills) assert(skillIds.includes(skill.id));
  assert(skillIds.includes('opencode'), 'Общий профиль сохраняет встроенные скиллы OpenCode');
  assert(skillIds.some(id => id.startsWith('dwf-forbidden-')), 'Скиллы пользователя остаются в общем каталоге');
  assert.equal(world.reviewMaterials.length, 3);
  assert.equal(new Set(world.reviewMaterials.map(review => review.path)).size, 3);
  assert.equal(new Set(world.reviewMaterials.map(review => review.revision)).size, 3);
  assert.equal(new Set(world.reviewMaterials.map(review => review.base)).size, 1);
  for (const [index, review] of world.reviewMaterials.entries()) {
    const diff = await readFile(review.path, 'utf8');
    assert(diff.includes(`+implementation-${index + 1}`));
    assert.equal(Buffer.byteLength(diff), review.bytes);
  }
  for (const sessionId of new Set(run.history.map(visit => visit.sessionId))) {
    const session = await client.session.get({ sessionID: sessionId });
    assert.deepEqual(session.permissions.filter(rule => rule.action === 'external_directory'),
      session.agent.startsWith('dwf-reviewer-')
        ? [{ action: 'external_directory', resource: join(dirname(world.reviewMaterials[0].path), '*'), effect: 'allow' }]
        : [], 'Только reviewer получает доступ к каталогу diff текущего запуска');
  }
}

Then('три роли завершают работу и DWF подтверждает merge', async function () {
  const final = await waitFor(async () => {
    const value = await inspect(this);
    assert.notEqual(value.status, 'failed', value.error);
    return value.status === 'succeeded' && value;
  }, 45000, 'завершение workflow из трёх ролей');
  assert.deepEqual(final.history.map(visit => visit.node),
    ['work', 'review', 'work', 'review', 'verify', 'work', 'review', 'verify']);
  assert.equal(new Set(final.history.filter(visit => visit.node === 'work').map(visit => visit.sessionId)).size, 1);
  assert.equal(final.current.role, 'verifier');
  assert.equal(final.history.at(-1).result.outcome, 'approve');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.sandbox.workspace,
    env: this.sandbox.env, encoding: 'utf8' }).trim();
  assert.equal(final.result.commit, commit);
  if (this.existingService) {
    const service = await readJson(join(this.sandbox.env.XDG_STATE_HOME, 'opencode', 'service.json'));
    assert.equal(service.pid, this.existingService.pid, 'Установка ролевых промптов не должна перезапускать сервис');
    assert.equal(service.id, this.existingService.id);
  }
  assert.equal((await events(this)).filter(event => event.type === 'received').length,
    14 + roleSkills.worker.length + roleSkills.reviewer.length + roleSkills.verifier.length);
  await assertSkillCatalog(this);
});

Then('workflow завершает оба цикла доработки в исходных сессиях', async function () {
  const final = await waitFor(async () => {
    const value = await inspect(this);
    assert.notEqual(value.status, 'failed', value.error);
    return value.status === 'succeeded' && value;
  }, 45000, 'завершение workflow с возвратами замечаний');
  assert.deepEqual(final.history.map(visit => visit.node),
    ['work', 'review', 'work', 'review', 'verify', 'work', 'review', 'verify', 'finish']);
  const sessions = new Map();
  for (const visit of final.history) {
    if (sessions.has(visit.node)) assert.equal(visit.sessionId, sessions.get(visit.node));
    sessions.set(visit.node, visit.sessionId);
  }
  assert.equal(new Set(sessions.values()).size, 4);
  if (this.mergeAfterSummary) {
    assert.equal(final.result.integration.status, 'merged');
    assert.equal(final.result.integration.branch, 'main');
    assert.equal(final.result.integration.commit, final.result.commit);
    assert(final.result.summary.startsWith('DWF подтвердил локальный merge'));
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: this.sandbox.workspace, env: this.sandbox.env, encoding: 'utf8',
    }).trim(), final.result.commit);
  } else assert.equal(final.result.outcome, 'done');
  assert.deepEqual(this.orchestratorHistory.map(({ node, sessionId, revision, result }) =>
    ({ node, sessionId, revision, result })), final.history.slice(0, -1),
  'Фактический модельный запрос orchestrator должен содержать каждый завершённый этап');
  const received = (await events(this)).filter(event => event.type === 'received');
  const roles = new Set(Object.values((await readJson(this.workflowFile)).nodes).map(node => node.role));
  assert.equal(received.length, 15 + [...roles].reduce((count, role) => count + roleSkills[role].length, 0));
  received.forEach(assertControlledHigh);
  await assertSkillCatalog(this);
  const before = await events(this);
  await this.sandbox.cleanupProcesses();
  assert.deepEqual(await inspect(this), final, 'Готовый workflow должен читаться без контроллера и OpenCode');
  assert.deepEqual(await events(this), before, 'Чтение результата не должно повторять исполнение');
});

function workflowControllers(world) {
  return taggedProcesses(world.sandbox.token).filter(identity => {
    const argv = execFileSync('ps', ['-p', String(identity.pid), '-o', 'command='], { encoding: 'utf8' });
    return argv.includes('/workflow-runtime.mjs ') && argv.includes(world.runId);
  });
}

When('контроллер workflow аварийно завершается и восстанавливается через inspect', async function () {
  await waitFor(async () => (await events(this)).some(event => event.type === 'received'),
    readyTimeout, 'первый запрос worker');
  const controllers = workflowControllers(this);
  assert.equal(controllers.length, 1);
  process.kill(controllers[0].pid, 'SIGKILL');
  await assertExecutionStopped(controllers);
  await waitFor(async () => {
    assert.equal((await inspect(this)).status, 'running');
    return workflowControllers(this).some(identity => identity.pid !== controllers[0].pid);
  }, 45000, 'новый контроллер после истечения lease');
  const received = (await events(this)).filter(event => event.type === 'received');
  assert.equal(received.length, 1, 'Восстановление не должно повторять незавершённый модельный запрос');
  assert.equal(this.controlledModel.status(received[0].callId).closed, false);
});

Given('подготовлен workflow с одним планнером OpenCode и реальным заданием по dynamicwf', async function () {
  this.limit = realTimeout;
  const state = process.env.DWF_TEST_REAL_STATE_DIR;
  assert(state && isAbsolute(state), 'TECHNICAL_BLOCKER: DWF_TEST_REAL_STATE_DIR должен указывать на отдельный авторизованный профиль DWF');
  assert(process.env.DWF_PLANNER_MODEL, 'TECHNICAL_BLOCKER: задайте настоящую модель через DWF_PLANNER_MODEL');
  this.model = JSON.parse(process.env.DWF_PLANNER_MODEL);
  assert(this.model.provider && this.model.modelId, 'DWF_PLANNER_MODEL: нужна пара provider/modelId');
  assert.notEqual(this.model.provider, 'dwf-acceptance', 'Нужна настоящая модель');
  this.sandbox.env.DWF_STATE_DIR = state;
  this.sandbox.env.DWF_PLANNER_MODEL = process.env.DWF_PLANNER_MODEL;
  Object.assign(this.sandbox.env, {
    OPENCODE_CONFIG_DIR: join(state, 'opencode/config'),
    OPENCODE_DB: join(state, 'opencode/opencode.sqlite'),
    XDG_CONFIG_HOME: join(state, 'opencode/xdg-config'),
    XDG_DATA_HOME: join(state, 'opencode/data'),
    XDG_CACHE_HOME: join(state, 'opencode/cache'),
    XDG_STATE_HOME: join(state, 'opencode/state'),
  });
  const existing = await Service.discover({ file: join(state, 'opencode', 'state', 'opencode', 'service.json') });
  assert(!existing, 'TECHNICAL_BLOCKER: остановите сервис выделенного real-профиля перед прогоном');
  const plugins = join(state, 'opencode', 'config', 'plugins');
  await mkdir(plugins, { recursive: true, mode: 0o700 });
  this.observerLink = join(plugins, 'dwf-observer-' + this.sandbox.token);
  await symlink(modulePath('model-observer'), this.observerLink, 'dir');
  await prepare(this, `DWF исполняет процессы из готовых участников. Уже реализуется первый срез на OpenCode 2:
CLI start принимает поручение одного планнера, возвращает runId и завершается. Исполнение независимо,
а inspect получает сохранённый результат. Следующим выбран терминальный доступ к тому же разговору
и уточнение без потери контекста. Графы, параллельные группы и циклы будут отдельными этапами.
Предложи небольшой следующий шаг для терминального доступа. Опиши действия пользователя и критерии
проверки, отдели договорённости от предложений. Верни текстовый план, без изменения файлов.
Идентификатор поручения: ${randomUUID()}`);
  await writeFile(join(this.sandbox.workspace, 'dynamicwf-description.txt'), this.task);
  this.beforeFiles = await snapshot(this.sandbox.workspace);
});

When('внешний клиент запускает workflow через CLI', function () {
  this.startClient = this.sandbox.spawn(this.cli, ['start', '--file', this.workflowFile]);
  this.startClient.child.stdin.end();
});

Then('клиент получает идентификатор запуска и завершается', async function () {
  const reply = await cliJson(this.startClient, startTimeout);
  assert.equal(this.startClient.exited, true, 'Требуется событие exit, а не только JSON на stdout');
  assert.equal(typeof reply.runId, 'string');
  assert(reply.runId.trim(), 'CLI должен вернуть непустой идентификатор');
  this.runId = reply.runId;
  if (this.controlled) {
    assert.equal(await readJson(join(this.sandbox.control, 'release.json')), undefined);
    assert(!(await events(this)).some(event => ['generated', 'completed'].includes(event.type)),
      'До разрешения модель не должна сформировать готовый ответ');
  }
});

async function inspect(world) {
  const client = world.sandbox.spawn(world.cli, ['inspect', world.runId]);
  client.child.stdin.end();
  assert.notEqual(client.child, world.startClient.child, 'inspect должен быть новым процессом CLI');
  const reply = await cliJson(client, startTimeout);
  assert.equal(reply.runId, world.runId, 'Другой клиент должен получить данные запрошенного запуска');
  assert.equal(typeof reply.status, 'string');
  assert.equal(reply.service, undefined, 'В проверяемом сценарии сервис должен быть доступен: ' + JSON.stringify(reply.service));
  return reply;
}

async function receivedTask(world) {
  const ready = await waitFor(async () => (await events(world)).find(event => event.type === 'received'),
    readyTimeout, 'независимое свидетельство получения поручения модельным провайдером');
  assert.equal(ready.token, world.sandbox.token);
  assert(ready.prompt.includes(world.task), 'Модель должна получить переданное поручение целиком');
  assert.equal(ready.promptHash, hash(ready.prompt));
  assert(ready.messagesHash && ready.callId && ready.providerSessionId);
  return ready;
}

Then('исполнитель получил поручение, но ещё не завершил его', async function () {
  this.ready = await receivedTask(this);
  assert.equal(this.ready.model.provider, 'dwf-acceptance');
  assert.equal(this.ready.model.modelId, 'planner');
  await originalStillWorking(this);
  const reply = await inspect(this);
  await originalStillWorking(this);
  assert.notEqual(reply.status, 'succeeded', 'Получение поручения не является успешным завершением');
  assert(reply.result == null, 'До разрешения не должно быть готового результата');
  assert(!(await events(this)).some(event => ['generated', 'completed'].includes(event.type)));
});

When('тест разрешает исполнителю завершить поручение', async function () {
  assert(this.startClient.exited && this.runId && this.ready, 'Сначала нужны фактический exit и получение поручения');
  await originalStillWorking(this);
  await writeJson(join(this.sandbox.control, 'release.json'), { token: this.sandbox.token, callId: this.ready.callId });
  this.released = true;
});

Then('другой клиент через CLI получает по идентификатору успешное состояние', async function () {
  if (this.controlled) assert(this.released, 'Сначала тест должен разрешить завершение');
  this.final = await waitFor(async () => {
    if (this.controlled) await originalStillWorking(this);
    const reply = await inspect(this);
    if (this.controlled) await originalStillWorking(this);
    assert.notEqual(reply.status, 'failed', 'Запуск завершился ошибкой');
    return reply.status === 'succeeded' ? reply : undefined;
  }, this.limit, 'успех того же запуска после завершения запускающего клиента');
});

async function savedAgain(world, text) {
  const before = await events(world);
  if (world.controlled || world.model) {
    world.executionStopWitness = { identities: captureOwnedExecution(world), stopped: false };
  }
  await world.sandbox.cleanupProcesses();
  if (world.controlled || world.model) {
    await assertExecutionStopped(world.executionStopWitness.identities);
    world.executionStopWitness.stopped = true;
  }
  const persisted = await inspect(world);
  assert.equal(persisted.status, 'succeeded');
  assert.equal(persisted.result, text, 'Результат должен сохраняться после остановки процессов исполнения');
  assert.deepEqual(await events(world), before, 'Чтение сохранённого результата не должно повторять модельное исполнение');
}

Then('получает результат, сформированный исполнителем этого запуска', async function () {
  const seen = await waitFor(async () => {
    const seen = await events(this);
    return seen.some(event => event.type === 'completed' && event.callId === this.ready.callId) && seen;
  }, readyTimeout, 'нормально завершённый ответ управляемого провайдера');
  const generated = seen.find(event => event.type === 'generated' && event.callId === this.ready.callId);
  assert(generated?.nonce && generated.promptHash === this.ready.promptHash);
  assert(generated.text.includes(generated.nonce) && generated.text.includes(this.ready.promptHash));
  const text = plannerResult(seen);
  assert.equal(text, generated.text);
  assert.equal(this.final.result, text, 'Нужен точный ответ провайдера этого вызова');
  await savedAgain(this, text);
});

Then('настоящий модельный провайдер получил поручение планнера', async function () {
  this.ready = await receivedTask(this);
  const endpoint = await Service.discover({ file: join(this.sandbox.env.DWF_STATE_DIR,
    'opencode', 'state', 'opencode', 'service.json') });
  assert(endpoint, 'Нужен существующий сервис OpenCode');
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const models = await client.model.list({ location: { directory: this.sandbox.workspace } });
  const selected = models.data.find(model => model.providerID === this.model.provider && model.id === this.model.modelId);
  assert(selected, 'Выбранная запись должна присутствовать в нативном каталоге');
  this.wireModelId = selected.modelID ?? selected.id;
  assert.equal(this.ready.model.provider, this.model.provider);
  assert.equal(this.ready.model.modelId, this.wireModelId);
});

Then('модельный провайдер получил уровень рассуждения high', async function () {
  if (this.controlled) assertControlledHigh(this.ready);
  else assert.equal(this.ready.reasoning, 'high', 'Нативный запрос должен содержать high');
});

Then('получает точный текст нормально завершённого ответа настоящей модели', async function () {
  const seen = await waitFor(async () => {
    const seen = await events(this);
    const last = seen.filter(event => event.type === 'received').at(-1);
    return seen.some(event => event.type === 'completed' && event.callId === last?.callId) && seen;
  }, readyTimeout, 'терминальный ответ настоящей модели');
  for (const call of seen.filter(event => event.type === 'received')) {
    assert.equal(call.token, this.sandbox.token);
    assert(call.prompt.includes(this.task));
    assert.equal(call.model.provider, this.model.provider);
    assert.equal(call.model.modelId, this.wireModelId);
  }
  const last = seen.filter(event => event.type === 'received').at(-1);
  const answer = seen.findLast(event => event.type === 'completed' && event.callId === last.callId);
  assert.equal(answer.model.provider, this.model.provider);
  assert.equal(answer.model.modelId, this.wireModelId);
  // ChatGPT can report "default" for accelerated responses; retain the raw tier in evidence.
  // The requested tier is checked on the actual request, acceleration has a separate paired probe.
  plannerResult(seen);
  const text = seen.filter(event => event.type === 'completed' && ['length', 'stop'].includes(event.stopReason))
    .map(event => event.text).join('');
  assert.equal(this.final.result, text, 'Сохранённый текст должен точно совпасть с независимым ответом модели');
  this.attach(text, 'text/plain'); // Полезность оценивается отдельно человеком.
  await savedAgain(this, text);
});

Then('штатному провайдеру отправлены выбранная модель и уровень рассуждения high', async function () {
  const seen = await events(this);
  for (const call of seen.filter(event => event.type === 'received')) {
    assert.equal(call.model.modelId, this.wireModelId);
    assert.equal(call.reasoning, 'high', 'Фактический запрос должен содержать high');
    assert.equal(call.serviceTier, 'ultrafast', 'Фактический запрос должен содержать ultrafast');
  }
});

Then('файлы рабочего проекта не изменились', async function () {
  assert.deepEqual(await snapshot(this.sandbox.workspace), this.beforeFiles,
    'Текстовый план не должен создавать, удалять или изменять файлы проекта');
});

When('сервис OpenCode аварийно завершается', async function () {
  const execution = captureOwnedExecution(this);
  for (const identity of execution) {
    assert(taggedProcesses(this.sandbox.token).some(current => current.pid === identity.pid &&
      current.uid === identity.uid && current.born === identity.born), 'Проверена принадлежность процесса тесту');
    process.kill(identity.pid, 'SIGKILL');
  }
  await assertExecutionStopped(execution);
});

When('другой клиент запрашивает состояние запуска', async function () {
  const reply = await inspect(this);
  assert.equal(reply.status, 'running');
  assert.equal(reply.service, undefined, 'Общий сервис должен восстановиться');
});

Then('OpenCode продолжает то же поручение в прежней сессии', async function () {
  const first = this.ready;
  this.ready = await waitFor(async () => (await events(this)).find(event =>
    event.type === 'received' && event.callId !== first.callId), readyTimeout, 'повтор после аварии');
  assert.equal(this.ready.providerSessionId, first.providerSessionId);
  assert(this.ready.userTexts.some(text => text.includes(this.task)), 'Исходная задача должна сохраниться');
  assertControlledHigh(this.ready);
  assert.equal((await events(this)).filter(event => event.type === 'received').length, 2);
});

When('тест разрешает восстановленному исполнителю завершить поручение', async function () {
  await writeJson(join(this.sandbox.control, 'release.json'), { token: this.sandbox.token, callId: this.ready.callId });
});

Then('другой клиент получает точный результат восстановленного поручения', async function () {
  this.final = await waitFor(async () => {
    const reply = await inspect(this);
    assert.notEqual(reply.status, 'failed');
    return reply.status === 'succeeded' && reply;
  }, resultTimeout, 'завершение восстановленного поручения');
  const completed = (await events(this)).find(event => event.type === 'completed' && event.callId === this.ready.callId);
  assert.equal(this.final.result, completed.text);
  await savedAgain(this, completed.text);
});

When('публичный API OpenCode подтверждает сохранение законченного ответа', async function () {
  const endpoint = await Service.discover({ file: join(this.sandbox.env.XDG_STATE_HOME, 'opencode', 'service.json') });
  assert(endpoint, 'Нужен существующий сервис OpenCode');
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  await waitFor(async () => {
    const messages = await client.message.list({ sessionID: this.ready.providerSessionId, order: 'asc', limit: 100 });
    return messages.data.some(message => message.type === 'idle' && message.outcome === 'succeeded');
  }, resultTimeout, 'публичное подтверждение сохранённого ответа');
  this.savedModelText = (await events(this)).find(event => event.type === 'completed').text;
});

Then('первый inspect результата возвращает сохранённый ответ без повторения модели', async function () {
  this.final = await inspect(this);
  assert.equal(this.final.status, 'succeeded');
  assert.equal(this.final.result, this.savedModelText);
  assert.equal((await events(this)).filter(event => event.type === 'received').length, 1);
  await savedAgain(this, this.savedModelText);
});

When('тест разрешает первый ответ и дожидается штатного продолжения', async function () {
  const first = await receivedTask(this);
  await writeJson(join(this.sandbox.control, 'release.json'), { token: this.sandbox.token, callId: first.callId });
  this.ready = await waitFor(async () => (await events(this)).find(event =>
    event.type === 'received' && event.callId !== first.callId), readyTimeout, 'штатное продолжение length');
  this.firstText = (await events(this)).find(event => event.type === 'completed' && event.callId === first.callId).text;
});

Then('следующий запрос содержит предыдущую часть ответа', function () {
  assert(this.ready.previousAnswers.includes(hash(this.firstText)), 'Продолжение должно получить полный первый фрагмент');
  assertControlledHigh(this.ready);
});

Then('inspect возвращает обе части законченного ответа в исходном порядке', async function () {
  this.final = await waitFor(async () => {
    const reply = await inspect(this);
    assert.notEqual(reply.status, 'failed');
    return reply.status === 'succeeded' && reply;
  }, resultTimeout, 'полный ответ после length');
  const completed = (await events(this)).filter(event => event.type === 'completed');
  assert.deepEqual(completed.map(event => event.stopReason), ['length', 'stop']);
  const exact = completed.map(event => event.text).join('');
  assert.equal(this.final.result, exact);
  await savedAgain(this, exact);
});

Given('тестовый провайдер всегда завершает ответы по длине', async function () {
  await configureControlled(this, ['length']);
});

When('тест разрешает все модельные попытки', async function () {
  if (!this.calls) await receivedTask(this);
  await writeJson(join(this.sandbox.control, 'release.json'), { token: this.sandbox.token, all: true });
});

Then('после штатного числа продолжений запуск завершается ошибкой без готового результата', async function () {
  const final = await waitFor(async () => {
    const reply = await inspect(this);
    return reply.status === 'failed' && reply;
  }, resultTimeout, 'исчерпание штатных продолжений');
  assert(final.result == null);
  assert.match(final.error, /лимиту длины/);
  const calls = (await events(this)).filter(event => event.type === 'received');
  assert.equal(calls.length, 3, 'В закреплённой 2.2.5 доступны два продолжения после первого ответа');
  assert.equal(new Set(calls.map(call => call.providerSessionId)).size, 1);
});

When('два клиента одновременно запускают разные поручения', async function () {
  const secondFile = join(this.sandbox.root, 'second-workflow.json');
  this.secondTask = 'Другое независимое поручение ' + randomUUID();
  await writeJson(secondFile, { planner: { task: this.secondTask } });
  this.startClient = this.sandbox.spawn(this.cli, ['start', '--file', this.workflowFile]);
  const second = this.sandbox.spawn(this.cli, ['start', '--file', secondFile]);
  this.startClient.child.stdin.end();
  second.child.stdin.end();
  const replies = await Promise.all([cliJson(this.startClient, startTimeout), cliJson(second, startTimeout)]);
  this.runIds = replies.map(reply => reply.runId);
  this.runId = this.runIds[0];
  assert.equal(new Set(this.runIds).size, 2);
});

Then('оба поручения исполняются одним сервисом в разных сессиях', async function () {
  this.calls = await waitFor(async () => {
    const calls = (await events(this)).filter(event => event.type === 'received');
    return calls.length === 2 && calls;
  }, readyTimeout, 'два одновременно удержанных поручения');
  this.serviceStartup = { initial: captureOwnedExecution(this) };
  // Native ensure may briefly retain a losing startup contender after both callers exit.
  this.serviceStartup.settled = await waitFor(() => {
    const execution = captureOwnedExecution(this);
    return execution.length === 1 && execution;
  }, 5000, 'один общий сервис после завершения конкурирующего запуска');
  assert.equal(new Set(this.calls.map(call => call.providerSessionId)).size, 2);
  assert.deepEqual(this.calls.map(call => call.prompt).sort(), [this.task, this.secondTask].sort());
});

Then('оба клиента получают свои точные сохранённые результаты', async function () {
  const expected = [];
  for (let index = 0; index < this.runIds.length; index++) {
    this.runId = this.runIds[index];
    const final = await waitFor(async () => {
      const reply = await inspect(this);
      assert.notEqual(reply.status, 'failed');
      return reply.status === 'succeeded' && reply;
    }, resultTimeout, 'раздельный результат');
    const task = index === 0 ? this.task : this.secondTask;
    const call = this.calls.find(call => call.prompt === task);
    const completed = (await events(this)).find(event => event.type === 'completed' && event.callId === call.callId);
    assert.equal(final.result, completed.text);
    expected.push(final.result);
  }
  const execution = captureOwnedExecution(this);
  await this.sandbox.cleanupProcesses();
  await assertExecutionStopped(execution);
  for (let index = 0; index < this.runIds.length; index++) {
    this.runId = this.runIds[index];
    assert.equal((await inspect(this)).result, expected[index]);
  }
  assert.equal((await events(this)).filter(event => event.type === 'received').length, 2);
});
