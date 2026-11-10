import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, jsonFile, saveJson } from './trial.mjs';
import { dimensions } from './assess.mjs';

async function measurement(directory) {
  const trial = await jsonFile(join(directory, 'research.json'));
  const assessment = await jsonFile(join(directory, 'independent-assessment.json'));
  const provenance = await jsonFile(join(dirname(dirname(directory)), 'provenance', basename(directory) + '.json'));
  const score = Object.fromEntries(dimensions.map(name => [name, assessment.verdict.dimensions[name].score]));
  const tester = await jsonFile(join(directory, 'attempt.json'));
  const testerUsage = trial.wire.usage[tester.sessionId];
  const { input, output, cached, reasoning } = trial.wire.totals;
  return { caseId: trial.caseId, runtimeRevision: provenance.runtimeRevision, skillHash: provenance.skillHash,
    sourceTree: provenance.sourceTree, promptHash: provenance.promptHash,
    judgeProtocol: assessment.protocol, rubric: assessment.rubric, score,
    checksPassed: Object.values(assessment.verdict.checks).filter(item => item.pass).length,
    checksTotal: Object.keys(assessment.verdict.checks).length,
    materialErrors: assessment.verdict.materialErrors.length,
    elapsedSeconds: trial.elapsedSeconds, rounds: trial.rounds, reviews: trial.reviews,
    committeeOutcome: trial.outcome, tools: trial.toolCounts,
    tokens: { input, output, cached, reasoning, workflow: input + output - testerUsage.input - testerUsage.output },
  };
}

export async function compare(settings) {
  const pairs = [];
  const seen = new Set();
  for (const pair of settings.pairs) {
    for (const directory of [pair.baseline, pair.candidate]) {
      const path = resolve(directory);
      assert(!seen.has(path), 'Each comparison needs distinct attempts');
      seen.add(path);
    }
    const baseline = await measurement(pair.baseline);
    const candidate = await measurement(pair.candidate);
    for (const key of ['caseId', 'sourceTree', 'promptHash', 'judgeProtocol', 'rubric']) {
      assert(baseline[key], `Missing comparable evidence for ${key}`);
      assert.equal(baseline[key], candidate[key], `Pair differs on ${key}`);
    }
    if (settings.selection !== false) assert.equal(cases[baseline.caseId].split, 'development');
    const scoreDelta = Object.fromEntries(dimensions.map(key => [key, candidate.score[key] - baseline.score[key]]));
    const checksDelta = candidate.checksPassed - baseline.checksPassed;
    pairs.push({ caseId: baseline.caseId, baseline, candidate, scoreDelta, checksDelta,
      workflowTokenDelta: candidate.tokens.workflow - baseline.tokens.workflow });
  }
  assert(pairs.length, 'No paired trials');
  const guarded = pairs.every(pair => pair.candidate.materialErrors <= pair.baseline.materialErrors &&
    pair.scoreDelta.accuracy >= 0 && pair.scoreDelta.citationSupport >= 0 && pair.checksDelta >= 0);
  const grouped = Object.groupBy(pairs, pair => pair.caseId);
  const repeated = Object.values(grouped).filter(group => group.length >= 2);
  const qualityWin = repeated.some(group => group.every(pair =>
    pair.checksDelta > 0 || Object.values(pair.scoreDelta).reduce((sum, score) => sum + score, 0) > 0));
  const efficiencyWin = repeated.some(group => group.every(pair =>
    pair.workflowTokenDelta <= -0.15 * pair.baseline.tokens.workflow &&
    Object.values(pair.scoreDelta).every(score => score >= 0)));
  const adopt = guarded && (qualityWin || efficiencyWin);
  return { hypothesis: settings.hypothesis, change: settings.change, pairs, guarded, qualityWin, efficiencyWin,
    ...(settings.selection !== false ? { decision: adopt ? 'candidate' : 'baseline' } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = await jsonFile(process.argv[2]);
  const result = await compare(settings);
  if (settings.output) await saveJson(settings.output, result);
  console.log(JSON.stringify({ decision: result.decision, guarded: result.guarded, qualityWin: result.qualityWin,
    efficiencyWin: result.efficiencyWin, pairs: result.pairs.map(({ caseId, checksDelta, workflowTokenDelta, scoreDelta }) =>
      ({ caseId, checksDelta, workflowTokenDelta, scoreDelta })) }));
}
