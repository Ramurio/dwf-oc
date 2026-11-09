import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { validateWorkflow, parseVerdict, rolePermissions, rolePrompt, roleSystemPrompt, roleAgents, outcomes, participantSettings, participantAgent, checkApprovals } from './workflow-definition.mjs';
import { createWorkflow, getWorkflow, claimWorkflow, updateWorkflow, workflowHasOwner, savePreset, presets, queueWorkflowCommand, withWorkflowAction } from './run-store.mjs';
import { git, prepareWorkspace, tree, mergeWorkspace, writeReviewDiff, snapshot, verificationWorkspace } from './workflow-git.mjs';
import { DatabaseSync } from 'node:sqlite';
import { roleSkills } from './role-skills.mjs';
import { publicWorkflow, watchEvent } from './workflow-runtime.mjs';
import { launch, waitFor, within, watchStates } from './acceptance/harness.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dwf-workflow-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function sampleWorkflow(task) {
  return { task, entry: 'implement', merge: true,
    nodes: { implement: { role: 'worker' }, review: { role: 'reviewer' },
      verify: { role: 'verifier' }, summarize: { role: 'orchestrator' } },
    transitions: { implement: { done: 'review' }, review: { approve: 'verify', changes: 'implement' },
      verify: { approve: 'summarize', changes: 'implement' }, summarize: { done: null } } };
}

test('произвольные имена участников, циклы и завершающий переход валидируются', () => {
  const definition = sampleWorkflow('Выполнить задачу');
  assert.deepEqual(validateWorkflow(definition), definition);
  for (const change of [
    value => { value.entry = 'missing'; },
    value => { value.transitions.review.approve = 'missing'; },
    value => { delete value.transitions.review.changes; },
    value => { value.nodes.extra = { role: 'worker' }; value.transitions.extra = { done: null }; },
    value => { value.nodes.review.role = 'invented'; },
    value => { value.extra = true; },
  ]) {
    const invalid = structuredClone(definition);
    change(invalid);
    assert.throws(() => validateWorkflow(invalid), /Workflow:/);
  }
});

test('вердикт читается структурированно, отсутствие решения не означает одобрение', () => {
  assert.equal(parseVerdict('```json\n{"outcome":"changes","summary":"Исправить тест"}\n```', 'reviewer').outcome, 'changes');
  assert.equal(parseVerdict('Checks finished.\n\n{"outcome":"done","summary":"Verified"}', 'worker').outcome, 'done');
  assert.throws(() => parseVerdict('{"outcome":"changes","summary":"First"}\n{"outcome":"approve","summary":"Second"}', 'reviewer'));
  assert.throws(() => parseVerdict('{"outcome":"approve","summary":"Checked"}\nMore prose', 'reviewer'));
  assert.throws(() => parseVerdict('Всё отлично!', 'reviewer'));
  assert.throws(() => parseVerdict('{"outcome":"done","summary":"Готово"}', 'reviewer'));
  assert.throws(() => parseVerdict('{"outcome":"approve","summary":""}', 'verifier'));
});

test('fenced results obey the same final and unambiguous boundary as plain JSON', () => {
  const approval = '{"outcome":"approve","summary":"Earlier"}';
  const rejection = '{"outcome":"changes","summary":"Final"}';
  const fenced = `\`\`\`json\n${approval}\n\`\`\``;
  assert.equal(parseVerdict(`Checks finished.\n${fenced}`, 'reviewer').outcome, 'approve');
  assert.equal(parseVerdict(`Checked type {value: number}.\n${approval}`, 'reviewer').outcome, 'approve');
  const nested = { outcome: 'approve', summary: 'A "quoted } brace" and \\ escape', detail: { items: [{ ok: true }] } };
  assert.deepEqual(parseVerdict(JSON.stringify(nested), 'reviewer'), nested);
  for (const text of [
    `${fenced}\n${rejection}`,
    `${approval}\n\`\`\`json\n${rejection}\n\`\`\``,
    `${fenced}\n\`\`\`json\n${rejection}\n\`\`\``,
    `${fenced}\nThe final check failed.`,
    `First verdict ${approval}\n${rejection}`,
    `${approval}\n{"outcome":`,
  ]) assert.throws(() => parseVerdict(text, 'reviewer'));
});

test('literal code fences inside verdict strings preserve the complete JSON', () => {
  for (const summary of ['literal ``` text', '```js\nconst x = { ok: true };\n```', 'ending with ```']) {
    const result = { outcome: 'approve', summary };
    const json = JSON.stringify(result);
    for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `Checked.\n\`\`\`\n${json}\`\`\``]) {
      assert.deepEqual(parseVerdict(text, 'reviewer'), result);
    }
  }
});

test('каждый обязательный проверяющий должен одобрить текущую версию', () => {
  const definition = sampleWorkflow('Task');
  definition.nodes.secondReview = { role: 'reviewer' };
  const state = { definition, visits: [
    { node: 'review', revision: 'old', verdict: { outcome: 'approve' } },
    { node: 'secondReview', revision: 'current', verdict: { outcome: 'approve' } },
    { node: 'verify', revision: 'current', verdict: { outcome: 'approve' } },
  ] };
  assert.throws(() => checkApprovals(state, 'current'), /review/);
  state.visits.push({ node: 'review', revision: 'current', verdict: { outcome: 'approve' } });
  assert.doesNotThrow(() => checkApprovals(state, 'current'));
  for (const verdict of [undefined, { outcome: 'changes' }, { outcome: 'blocked' }]) {
    state.visits.push({ node: 'review', revision: 'current', verdict });
    assert.throws(() => checkApprovals(state, 'current'), /review/);
    state.visits.pop();
  }
  delete state.definition.nodes.review;
  state.definition.nodes.secondReview.required = false;
  state.definition.merge = false;
  state.visits = state.visits.filter(visit => visit.node === 'verify');
  assert.doesNotThrow(() => checkApprovals(state, 'current'));
});

test('управляющие команды переживают сохранение контроллера и сериализованы с завершением', async t => {
  const root = await fixture(t);
  const state = { id: 'commands', definition: sampleWorkflow('Task'), status: 'running', visits: [] };
  createWorkflow(root, state);
  assert(claimWorkflow(root, state.id, 'owner'));
  const command = queueWorkflowCommand(root, state.id, 'steer', 'implement', 'Refine behavior');
  assert.equal(updateWorkflow(root, state, 'owner', false, true), false);
  assert.equal(state.controls[0].id, command.id);
  state.controls[0].status = 'applied';
  assert(updateWorkflow(root, state, 'owner', false, true));
  assert.throws(() => queueWorkflowCommand(root, state.id, 'stop'), /не принимает/);
  state.status = 'succeeded';
  updateWorkflow(root, state, 'owner', true);
  assert.throws(() => queueWorkflowCommand(root, state.id, 'steer', 'implement', 'Late'), /не принимает/);
  const other = { id: 'stop', definition: state.definition, status: 'running', visits: [] };
  createWorkflow(root, other);
  assert(claimWorkflow(root, other.id, 'owner'));
  const stopped = queueWorkflowCommand(root, other.id, 'stop');
  updateWorkflow(root, other, 'owner');
  assert.equal(other.controls[0].id, stopped.id);
  assert.deepEqual(queueWorkflowCommand(root, other.id, 'stop'), stopped);
  assert.throws(() => queueWorkflowCommand(root, other.id, 'steer', 'implement', 'Late'), /не принимает/);
});

test('устаревший владелец не выполняет внешние действия после takeover и stop', async t => {
  const root = await fixture(t);
  const state = { id: 'fencing', definition: sampleWorkflow('Task'), status: 'running', visits: [] };
  createWorkflow(root, state);
  claimWorkflow(root, state.id, 'old');
  const db = new DatabaseSync(join(root, 'dwf.sqlite'));
  db.prepare('UPDATE workflows SET expires = 0 WHERE id = ?').run(state.id);
  db.close();
  assert(claimWorkflow(root, state.id, 'new'));
  const current = getWorkflow(root, state.id);
  queueWorkflowCommand(root, state.id, 'stop');
  current.status = 'cancelled';
  updateWorkflow(root, current, 'new', true);
  let called = false;
  await assert.rejects(withWorkflowAction(root, state, 'old', () => { called = true; }), { code: 'DWF_OWNER_LOST' });
  assert.equal(called, false);
  assert.equal(getWorkflow(root, state.id).status, 'cancelled');
});

test('admission и принятие управляющей команды сериализуются на реальной SQLite', async t => {
  const root = await fixture(t);
  const state = { id: 'serialized', definition: sampleWorkflow('Task'), status: 'running', visits: [] };
  createWorkflow(root, state);
  claimWorkflow(root, state.id, 'owner');
  let client;
  await withWorkflowAction(root, state, 'owner', async () => {
    client = launch([process.execPath], ['--input-type=module', '-e', `
      import {queueWorkflowCommand} from './run-store.mjs';
      process.stdout.write('attempting\\n');
      queueWorkflowCommand(process.argv[1], 'serialized', 'stop');
      process.stdout.write('accepted\\n');
    `, root], { env: process.env });
    await waitFor(() => client.stdout.includes('attempting'), 5000, 'concurrent control request');
    await pause(50);
    assert.equal(client.exited, false);
    assert(!client.stdout.includes('accepted'));
  });
  assert.equal((await within(client.exit, 5000, 'control after admission')).code, 0);
  await within(client.close, 5000, 'control output');
  assert.equal(getWorkflow(root, state.id).controls[0].kind, 'stop');
});

test('verifier получает только переносимые файлы из проверяемого дерева', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await mkdir(source);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, '.gitignore'), 'local-only.js\n');
  await writeFile(join(source, 'index.js'), 'import "./local-only.js";\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'base']);
  const workspace = prepareWorkspace(root, source, 'portable');
  await writeFile(join(workspace.path, 'local-only.js'), 'console.log("hidden dependency");\n');
  const revision = snapshot(workspace);
  const verification = verificationWorkspace(root, 'portable', workspace, revision, 'attempt');
  assert.equal(snapshot(verification), revision);
  assert(!(await readdir(verification.path)).includes('local-only.js'));
  assert.throws(() => execFileSync(process.execPath, ['index.js'], { cwd: verification.path, stdio: 'pipe' }), /Command failed/);
});

test('настройки участника наследуются, пустые списки заменяют defaults', () => {
  const definition = sampleWorkflow('Task');
  definition.roles = { worker: { model: { provider: 'test', modelId: 'base' }, reasoning: 'high',
    tools: ['read'], skills: ['code-work'], memory: false } };
  definition.nodes.implement = { role: 'worker', tools: [], skills: [], reasoning: null };
  validateWorkflow(definition);
  const settings = participantSettings(definition, 'implement');
  assert.deepEqual(settings, { role: 'worker', model: { provider: 'test', modelId: 'base' },
    reasoning: null, tools: [], skills: [], memory: false });
  assert.deepEqual(participantAgent('worker', settings).agent.permissions,
    [{ action: '*', resource: '*', effect: 'deny' }]);
  assert.equal(participantSettings(definition, 'review').memory, true);
  for (const value of [{ model: {} }, { tools: ['invented'] }, { skills: ['missing'] },
    { memory: 'false' }, { reasoning: '' }, { tools: ['read', 'read'] }]) {
    const invalid = structuredClone(definition);
    Object.assign(invalid.nodes.implement, value);
    assert.throws(() => validateWorkflow(invalid), /Workflow:/);
  }
  const restricted = structuredClone(definition);
  restricted.nodes.review.tools = ['write'];
  assert.throws(() => validateWorkflow(restricted), /tools/);
});

test('read-only workflow получает каталог без Git и стабильный снимок файлов', async t => {
  const root = await fixture(t);
  const directory = join(root, 'documents');
  await mkdir(directory);
  await writeFile(join(root, 'AGENTS.md'), 'Inherited instructions');
  await writeFile(join(directory, 'note.txt'), 'Original note');
  const workspace = prepareWorkspace(join(root, 'state'), directory, 'run', 'directory');
  assert.equal(workspace.path, directory);
  assert(workspace.instructions.some(item => item.content === 'Inherited instructions'));
  const original = snapshot(workspace);
  assert.equal(snapshot(workspace), original);
  await writeFile(join(directory, 'note.txt'), 'Changed note');
  assert.notEqual(snapshot(workspace), original);
  const definition = { task: 'Read notes', workspace: 'directory', entry: 'read',
    nodes: { read: { role: 'reviewer' } }, transitions: { read: { approve: null, changes: null } } };
  validateWorkflow(definition);
  assert.throws(() => validateWorkflow({ ...definition, merge: true }), /directory/);
  definition.nodes.read.role = 'worker';
  assert.throws(() => validateWorkflow(definition), /read-only/);
});

test('системные обязанности отделены от поручения, старые workflow сохраняют инструкции', () => {
  const definition = sampleWorkflow('Поручение только для этого workflow');
  definition.nodes.implement.instructions = 'Особое условие задачи';
  for (const role of Object.keys(outcomes)) {
    const system = roleSystemPrompt(role);
    assert(system.includes('Read applicable AGENTS.md'));
    assert(system.includes('Your final response must be JSON'));
    assert(system.includes('In summary'));
    assert(system.includes('return blocked'));
    assert.doesNotMatch(system, /\p{Script=Cyrillic}/u);
    assert(!system.includes(definition.task));
    assert(!system.includes('в этой же сессии'));
    assert.match(roleAgents[role], new RegExp(`^dwf-${role}-[a-f0-9]{16}$`));
  }
  const prompt = rolePrompt(definition, 'implement', { outcome: 'changes', summary: 'Поправить ввод' }, 'tree', [], true);
  assert(prompt.includes(definition.task));
  assert(prompt.includes('Особое условие задачи'));
  assert(prompt.includes('Поправить ввод'));
  assert(!prompt.includes('Your final response must be JSON'));
  assert(!prompt.includes('Read applicable AGENTS.md'));
  const legacy = rolePrompt(definition, 'implement', undefined, 'tree');
  assert(legacy.includes('Read applicable AGENTS.md'));
  assert(legacy.includes('Your final response must be JSON'));
  for (const nodeId of Object.keys(definition.nodes)) {
    for (const separateSystem of [false, true]) {
      assert(!rolePrompt(definition, nodeId, undefined, 'tree', [], separateSystem).includes('Ты участник DWF'));
    }
  }
});

test('ролевые промпты задают критерии завершения и доказательства результата', () => {
  const requirements = {
    worker: ['Return done when the task is complete', 'how you addressed the feedback'],
    reviewer: ['Return changes', 'or approve', 'triggering conditions and consequences'],
    verifier: ['Return approve', 'your own checks', 'expected and actual results'],
    orchestrator: ['Return done', 'missing information', 'participants\' reports and your own observations'],
  };
  for (const [role, fragments] of Object.entries(requirements)) {
    for (const fragment of fragments) assert(roleSystemPrompt(role).includes(fragment), `${role}: ${fragment}`);
    assert.equal(parseVerdict('{"outcome":"blocked","summary":"Не хватает доступа"}', role).outcome, 'blocked');
  }
});

test('каждая роль получает только собственные версии скиллов', () => {
  assert.deepEqual(roleSkills.worker.map(skill => skill.name), ['code-work']);
  assert.deepEqual(roleSkills.reviewer.map(skill => skill.name), ['code-review']);
  assert.deepEqual(roleSkills.verifier.map(skill => skill.name), ['code-verify']);
  assert.deepEqual(roleSkills.orchestrator.map(skill => skill.name), ['workflow-summary']);
  assert.deepEqual(roleSkills.planner.map(skill => skill.name), ['task-planning']);
  const allowed = {
    worker: ['read', 'glob', 'grep', 'webfetch', 'websearch', 'shell', 'edit', 'write'],
    reviewer: ['read', 'glob', 'grep', 'webfetch', 'websearch'],
    verifier: ['read', 'glob', 'grep', 'webfetch', 'websearch', 'shell'],
    orchestrator: ['read', 'glob', 'grep'],
    planner: [],
  };
  for (const [role, actions] of Object.entries(allowed)) {
    assert.deepEqual(rolePermissions(role), [
      { action: '*', resource: '*', effect: 'deny' },
      ...actions.map(action => ({ action, resource: '*', effect: 'allow' })),
      ...(roleSkills[role] ?? []).map(skill => ({ action: 'skill', resource: skill.id, effect: 'allow' })),
    ]);
  }
});

test('reviewer получает путь, базу, снимок и размер diff в поручении', () => {
  const definition = sampleWorkflow('Проверить результат');
  const review = { base: 'initial-commit', revision: 'reviewed-tree', path: '/state/review.diff', bytes: 512 };
  const prompt = rolePrompt(definition, 'review', undefined, review.revision, [], true, review);
  assert(prompt.includes(JSON.stringify(review)));
  const relativePrompt = rolePrompt(definition, 'review', undefined, review.revision, [], true, review, { path: '/state/worktree' });
  assert(relativePrompt.includes('"path":"../review.diff"'));
  assert.equal(review.path, '/state/review.diff');
  assert(!rolePrompt(definition, 'implement', undefined, 'tree', [], true).includes('Материалы ревью'));
});

test('orchestrator получает все завершённые этапы, включая замечания и доработку', () => {
  const definition = sampleWorkflow('Выполнить задачу');
  const visits = [
    { node: 'implement', sessionId: 'worker-session', revision: 'first', verdict: { outcome: 'done', summary: 'first implementation' } },
    { node: 'review', sessionId: 'review-session', revision: 'first', verdict: { outcome: 'changes', summary: 'fix unknown flag' } },
    { node: 'implement', sessionId: 'worker-session', revision: 'fixed', verdict: { outcome: 'done', summary: 'unknown flag fixed' } },
    { node: 'review', sessionId: 'review-session', revision: 'fixed', verdict: { outcome: 'approve', summary: 'review approved' } },
    { node: 'verify', sessionId: 'verify-session', revision: 'fixed', verdict: { outcome: 'approve', summary: 'checks passed' } },
    { node: 'summarize', sessionId: 'summary-session' },
  ];
  const prompt = rolePrompt(definition, 'summarize', visits[4].verdict, 'fixed', visits);
  const history = JSON.parse(prompt.match(/Завершённые этапы workflow \(по порядку\):\n([^\n]+)/)?.[1] ?? 'null');
  assert.deepEqual(history, visits.slice(0, 5).map((visit, index) => ({
    visit: index + 1, node: visit.node, role: definition.nodes[visit.node].role,
    sessionId: visit.sessionId, revision: visit.revision, result: visit.verdict,
  })));
});

test('публичный CLI показывает схему и сохраняет собственный пресет', async t => {
  const root = await fixture(t);
  const file = join(root, 'workflow.json');
  const definition = sampleWorkflow('Новая задача');
  await writeFile(file, JSON.stringify(definition));
  const cli = args => JSON.parse(execFileSync(process.execPath, ['dwf.mjs', ...args], {
    env: { ...process.env, DWF_STATE_DIR: join(root, 'state') }, encoding: 'utf8',
  }));
  const example = validateWorkflow(cli(['schema']).example);
  assert.equal(Object.keys(example.nodes).length, 1);
  assert.deepEqual(cli(['preset', 'list']).presets, []);
  assert.throws(() => cli(['start', '--preset', 'feature', '--task-file', file]), /Пресет не найден/);
  assert.deepEqual(cli(['preset', 'save', 'mine', '--file', file]), { preset: 'mine' });
  assert.deepEqual(cli(['preset', 'list']).presets, ['mine']);
  assert.deepEqual(presets(join(root, 'state'))[0].definition, definition);
});

test('итог завершённых workflow подтверждает merge и отделяет историческую сводку', () => {
  const state = { id: 'finished', definition: sampleWorkflow('Task'), status: 'succeeded',
    workspace: { path: '/state/worktree', branch: 'main' }, visits: [],
    result: { summary: 'Merge is still pending.', commit: 'verified-commit' } };
  const result = publicWorkflow(state).result;
  assert.deepEqual(result.integration, { status: 'merged', branch: 'main', commit: 'verified-commit' });
  assert(result.summary.startsWith('DWF подтвердил локальный merge в main. Коммит verified-commit.'));
  assert(result.summary.endsWith('Отчёт участника до интеграции\nMerge is still pending.'));
  assert.equal(state.result.summary, 'Merge is still pending.');
  assert.deepEqual(publicWorkflow({ ...state, result: { outcome: 'done', summary: 'No integration requested.' } }).result,
    { outcome: 'done', summary: 'No integration requested.' });
});

test('watch передаёт изменения без повторения истории и позволяет восстановить состояние', () => {
  const report = 'Completed stage report. '.repeat(100);
  let state = { runId: 'watch-test', status: 'running',
    current: { node: 'review', progress: { updatedAt: 1 } },
    history: [{ node: 'work', sessionId: 'worker', result: { outcome: 'done', summary: report } }] };
  const states = [structuredClone(state)];
  const events = [watchEvent(undefined, state)];
  assert.equal(watchEvent(state, structuredClone(state)), undefined);
  for (let updatedAt = 2; updatedAt <= 30; updatedAt++) {
    const next = { ...state, current: { node: 'review', progress: { updatedAt } } };
    const event = watchEvent(state, next);
    assert.equal(event.type, 'update');
    assert.equal(event.historyUpdates, undefined);
    assert(!JSON.stringify(event).includes(report));
    states.push(structuredClone(next));
    events.push(event);
    state = next;
  }
  for (const next of [
    { ...state, service: { status: 'unavailable' }, history: [...state.history, { node: 'review', sessionId: 'reviewer' }] },
    { ...state, history: [...state.history, { node: 'review', sessionId: 'reviewer', result: { outcome: 'changes', summary: 'Fix input validation.' } }] },
    { ...state, status: 'failed', error: 'Verification setup failed.' },
  ]) {
    const event = watchEvent(state, next);
    if (state.service && !next.service) assert.deepEqual(event.removed, ['service']);
    if (event.type === 'update') assert.deepEqual(event.historyUpdates.map(update => update.index), [1]);
    events.push(event);
    states.push(structuredClone(next));
    state = next;
  }
  assert.equal(events.at(-1).type, 'snapshot');
  assert.equal(watchEvent(undefined, state).type, 'snapshot');
  const stream = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  assert.deepEqual(watchStates(stream), states);
  const fullSnapshots = states.map(value => JSON.stringify(value)).join('\n');
  assert(Buffer.byteLength(stream) < Buffer.byteLength(fullSnapshots) / 4);
  const shortened = { ...states[0], history: [] };
  assert.equal(watchEvent(states[0], shortened).type, 'snapshot');
});

test('inspect --watch передаёт изменения и финал, повторное подключение читает тот же запуск', async t => {
  const root = await fixture(t);
  const state = { id: randomUUID(), definition: sampleWorkflow('Task'), status: 'running',
    workspace: { path: join(root, 'worktree'), branch: 'main' },
    visits: [{ node: 'implement', sessionId: 'session', startedAt: 10 }], sessions: {} };
  createWorkflow(root, state);
  assert(claimWorkflow(root, state.id, 'test-owner'));
  const options = { env: { ...process.env, DWF_STATE_DIR: root } };
  const argv = ['dwf.mjs', 'inspect', state.id, '--watch'];
  let watcher = launch([process.execPath], argv, options);
  const snapshots = () => watchStates(watcher.stdout);
  try {
    await waitFor(() => snapshots().length === 1, 5000, 'первое состояние watch');
    await pause(700);
    assert.equal(snapshots().length, 1, 'неизменившееся состояние не дублируется');
    watcher.child.kill('SIGTERM');
    await within(watcher.close, 5000, 'закрытие первого наблюдателя');
    assert.equal(getWorkflow(root, state.id).status, 'running');
    assert(workflowHasOwner(root, state.id));
    state.visits[0].progress = { updatedAt: 30, message: 'Checking behavior', tools: [{ name: 'shell', status: 'running' }] };
    updateWorkflow(root, state, 'test-owner');
    watcher = launch([process.execPath], argv, options);
    await waitFor(() => snapshots().length === 1, 5000, 'повторное подключение watch');
    assert.equal(snapshots()[0].current.progress.message, 'Checking behavior');
    state.visits[0].progress.tools[0].status = 'completed';
    state.visits[0].progress.updatedAt = 40;
    updateWorkflow(root, state, 'test-owner');
    await waitFor(() => snapshots().length === 2, 5000, 'обновление инструментов');
    state.status = 'succeeded';
    state.result = { commit: 'final-commit', summary: 'Checks passed.' };
    updateWorkflow(root, state, 'test-owner', true);
    assert.equal((await within(watcher.exit, 5000, 'финальное состояние watch')).code, 0);
    await within(watcher.close, 5000, 'завершение вывода watch');
    assert.equal(snapshots().length, 3);
    assert.equal(snapshots().at(-1).result.integration.status, 'merged');
    const saved = execFileSync(process.execPath, ['dwf.mjs', 'inspect', state.id], { ...options, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(saved), snapshots().at(-1));
    assert.equal(watcher.stderr, '');
  } finally {
    if (!watcher.exited) watcher.child.kill('SIGTERM');
    await within(watcher.close, 5000, 'очистка наблюдателя');
  }
});

test('владение workflow ограждает состояние от другого контроллера и сохраняет пресеты', async t => {
  const root = await fixture(t);
  const state = { id: 'first', status: 'running', visits: [] };
  createWorkflow(root, state);
  assert.equal(claimWorkflow(root, state.id, 'owner-a'), true);
  assert.equal(claimWorkflow(root, state.id, 'owner-b'), false);
  assert.equal(workflowHasOwner(root, state.id), true);
  assert.throws(() => updateWorkflow(root, { ...state, status: 'failed' }, 'owner-b'));
  assert.equal(getWorkflow(root, state.id).status, 'running');
  updateWorkflow(root, { ...state, status: 'succeeded' }, 'owner-a', true);
  assert.equal(workflowHasOwner(root, state.id), false);
  savePreset(root, 'mine', sampleWorkflow('Первая задача'));
  savePreset(root, 'mine', sampleWorkflow('Новая задача'));
  assert.equal(presets(root).length, 1);
  assert.equal(presets(root)[0].definition.task, 'Новая задача');
});

async function repository(t) {
  const root = await fixture(t);
  const source = join(root, 'repo');
  await mkdir(source);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'original.txt'), 'original\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'initial']);
  return { root, source };
}

test('перенос в worktree сохраняет унаследованные инструкции исходного проекта', async t => {
  const { root, source } = await repository(t);
  const inherited = join(root, 'AGENTS.md');
  await writeFile(inherited, 'Parent project instruction.');
  const workspace = prepareWorkspace(join(root, 'state'), source, 'context');
  await writeFile(inherited, 'Changed after start.');
  const canonical = await realpath(inherited);
  assert(workspace.instructions.some(item => item.path === canonical && item.content === 'Parent project instruction.'));
  const prompt = rolePrompt(sampleWorkflow('Task'), 'review', undefined, 'snapshot', [], true, undefined, workspace);
  assert(prompt.includes(workspace.path));
  assert(prompt.includes('Parent project instruction.'));
  assert(!prompt.includes('Changed after start.'));
});

test('проверенное дерево изолировано от исходного и сливается идемпотентно', async t => {
  const { root, source } = await repository(t);
  const workspace = prepareWorkspace(join(root, 'state'), source, 'first');
  await writeFile(join(workspace.path, 'feature.txt'), 'feature\n');
  const before = git(workspace.path, ['status', '--porcelain']);
  const approved = tree(workspace.path);
  assert.equal(git(workspace.path, ['status', '--porcelain']), before);
  assert.equal(git(source, ['status', '--porcelain']), '');
  const commit = mergeWorkspace(workspace, approved);
  assert.equal(await readFile(join(source, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(git(source, ['rev-parse', 'HEAD^{tree}']), approved);
  assert.equal(mergeWorkspace(workspace, approved), commit);
});

test('изменения после проверки и продвижение исходной ветки блокируют merge', async t => {
  const { root, source } = await repository(t);
  const workspace = prepareWorkspace(join(root, 'state'), source, 'first');
  const approved = tree(workspace.path);
  await writeFile(join(workspace.path, 'extra.txt'), 'unreviewed\n');
  assert.throws(() => mergeWorkspace(workspace, approved), /изменилось/);
  const candidate = tree(workspace.path);
  await writeFile(join(source, 'parallel.txt'), 'parallel\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'parallel']);
  assert.throws(() => mergeWorkspace(workspace, candidate), /продвинулась/);
});

test('полный diff воспроизводит снимок с удалениями, binary и незакоммиченными файлами', async t => {
  const { root, source } = await repository(t);
  const workspace = prepareWorkspace(join(root, 'state'), source, 'diff');
  const file = join(root, 'reviews', 'first.diff');
  const empty = writeReviewDiff(workspace, tree(workspace.path), file);
  assert.equal(empty.bytes, 0);
  await rm(join(workspace.path, 'original.txt'));
  await writeFile(join(workspace.path, 'staged.txt'), 'staged\n');
  git(workspace.path, ['add', '--all']);
  git(workspace.path, ['commit', '-m', 'intermediate']);
  await writeFile(join(workspace.path, 'staged.txt'), 'staged and edited\n');
  await writeFile(join(workspace.path, 'новое имя\n.txt'), 'untracked\n');
  await writeFile(join(workspace.path, 'data.bin'), Buffer.from([0, 1, 2, 255]));
  const beforeIndex = git(workspace.path, ['status', '--porcelain']);
  const revision = tree(workspace.path);
  const review = writeReviewDiff(workspace, revision, file);
  assert.equal(git(workspace.path, ['status', '--porcelain']), beforeIndex);
  assert.equal(review.base, workspace.base);
  assert.equal(review.revision, revision);
  assert.equal(review.bytes, (await stat(file)).size);
  assert.equal((await stat(file)).mode & 0o777, 0o400);
  const alternateIndex = { GIT_INDEX_FILE: join(root, 'verification.index') };
  git(workspace.path, ['read-tree', workspace.base], alternateIndex);
  git(workspace.path, ['apply', '--cached', '--binary', file], alternateIndex);
  assert.equal(git(workspace.path, ['write-tree'], alternateIndex), revision);
  await writeFile(join(workspace.path, 'staged.txt'), 'second revision\n');
  const next = writeReviewDiff(workspace, tree(workspace.path), join(root, 'reviews', 'second.diff'));
  assert.notEqual(next.revision, review.revision);
  assert((await readFile(file, 'utf8')).includes('+staged and edited'));
  assert((await readFile(next.path, 'utf8')).includes('+second revision'));
  const oldSnapshot = writeReviewDiff(workspace, revision, join(root, 'reviews', 'old-snapshot.diff'));
  assert.deepEqual(await readFile(oldSnapshot.path), await readFile(file));
  assert.throws(() => writeReviewDiff(workspace, 'missing-tree', join(root, 'reviews', 'failed.diff')), /полный diff/);
  assert.deepEqual((await readdir(join(root, 'reviews'))).sort(), ['first.diff', 'old-snapshot.diff', 'second.diff']);
});

test('diff больше 16 MiB сохраняется полностью', async t => {
  const { root, source } = await repository(t);
  const workspace = prepareWorkspace(join(root, 'state'), source, 'large-diff');
  const data = Buffer.concat([Buffer.alloc(17 * 1024 * 1024, 'x'), Buffer.from('END-OF-LARGE-DIFF\n')]);
  await writeFile(join(workspace.path, 'large.txt'), data);
  const revision = tree(workspace.path);
  const review = writeReviewDiff(workspace, revision, join(root, 'reviews', 'large.diff'));
  assert(review.bytes > 17 * 1024 * 1024);
  assert((await readFile(review.path)).subarray(-19).includes(Buffer.from('END-OF-LARGE-DIFF')));
  const alternateIndex = { GIT_INDEX_FILE: join(root, 'large.index') };
  git(workspace.path, ['read-tree', workspace.base], alternateIndex);
  git(workspace.path, ['apply', '--cached', '--binary', review.path], alternateIndex);
  assert.equal(git(workspace.path, ['write-tree'], alternateIndex), revision);
});
