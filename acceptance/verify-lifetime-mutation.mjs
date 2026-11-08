// Не создаёт и не изменяет продукт: проверяет доказательства ручной временной поломки.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { snapshot } from './harness.mjs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export function verifyReport(phase, status, report) {
  const scenarios = report.flatMap(feature => feature.elements ?? []).filter(item => item.type === 'scenario');
  assert.equal(scenarios.length, 1, 'Должен действительно исполниться основной Gherkin-сценарий');
  const steps = scenarios[0].steps;
  assert(steps.length > 0, 'Пустой отчёт не является исполнением сценария');
  if (phase !== 'broken') {
    assert.equal(status, 0, 'Нужен рабочий продукт и зелёный исходный сценарий');
    assert(steps.every(step => step.result.status === 'passed'), 'Недопустимы pending, undefined или пропуски');
    return;
  }
  assert.equal(status, 1, 'Конкретная поломка должна приводить к падению приёмки');
  assert.equal(steps.find(step => step.name === 'клиент получает идентификатор запуска и завершается')?.result.status,
    'passed', 'Нужен нормальный runId и фактический выход start');
  const failures = steps.filter(step => step.result.status === 'failed');
  assert.equal(failures.length, 1);
  assert(['исполнитель получил поручение, но ещё не завершил его', 'тест разрешает исполнителю завершить поручение',
    'другой клиент через CLI получает по идентификатору успешное состояние'].includes(failures[0].name));
  assert.match(failures[0].result.error_message, /LIFETIME_FAILURE: исходный SSE transport закрылся до завершения удержанного ответа/,
    'Таймаут, ENOENT, импорт и случайное падение не доказывают целевую поломку');
  const after = steps.findLast(step => step.keyword === 'After');
  assert.equal(after?.result.status, 'passed', 'Очистка должна пройти');
  const evidence = (after.embeddings ?? []).filter(item => item.mime_type === 'application/json')
    .map(item => JSON.parse(Buffer.from(item.data, 'base64').toString('utf8')))
    .find(item => item.lifetimeFailure);
  assert(evidence?.runId, 'Нужно независимое свидетельство жизненного цикла');
  const failure = evidence.lifetimeFailure;
  assert(failure.startExited && failure.promptVerified && failure.completed === false);
  const received = evidence.provider.filter(event => event.type === 'received' && event.callId === failure.callId);
  assert.equal(received.length, 1, 'Нужно фактическое получение поручения первоначальным провайдером');
  assert.equal(failure.transport?.callId, failure.callId);
  assert.equal(failure.transport?.closed, true);
  assert(evidence.provider.some(event => event.type === 'transport-closed' && event.callId === failure.callId),
    'Нужно наблюдение закрытия именно исходного HTTP transport');
  assert(!evidence.provider.some(event => event.type === 'completed' && event.callId === failure.callId));
}

async function main() {
  const phase = process.argv[2];
  assert(['before', 'broken', 'after'].includes(phase), 'Запуск: npm run test:mutation -- before|broken|after');
  const results = process.env.DWF_TEST_RESULTS_DIR ?? 'acceptance-results/opencode-cli';
  await mkdir(results, { recursive: true });
  const proofFile = name => join(results, `mutation-${name}.proof.json`);
  const readProof = async name => JSON.parse(await readFile(proofFile(name), 'utf8'));
  if (phase === 'before') {
    await Promise.all(['before', 'broken', 'after'].map(name => rm(proofFile(name), { force: true })));
  } else { await rm(proofFile(phase), { force: true }); }
  const cycle = phase === 'before' ? randomUUID() : (await readProof('before')).cycle;
  const suiteHash = createHash('sha256').update(JSON.stringify({
    files: await snapshot('acceptance'), config: await readFile('cucumber.mjs', 'utf8'),
    package: await readFile('package.json', 'utf8'), lock: await readFile('package-lock.json', 'utf8'),
    cli: process.env.DWF_TEST_CLI,
  })).digest('hex');
  if (phase !== 'before') {
    assert.equal((await readProof('before')).suiteHash, suiteHash, 'Тесты нельзя менять между фазами проверки');
  }
  if (phase === 'after') assert.equal((await readProof('broken')).cycle, cycle, 'Нужна поломка из этого эксперимента');
  const reportFile = join(results, `mutation-${phase}.json`);
  const run = spawnSync('node_modules/.bin/cucumber-js', ['--config', 'cucumber.mjs', '--tags', '@lifetime',
    '--format', `json:${reportFile}`], { stdio: 'inherit', shell: false });
  if (run.error) throw run.error;
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  verifyReport(phase, run.status, report);
  await writeFile(proofFile(phase), JSON.stringify({ phase, cycle, suiteHash, verified: true }, null, 2));
  console.log(`Проверена фаза ${phase}; отчёт: ${reportFile}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
