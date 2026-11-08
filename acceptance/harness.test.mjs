import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExecutionStopped, captureOwnedExecution, assertOriginalAlive, createSandbox,
  originalStillWorking, plannerResult, readJson, taggedProcesses,
  waitFor, within } from './harness.mjs';
import { verifyReport } from './verify-lifetime-mutation.mjs';

// Native HTTP model/lifetime checks are executable in the same harness gate.
import './controlled-http-provider.test.mjs';
import './observe-model.test.mjs';

test('reread требует owned backend и подтверждённое исчезновение именно его PID', async () => {
  const sandbox = await createSandbox();
  const other = await createSandbox();
  try {
    const fixture = sandbox.spawn([process.execPath], ['-e', 'setInterval(()=>{},1000)']);
    const foreign = other.spawn([process.execPath], ['-e', 'setInterval(()=>{},1000)']);
    await waitFor(() => taggedProcesses(sandbox.token).some(item => item.pid === fixture.child.pid), 3000, 'owned child');
    await waitFor(() => taggedProcesses(other.token).some(item => item.pid === foreign.child.pid), 3000, 'unowned child');
    // Classification is injected only in this helper unit test; product acceptance reads actual ps comm.
    assert.throws(() => captureOwnedExecution({ sandbox }, () => 'opencode'), /HARNESS_EXECUTION_WITNESS/);
    const world = { sandbox: { ...sandbox, records: [] } };
    assert.throws(() => captureOwnedExecution(world, () => 'node'), /HARNESS_EXECUTION_WITNESS/);
    assert.throws(() => captureOwnedExecution(world, pid => pid === foreign.child.pid ? 'opencode' : 'node'),
      /HARNESS_EXECUTION_WITNESS/);
    const execution = captureOwnedExecution(world, pid => pid === fixture.child.pid ? 'opencode' : 'node');
    assert.equal(execution.length, 1);
    assert.equal(execution[0].pid, fixture.child.pid);
    await assert.rejects(assertExecutionStopped(execution), /HARNESS_EXECUTION_WITNESS.*ещё жив/);
    await sandbox.cleanupProcesses();
    await assertExecutionStopped(execution);
    process.kill(foreign.child.pid, 0); // Cleanup did not touch a process from another test.
  } finally {
    await sandbox.cleanup();
    await other.cleanup();
  }
});

test('приём поручения и незавершённый ответ не доказывают готовый результат', () => {
  const old = [{ type: 'received', callId: 'old' }, { type: 'completed', callId: 'old', stopReason: 'stop', text: 'Старый план' }];
  const pending = [...old, { type: 'received', callId: 'current' }];
  assert.throws(() => plannerResult(pending), /не доказывает завершение/);
  for (const stopReason of ['length', 'error', 'aborted', 'toolUse']) {
    assert.throws(() => plannerResult([...pending,
      { type: 'completed', callId: 'current', stopReason, text: 'Не готовый итог' }]), /не вернул итоговый ответ/);
  }
  const exact = '  План\n\n\tШаг\u2028проверка\u2029\n  ';
  assert.equal(plannerResult([...pending, { type: 'completed', callId: 'current', stopReason: 'stop', text: exact }]), exact);
});

test('mutation verifier требует именно потерю исходного SSE transport и отвергает технические сбои', () => {
  const callId = 'first';
  const evidence = { runId: 'test-run', lifetimeFailure: { callId, transport: { callId, closed: true, completed: false },
    startExited: true, promptVerified: true, completed: false },
    provider: [{ type: 'received', callId }, { type: 'transport-closed', callId, completed: false }] };
  const report = [{ elements: [{ type: 'scenario', steps: [
    { name: 'клиент получает идентификатор запуска и завершается', result: { status: 'passed' } },
    { name: 'исполнитель получил поручение, но ещё не завершил его', result: { status: 'failed',
      error_message: 'LIFETIME_FAILURE: исходный SSE transport закрылся до завершения удержанного ответа' } },
    { keyword: 'After', result: { status: 'passed' }, embeddings: [{ mime_type: 'application/json',
      data: Buffer.from(JSON.stringify(evidence)).toString('base64') }] },
  ] }] }];
  verifyReport('broken', 1, report);
  for (const cause of ['TECHNICAL_BLOCKER: spawn dwf ENOENT', 'SyntaxError', 'Cannot find module', 'TIMEOUT']) {
    const changed = structuredClone(report);
    changed[0].elements[0].steps[1].result.error_message = cause;
    assert.throws(() => verifyReport('broken', 1, changed), /не доказывают/);
  }
  const missing = structuredClone(report); missing[0].elements[0].steps[2].embeddings = [];
  assert.throws(() => verifyReport('broken', 1, missing), /свидетельство/);
  const wrong = structuredClone(evidence); wrong.provider[1].callId = 'other';
  const changed = structuredClone(report);
  changed[0].elements[0].steps[2].embeddings[0].data = Buffer.from(JSON.stringify(wrong)).toString('base64');
  assert.throws(() => verifyReport('broken', 1, changed), /исходного HTTP/);
});

test('проверка жизни перечитывает завершение после исчезновения процесса и выявляет новый вызов', async () => {
  for (const additionalCall of [false, true]) {
    const world = { sandbox: { token: 'test-token' }, ready: { callId: 'first', identity: {}, prompt: 'task' },
      task: 'task', startClient: { exited: true }, released: true };
    const recorded = [{ type: 'received', callId: 'first' }];
    let reads = 0;
    const check = originalStillWorking(world, async () => { reads++; return [...recorded]; }, (token, identity) => {
      assert.equal(token, world.sandbox.token); assert.equal(identity, world.ready.identity);
      // Детерминированный порядок: первый снимок уже прочитан, затем завершение и выход.
      recorded.push({ type: 'completed', callId: 'first' });
      if (additionalCall) recorded.push({ type: 'received', callId: 'replacement' });
      throw new Error('LIFETIME_FAILURE: процесс уже завершился');
    });
    if (additionalCall) await assert.rejects(check, /Новый модельный вызов/);
    else await assert.doesNotReject(check);
    assert.equal(reads, 2);
    assert.equal(world.lifetimeFailure, undefined);
  }
});

test('проверка жизни отвергает исчезновение без завершения первоначального вызова', async () => {
  const world = { sandbox: { token: 'test-token' }, ready: { callId: 'first', identity: {}, prompt: 'task' },
    task: 'task', startClient: { exited: true }, released: true };
  const recorded = [{ type: 'received', callId: 'first' }];
  const failure = new Error('LIFETIME_FAILURE: первоначальный процесс прекратил удержанную незавершённую работу');
  await assert.rejects(originalStillWorking(world, async () => [...recorded], () => {
    // Завершение другого callId не заменяет отсутствующий ответ первоначального вызова.
    recorded.push({ type: 'completed', callId: 'other' });
    throw failure;
  }), error => error === failure);
  assert.deepEqual(world.lifetimeFailure, { callId: 'first', identity: world.ready.identity,
    startExited: true, promptVerified: true, completed: false, released: true });
});

test('очистка после ошибки убирает отделившийся процесс, сохраняет чужой и отвергает неверную идентичность', async () => {
  const sandbox = await createSandbox();
  const other = await createSandbox();
  let orphan;
  try {
    const foreign = other.spawn([process.execPath], ['-e', 'setInterval(()=>{},1000)']);
    await waitFor(() => taggedProcesses(other.token).find(item => item.pid === foreign.child.pid), 3000, 'чужой процесс');
    await assert.rejects((async () => {
      try {
        const receipt = join(sandbox.control, 'orphan.json');
        const source = `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
          writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:child.pid}));child.unref();`;
        const parent = sandbox.spawn([process.execPath], ['--input-type=module', '-e', source]);
        await within(parent.exit, 3000, 'выход родителя самопроверки');
        orphan = await readJson(receipt);
        const identity = taggedProcesses(sandbox.token).find(item => item.pid === orphan.pid);
        assert(identity); assertOriginalAlive(sandbox.token, identity);
        assert.throws(() => assertOriginalAlive(sandbox.token, { ...identity, born: 'other-birth' }), /LIFETIME_FAILURE/);
        throw new Error('намеренное падение harness');
      } finally { await sandbox.cleanup(); }
    })(), /намеренное падение harness/);
    assert.throws(() => process.kill(orphan.pid, 0), { code: 'ESRCH' });
    assert.equal(foreign.exited, false); process.kill(foreign.child.pid, 0);
    await assert.rejects(access(sandbox.root), { code: 'ENOENT' });
  } finally { await other.cleanup(); }
});
