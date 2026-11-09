import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createRun, getRun, markAdmitted, saveOutcome, withServiceLock } from './run-store.mjs';
import { admit, readOutcome, readExecution, outcomeFromMessages, progressFromMessages } from './opencode-runtime.mjs';

const execute = promisify(execFile);
const inputId = 'msg_input';
const user = { id: inputId, type: 'user' };
const assistant = (text, finish = 'stop') => ({
  id: randomUUID(), type: 'assistant', finish, time: { completed: 1 },
  content: [{ type: 'text', text }],
});
const idle = outcome => ({ type: 'idle', outcome });

test('справка успешно описывает доступный прототип без запуска поручения', async () => {
  for (const option of ['--help', '-h']) {
    const { stdout } = await execute(process.execPath, ['dwf.mjs', option], {
      env: { ...process.env, DWF_STATE_DIR: 'invalid-relative-state' },
    });
    assert.match(stdout, /worker, reviewer, verifier, orchestrator/);
    assert.match(stdout, /dwf start --file workflow\.json/);
    assert.match(stdout, /dwf inspect <run-id>/);
    assert.match(stdout, /"planner":\{"task":/);
    assert.match(stdout, /dwf start --preset <имя>/);
    assert.match(stdout, /dwf preset save <имя> --from-run <run-id>/);
  }
});

test('справка подкоманд доступна без настройки сервиса', async () => {
  for (const command of [['start'], ['inspect'], ['schema'], ['preset'], ['preset', 'list'], ['preset', 'save']]) {
    for (const option of ['--help', '-h']) {
      const { stdout, stderr } = await execute(process.execPath, ['dwf.mjs', ...command, option], {
        env: { ...process.env, DWF_STATE_DIR: 'invalid-relative-state' },
      });
      assert.match(stdout, new RegExp(`dwf ${command[0]}`));
      assert.equal(stderr, '');
    }
  }
});

test('прогресс относится к текущему поручению и содержит только видимые сообщения и инструменты', async () => {
  const current = { ...user, time: { created: 20 } };
  const working = { type: 'assistant', time: { created: 21, streamed: 22 }, content: [
    { type: 'reasoning', text: 'private reasoning' },
    { type: 'text', text: 'Running the focused checks.' },
    { type: 'tool', name: 'shell', state: { status: 'running', input: { command: 'private argument' } },
      time: { created: 23, ran: 24 } },
  ] };
  const messages = [assistant('earlier turn'), current, working];
  const expected = { startedAt: 20, updatedAt: 24, message: 'Running the focused checks.',
    tools: [{ name: 'shell', status: 'running' }] };
  assert.deepEqual(progressFromMessages([...messages, { id: 'next', type: 'user' }, assistant('future turn')], inputId), expected);
  assert.equal(progressFromMessages([working], inputId), undefined);
  let calls = 0;
  const client = { message: { list: async () => { calls++; return { data: messages, cursor: {} }; } } };
  assert.deepEqual(await readExecution(client, { sessionId: 'session', inputId }), { outcome: undefined, progress: expected });
  assert.equal(calls, 1);
  const retry = { ...working, content: [], retry: { attempt: 2, at: 30, error: { response: 'private transport data' } } };
  assert.deepEqual(progressFromMessages([current, retry], inputId).retry, { attempt: 2, at: 30 });
  const finished = { ...assistant('{"outcome":"done"}'), time: { completed: 40 } };
  const final = progressFromMessages([...messages, retry, finished], inputId);
  assert.equal(final.updatedAt, 40);
  assert.equal(final.message, expected.message);
  assert.equal(final.retry, undefined);
});

test('результат связан с поручением и сохраняет точный текст всех продолжений', () => {
  const final = assistant(' второй\n  ');
  assert.deepEqual(outcomeFromMessages([
    assistant('Чужой ответ'), idle('succeeded'), user,
    assistant('  Первый', 'length'), { type: 'synthetic' }, final, idle('succeeded'),
    { id: 'msg_next', type: 'user' }, assistant('Следующий ответ'),
  ], inputId), { status: 'succeeded', result: '  Первый второй\n  ', answerId: final.id });
});

test('неполный ответ, окончательная ошибка и отсутствие текста не становятся успехом', () => {
  assert.equal(outcomeFromMessages([user, assistant('ещё пишется')], inputId), undefined);
  assert.equal(outcomeFromMessages([user, assistant('обрывок', 'length'), idle('failed')], inputId).status, 'failed');
  assert.equal(outcomeFromMessages([user, assistant('  '), idle('succeeded')], inputId).status, 'failed');
  assert.equal(outcomeFromMessages([user, assistant('обрывок', 'length'), idle('succeeded')], inputId).status, 'failed');
  assert.equal(outcomeFromMessages([user, assistant('обрывок'), idle('interrupted')], inputId).status, 'failed');
  assert.equal(outcomeFromMessages([assistant('посторонний'), idle('succeeded')], inputId), undefined);
});

test('возобновление после idle отменяет ранний ответ и принимает поздний результат отдельно', () => {
  const first = [user, assistant('early approve'), idle('succeeded')];
  const resumed = [...first, { type: 'synthetic' }];
  assert.equal(outcomeFromMessages(resumed, inputId), undefined);
  assert.equal(outcomeFromMessages([...resumed, { type: 'assistant', content: [] }], inputId), undefined);
  const final = assistant('later changes');
  assert.deepEqual(outcomeFromMessages([...resumed, final, idle('succeeded')], inputId),
    { status: 'succeeded', result: 'later changes', answerId: final.id });
});

test('терминальный ответ перечитывается после появления idle на следующей странице', async () => {
  const streaming = assistant('Проверяю');
  delete streaming.finish;
  delete streaming.time.completed;
  const final = { ...streaming, finish: 'stop', time: { completed: 1 },
    content: [{ type: 'text', text: '{"outcome":"approve","summary":"Проверки прошли"}' }] };
  const requests = [];
  const pages = [
    { data: [user, streaming], cursor: { next: 'tail' } },
    { data: [idle('succeeded')], cursor: {} },
    { data: [user, final, idle('succeeded')], cursor: {} },
    { data: [user, final, idle('succeeded')], cursor: {} },
  ];
  const client = { session: { active: async () => ({}), inbox: { list: async () => [] } }, message: { list: async query => {
    requests.push(query);
    const page = pages.shift();
    assert(page, 'Лишний запрос истории');
    return page;
  } } };
  assert.deepEqual(await readOutcome(client, { sessionId: 'session', inputId }),
    { status: 'succeeded', result: final.content[0].text, answerId: final.id });
  assert.equal(requests.length, 4);
  assert.equal(requests[1].cursor, 'tail');
  assert.equal(requests[2].cursor, undefined);
});

test('ранний idle не завершается при активной сессии или ожидающем inbox', async () => {
  const messages = [user, assistant('early approve'), idle('succeeded')];
  for (const pending of ['active', 'inbox']) {
    const client = { message: { list: async () => ({ data: messages, cursor: {} }) },
      session: { active: async () => pending === 'active' ? { session: true } : {},
        inbox: { list: async () => pending === 'inbox' ? [{ id: 'pending' }] : [] } } };
    assert.equal(await readOutcome(client, { sessionId: 'session', inputId }), undefined);
  }
});

test('ответ изменившийся во время проверки activity ожидает нового полного опроса', async () => {
  const early = assistant('approve');
  const late = assistant('changes');
  let current = early;
  const client = { message: { list: async () => ({ data: [user, current, idle('succeeded')], cursor: {} }) },
    session: { active: async () => { current = late; return {}; }, inbox: { list: async () => [] } } };
  assert.equal(await readOutcome(client, { sessionId: 'session', inputId }), undefined);
  assert.deepEqual(await readOutcome(client, { sessionId: 'session', inputId }),
    { status: 'succeeded', result: 'changes', answerId: late.id });
});

test('перечитывание не скрывает подтверждённую ошибку и не опрашивает незавершённый ответ дважды', async () => {
  for (const messages of [[user, assistant('Проверяю')], [user, assistant('Обрыв', 'length'), idle('failed')]]) {
    let calls = 0;
    const client = { message: { list: async () => { calls++; return { data: messages, cursor: {} }; } } };
    const result = await readOutcome(client, { sessionId: 'session', inputId });
    assert.equal(result?.status, messages.at(-1).type === 'idle' ? 'failed' : undefined);
    assert.equal(calls, messages.at(-1).type === 'idle' ? 2 : 1);
  }
});

test('повтор admission сохраняет идентичность сессии и input', async () => {
  const run = { id: randomUUID(), sessionId: 'ses_repeat', inputId,
    request: { session: { metadata: {} }, text: 'Поручение' } };
  let session;
  const inputs = new Map();
  const client = { session: {
    get: async () => session,
    prompt: async input => { inputs.set(input.id, input); },
  } };
  session = { metadata: { dwfRunId: run.id } };
  await admit(client, run);
  await admit(client, run);
  assert.equal(inputs.size, 1);
  assert.deepEqual(inputs.get(inputId), { sessionID: run.sessionId, id: inputId, text: run.request.text });
  session.metadata.dwfRunId = 'another-run';
  await assert.rejects(admit(client, run), /не принадлежит/);
});

test('сохранённый результат читается без OpenCode, ошибку связи не сохраняют как failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dwf-store-test-'));
  const id = randomUUID();
  const run = { id, sessionId: 'ses_' + randomUUID(), inputId: 'msg_' + randomUUID(), request: { text: 'Поручение' } };
  try {
    createRun(root, run);
    markAdmitted(root, id);
    const env = { ...process.env, DWF_STATE_DIR: root, OPENCODE_CONFIG: join(root, 'missing-config.json') };
    const pending = await execute(process.execPath, ['dwf.mjs', 'inspect', id], { env });
    const unavailable = JSON.parse(pending.stdout);
    assert.equal(unavailable.status, 'running');
    assert.equal(unavailable.service.status, 'unavailable');
    assert.equal(getRun(root, id).status, 'running');
    const result = '  План\n\tТочный текст\u2028\u2029  ';
    saveOutcome(root, id, { status: 'succeeded', result, answerId: 'msg_answer' });
    saveOutcome(root, id, { status: 'failed', error: 'поздний устаревший наблюдатель' });
    const completed = await execute(process.execPath, ['dwf.mjs', 'inspect', id], { env });
    assert.deepEqual(JSON.parse(completed.stdout), { runId: id, status: 'succeeded', result });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('несовместимая база отвергается до изменения её схемы или данных', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dwf-schema-test-'));
  const file = join(root, 'dwf.sqlite');
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE dwf_schema (version INTEGER PRIMARY KEY); INSERT INTO dwf_schema VALUES (99)');
  database.close();
  try {
    assert.throws(() => createRun(root, { id: 'unused' }), /Несовместимая версия/);
    const unchanged = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual(unchanged.prepare('SELECT version FROM dwf_schema').all().map(row => row.version), [99]);
      assert.deepEqual(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map(row => row.name), ['dwf_schema']);
    } finally { unchanged.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('одновременное создание первых запусков сохраняет все записи', async () => {
  const module = new URL('./run-store.mjs', import.meta.url).href;
  const source = `import { createRun } from ${JSON.stringify(module)};
    const id = process.argv[2];
    createRun(process.argv[1], { id, sessionId: 'ses_' + id, inputId: 'msg_' + id, request: { text: id } });`;
  for (let round = 0; round < 3; round++) {
    const root = await mkdtemp(join(tmpdir(), 'dwf-concurrent-test-'));
    const ids = Array.from({ length: 8 }, () => randomUUID());
    try {
      await Promise.all(ids.map(id => execute(process.execPath, ['--input-type=module', '-e', source, root, id])));
      for (const id of ids) assert.equal(getRun(root, id).request.text, id);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('ошибка запуска сервиса освобождает блокировку SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dwf-service-lock-test-'));
  try {
    await assert.rejects(withServiceLock(root, async () => { throw new Error('startup failed'); }), /startup failed/);
    assert.equal(await withServiceLock(root, async () => 'next startup'), 'next startup');
  } finally { await rm(root, { recursive: true, force: true }); }
});
