import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { benchmarkWorkflows, runBenchmark } from '../benchmark.mjs';
import { participantVisits } from '../../workflow-definition.mjs';
import { researchGraph, researchModel, researchResult } from '../../research-workflow.mjs';

export const standardModel = { providerID: researchModel.provider, id: researchModel.modelId, variant: 'high' };
export const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');

export async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function saveJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export function caseTask(caseId) {
  const item = cases[caseId];
  return `${item.question}\n\nИсточники для этого сравнения находятся в текущем каталоге. Начни с sources.md и проверяй полные тексты. Граница материалов — ${item.cutoff}. Используй локальный корпус. Дай подробный, но сфокусированный отчёт объёмом до 1200 слов со ссылками и условиями измерений.`;
}

export async function modelEvidence(file, sessions) {
  const events = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const sent = events.filter(event => event.type === 'received');
  const complete = events.filter(event => event.type === 'completed');
  const ids = new Set(sessions);
  assert(sent.length && sent.every(event => event.model.provider === standardModel.providerID &&
    event.model.modelId === standardModel.id && event.reasoning === standardModel.variant &&
    (event.serviceTier === undefined || event.serviceTier === 'default')), 'Unexpected model or service tier on the wire');
  assert(sessions.every(id => sent.some(event => event.providerSessionId === id)),
    'Missing outbound evidence for a participant');
  assert(!events.some(event => event.type === 'observer-error'), 'Model observer could not decode a request');
  const byId = new Map(sent.map(event => [event.callId, event]));
  const usage = {};
  for (const event of complete) {
    const session = byId.get(event.callId)?.providerSessionId;
    assert(ids.has(session), 'Unattributed model call');
    assert(Number.isFinite(event.inputTokens) && Number.isFinite(event.outputTokens), 'Missing token usage');
    const item = usage[session] ??= { requests: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
    item.requests++;
    item.input += event.inputTokens;
    item.cached += event.cachedInputTokens ?? 0;
    item.output += event.outputTokens;
    item.reasoning += event.reasoningTokens ?? 0;
  }
  assert(sessions.every(id => usage[id]), 'Missing usage for a participant');
  const totals = Object.fromEntries(['requests', 'input', 'cached', 'output', 'reasoning']
    .map(key => [key, Object.values(usage).reduce((sum, item) => sum + item[key], 0)]));
  return { sent: sent.length, completed: complete.length, totals, usage };
}

export function sessionTools(profile, sessions) {
  // Read the persisted native message history of the pinned OpenCode version after shutdown.
  const db = new DatabaseSync(join(profile, 'opencode.sqlite'), { readOnly: true });
  try {
    const messages = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq");
    return Object.fromEntries(sessions.map(session => [session, messages.all(session)
      .flatMap(row => JSON.parse(row.data).content ?? [])
      .filter(part => part.type === 'tool').map(part => ({ name: part.name, status: part.state.status }))]));
  } finally { db.close(); }
}

export function checkResearchRun(workflow, task) {
  assert.equal(workflow.status, 'succeeded', workflow.error);
  assert.equal(workflow.definition.task.trim(), task.trim());
  const graph = researchGraph(workflow.definition);
  assert(graph, 'The tester did not assemble research-mid');
  const scientists = workflow.visits.filter(visit => visit.node === graph.scientist);
  assert.equal(new Set(scientists.map(visit => visit.sessionId)).size, 1);
  const groups = workflow.visits.filter(visit => visit.children);
  assert.equal(groups[0]?.node, graph.scouts);
  assert.deepEqual(groups[0].children.map(child => child.item.id).sort(), ['foundations', 'recent']);
  const rounds = groups.slice(1);
  assert(rounds.length >= 1 && rounds.length <= 3);
  assert(rounds.every(group => group.node === graph.researchers && group.children.length === 4));
  for (const group of groups) {
    const next = workflow.visits[workflow.visits.indexOf(group) + 1];
    assert.equal(next.node, graph.scientist);
    assert.equal(group.verdict.results.length, group.children.length);
    assert(next.prompt.includes(JSON.stringify(group.verdict)));
  }
  const reviews = workflow.visits.filter(visit => visit.node === graph.committee);
  assert.equal(new Set(reviews.map(visit => visit.sessionId)).size, reviews.length);
  for (const review of reviews) {
    const report = workflow.visits[workflow.visits.indexOf(review) - 1];
    assert.equal(review.prompt, `Original research request\n${workflow.definition.task}\n\nSubmitted report\n${report.verdict.summary}`);
  }
  assert.deepEqual(workflow.result, researchResult(graph, workflow.visits));
  for (const participant of Object.values(workflow.participants)) {
    assert.deepEqual(participant.model, standardModel);
  }
  return { rounds: rounds.length, reviews: reviews.length,
    sessions: [...new Set(participantVisits(workflow.visits).map(visit => visit.sessionId))] };
}

export async function runResearchTrial(settings) {
  const { root, caseId, runtimeRevision, skillDirectory, presetFile, hidden } = settings;
  const project = join(root, 'corpus', caseId);
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  const preset = presetFile ? { name: 'research-mid', definition: await jsonFile(presetFile) } : undefined;
  const task = caseTask(caseId);
  const prompt = [
    preset ? 'Запусти DWF «research-mid» для нового исследования.' :
      'Используй скилл dwf-oc. Сам собери и запусти workflow research-mid через публичный CLI. Мне нужен один учёный, два параллельных скаута, затем раунды четырёх исследователей. Пусть учёный получает каждый пакет в той же сессии, а отчёт проверяет отдельный комитет. Предел — три исследовательских раунда. Подбери роли, скиллы и инструменты для локального корпуса.',
    'Все участники используют обычную GPT-6.1 Sol с reasoning high. Сохрани текст поручения ниже целиком в task. Следи за фактическим запуском до завершения и передай отчёт из результата DWF.',
    task,
  ].join('\n\n');
  const { attempt, assessment } = await runBenchmark({ root: join(root, 'trials'),
    project, baseline, prompt, model: standardModel, runtimeRevision, skillDirectory,
    preset, hidden, observeModel: true });
  assert.equal(assessment.status, 'succeeded', JSON.stringify(assessment));
  return summarizeTrial(attempt.directory, caseId);
}

export async function summarizeTrial(directory, caseId) {
  const attempt = await jsonFile(join(directory, 'attempt.json'));
  const workflows = benchmarkWorkflows(attempt);
  assert.equal(workflows.length, 1, 'Expected one actual workflow');
  const [workflow] = workflows;
  const checked = checkResearchRun(workflow, caseTask(caseId));
  const wire = await modelEvidence(join(directory, 'evidence/provider.jsonl'),
    [attempt.sessionId, ...checked.sessions]);
  const tools = attempt.opencode ? sessionTools(join(directory, 'opencode'), [attempt.sessionId, ...checked.sessions]) :
    { ...sessionTools(join(directory, 'opencode'), [attempt.sessionId]),
      ...sessionTools(join(attempt.stateDirectory, 'opencode'), checked.sessions) };
  const toolCounts = {};
  for (const call of Object.values(tools).flat()) toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
  const finished = (await stat(join(directory, 'assessment.json'))).mtimeMs;
  const result = { caseId, attempt: directory, runId: workflow.id,
    graph: { ...workflow.definition, task: '' }, reportHash: hash(workflow.result.summary),
    outcome: workflow.result.outcome, rounds: checked.rounds, reviews: checked.reviews,
    elapsedSeconds: (finished - attempt.createdAt) / 1000, wire, toolCounts, tools };
  await saveJson(join(directory, 'research.json'), result);
  await writeFile(join(directory, 'research-report.md'), workflow.result.summary, { mode: 0o600 });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runResearchTrial(await jsonFile(process.argv[2]));
  console.log(JSON.stringify({ caseId: result.caseId, attempt: result.attempt,
    outcome: result.outcome, rounds: result.rounds, totals: result.wire.totals, elapsedSeconds: result.elapsedSeconds }));
}
