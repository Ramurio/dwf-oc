// Test-only observation/fault injection around real SQLite commits and native OpenCode calls.
// Loaded in CLI descendants via --import; no product fault switches or substituted services.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function installAdmissionFault(sandbox, boundary, index = 1) {
  const config = { boundary, index, marker: join(sandbox.control, 'admission-fault.json'),
    calls: join(sandbox.control, 'admission-calls.jsonl'), gate: join(sandbox.control, 'admission-reconnect') };
  sandbox.env.DWF_TEST_ADMISSION_FAULT = JSON.stringify(config);
  sandbox.env.NODE_OPTIONS = `${sandbox.env.NODE_OPTIONS ?? ''} --import=${import.meta.url}`;
  return { ...config, reconnect: () => writeFile(config.gate, '') };
}

const config = process.env.DWF_TEST_ADMISSION_FAULT && JSON.parse(process.env.DWF_TEST_ADMISSION_FAULT);
let calls = 0;

function fault(id) {
  if (existsSync(config.marker)) return false;
  writeFileSync(config.marker, JSON.stringify({ id, pid: process.pid, boundary: config.boundary }), { flag: 'wx' });
  if (config.boundary !== 'lost_response') process.kill(process.pid, 'SIGKILL');
  return true;
}

export function persisted(state) {
  if (existsSync(config.marker)) return;
  const visit = state.visits.at(-1);
  if (state.visits.length < config.index) return;
  if ((config.boundary === 'prepared' && visit?.admissionStarted === false) ||
      (config.boundary === 'admission_started' && visit?.admissionStarted === true && !visit.admitted)) fault(state.id);
}

export function beforeAdmission(request) {
  appendFileSync(config.calls, JSON.stringify(request) + '\n');
  return ++calls;
}

export function afterAdmission(request, index) {
  if (index === config.index && ['accepted', 'lost_response'].includes(config.boundary) && fault(request.id)) {
    throw new Error('TEST: native admission accepted, transport acknowledgement lost');
  }
}

export async function beforeConnect() {
  if (config.boundary === 'lost_response' && existsSync(config.marker)) {
    // Reconnection occurs outside the workflow transaction, so public controls can be queued.
    while (!existsSync(config.gate)) await pause(10);
  }
}

if (config && process.argv[1] === fileURLToPath(new URL('../workflow-runtime.mjs', import.meta.url))) {
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (![new URL('../run-store.mjs', import.meta.url).href,
        new URL('../opencode-runtime.mjs', import.meta.url).href].includes(url)) return loaded;
      let source = String(loaded.source);
      const wrap = (name, replacement) => {
        const declaration = new RegExp(`export (async )?function ${name}\\(`);
        assert(declaration.test(source), `Fault hook cannot find ${name}`);
        source = source.replace(declaration, (_match, async = '') => `${async}function ${name}(`);
        source += '\n' + replacement;
      };
      if (url.endsWith('/run-store.mjs')) {
        wrap('updateWorkflow', `export function observedUpdate(...args) {
          const result = updateWorkflow(...args); admissionFault.persisted(args[1]); return result;
        }
        export { observedUpdate as updateWorkflow };`);
        wrap('withWorkflowAction', `export async function observedAction(...args) {
          const result = await withWorkflowAction(...args); admissionFault.persisted(args[1]); return result;
        }
        export { observedAction as withWorkflowAction };`);
      } else {
        wrap('connect', `export async function observedConnect(...args) {
          await admissionFault.beforeConnect(); return connect(...args);
        }
        export { observedConnect as connect };`);
        wrap('admit', `export async function observedAdmit(client, request) {
          const index = admissionFault.beforeAdmission(request);
          await admit(client, request); admissionFault.afterAdmission(request, index);
        }
        export { observedAdmit as admit };`);
      }
      return { ...loaded, source: `import * as admissionFault from ${JSON.stringify(import.meta.url)};\n` + source };
    },
  });
}
