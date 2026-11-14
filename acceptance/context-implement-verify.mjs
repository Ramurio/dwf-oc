// Recheck a completed trial after a verification-only defect. Never start or
// repeat its model workflow; public continue is used only to check idempotence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, cliJson, writeJson } from './harness.mjs';
import { connectTester, checkTester } from './tester.mjs';
import { verifyTrialResult } from './context-implement-trial.mjs';
import { getWorkflow } from '../run-store.mjs';

export async function verifyCompletedTrial(evidenceDirectory) {
  const path = join(evidenceDirectory, 'latest.json');
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  const attempt = JSON.parse(await readFile(join(evidence.attempt, 'attempt.json'), 'utf8'));
  const final = JSON.parse(await readFile(join(attempt.directory, 'final-state.json'), 'utf8'));
  assert.equal(final.status, 'succeeded');
  assert.equal(getWorkflow(attempt.stateDirectory, final.id).status, 'succeeded');
  assert(evidence.crash && evidence.failedRun && evidence.decision, 'Missing completed lifecycle evidence.');
  const failed = JSON.parse(await readFile(join(attempt.directory, 'failed-state.json'), 'utf8'));
  const failedSuccesses = failed.visits.filter(v => v.verdict && v.implementId).map(v => ({
    inputId: v.inputId, sessionId: v.sessionId, revision: v.revision, prompt: v.prompt, taskContext: v.taskContext, verdict: v.verdict }));
  const s = await createSandbox();
  s.env.DWF_STATE_DIR = attempt.stateDirectory;
  s.env.PATH = dirname(attempt.candidateCli.wrapper) + delimiter + s.env.PATH;
  try {
    const client = await connectTester(attempt.root, attempt.stateDirectory, false, {
      profile: attempt.opencode, env: s.env, skillDirectory: attempt.skillDirectory,
    });
    await checkTester(client, attempt);
    const cli = [process.execPath, fileURLToPath(new URL('../dwf.mjs', import.meta.url))];
    const command = args => cliJson(s.spawn(cli, args), 20000);
    await verifyTrialResult({ attempt, final, client, evidence, failedSuccesses,
      settings: { seed: attempt.base.source }, command, decision: evidence.decision });
    if (evidence.error) evidence.previousVerificationFailure = { error: evidence.error, at: evidence.finishedAt };
    delete evidence.error;
    evidence.outcome = 'passed'; evidence.runId = final.id; evidence.verifiedAt = Date.now();
    evidence.skill = JSON.parse(await readFile(join(attempt.directory, 'skill-evidence.json'), 'utf8'));
    await writeJson(path, evidence);
    console.log(JSON.stringify({ passed: true, runId: final.id, attempt: attempt.directory, modelWorkflowRepeated: false }));
    return evidence;
  } finally { await s.cleanup(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Usage: node acceptance/context-implement-verify.mjs <evidence-directory>');
  await verifyCompletedTrial(resolve(process.argv[2]));
}
