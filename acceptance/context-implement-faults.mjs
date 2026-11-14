// Test-only interventions. Never loaded by the product without an explicit
// --import in this trial's isolated process environment. No DB writes or model
// answers are replaced; participants implement all project functions themselves.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const configured = process.env.DWF_CONTEXT_TRIAL_CONTROL;
const file = name => join(configured, name);
const marker = (name, data) => writeFileSync(file(name), JSON.stringify({ ...data, at: Date.now(), pid: process.pid }), { flag: 'wx', mode: 0o600 });

export function trialSignals(state) {
  const instances = Object.values(state.implements?.instances ?? {});
  return {
    activeWorkers: state.visits.filter(v => v.implementId && v.admitted && !v.verdict && !v.error && state.definition.nodes[v.node]?.role === 'worker'),
    integrated: instances.filter(i => i.status === 'integrated'),
  };
}

export function observedState(state) {
  if (!state.implements || state.status !== 'running') return;
  const signals = trialSignals(state);
  if (!existsSync(file('crash.json')) && signals.activeWorkers.length >= 2) {
    writeFileSync(file('before-crash.json'), JSON.stringify(state), { mode: 0o600 });
    marker('crash.json', { runId: state.id, inputIds: signals.activeWorkers.map(v => v.inputId) });
    process.kill(process.pid, 'SIGKILL');
  }
  if (signals.integrated.length >= 2 && !existsSync(file('failure-armed.json'))) {
    marker('failure-armed.json', { runId: state.id, successes: signals.integrated.map(i => i.id) });
  }
}

export function beforeAdmit(request) {
  appendFileSync(file('admission-attempts.jsonl'), JSON.stringify({ runId: request.id, inputId: request.inputId,
    sessionId: request.sessionId, title: request.request.session.title, at: Date.now() }) + '\n', { mode: 0o600 });
  if (existsSync(file('failure-armed.json')) && !existsSync(file('failure-released')) &&
      request.request.session.title.startsWith('DWF orchestrator')) {
    if (!existsSync(file('admission-failure.json'))) marker('admission-failure.json', { runId: request.id, inputId: request.inputId, sessionId: request.sessionId });
    throw Object.assign(new Error('Controlled trial admission unavailable; restore environment and continue this run.'),
      { publicMessage: 'Controlled trial admission unavailable; restore environment and continue this run.' });
  }
}

export function suppressObserverRecovery() {
  // Keep an inspect/watch observer from winning the takeover race so the harness
  // can demonstrate public continue after the real lease expires. The continue
  // command itself is unmodified, and no owner/expiry is edited.
  return existsSync(file('crash.json')) && !existsSync(file('crash-released')) && process.argv[2] !== 'continue';
}

if (configured) registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const targets = ['run-store.mjs', 'opencode-runtime.mjs', 'workflow-runtime.mjs'];
    if (!targets.some(name => url === new URL('../' + name, import.meta.url).href)) return loaded;
    let source = String(loaded.source);
    const isController = process.argv[1] === new URL('../workflow-runtime.mjs', import.meta.url).pathname;
    if (isController && url.endsWith('/run-store.mjs')) {
      for (const name of ['updateWorkflow', 'withWorkflowAction']) {
        const declaration = new RegExp(`export (async )?function ${name}\\(`);
        assert(declaration.test(source), `Missing trial boundary ${name}`);
        source = source.replace(declaration, (_match, async = '') => `${async}function ${name}(`);
        source += `\nexport ${name === 'withWorkflowAction' ? 'async ' : ''}function trial_${name}(...args) {
          const result = ${name === 'withWorkflowAction' ? 'await ' : ''}${name}(...args);
          trial.observedState(args[1]); return result;
        }\nexport { trial_${name} as ${name} };\n`;
      }
    }
    if (isController && url.endsWith('/opencode-runtime.mjs')) {
      const declaration = 'export async function admit(client, run) {';
      assert(source.includes(declaration));
      source = source.replace(declaration, declaration + '\n trial.beforeAdmit(run);');
    }
    if (url.endsWith('/workflow-runtime.mjs')) {
      const declaration = 'export async function ensureWorkflowRunner(root, id) {';
      assert(source.includes(declaration));
      source = source.replace(declaration, declaration + '\n if (trial.suppressObserverRecovery()) return;');
    }
    return { ...loaded, source: `import * as trial from ${JSON.stringify(import.meta.url)};\n` + source };
  },
});
