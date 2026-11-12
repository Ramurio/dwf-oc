import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

export function command(value, fallback) {
  const argv = value ? JSON.parse(value) : fallback;
  assert(Array.isArray(argv) && argv.length > 0 && argv.every(v => typeof v === 'string'),
    'Команда должна быть JSON-массивом строк argv, без shell');
  return argv;
}

export function timeout(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isSafeInteger(value) && value > 0, `${name}: нужен положительный таймаут в мс`);
  return value;
}

export async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function waitFor(probe, limit, description) {
  const deadline = Date.now() + limit;
  while (true) {
    if (Date.now() >= deadline) throw new Error(`TIMEOUT: ${description} (${limit} мс)`);
    const value = await probe();
    if (value) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`TIMEOUT: ${description} (${limit} мс)`);
    // Опрос наблюдаемого сигнала. Истечение задержки никогда не означает готовность.
    await pause(Math.min(25, remaining));
  }
}

export async function within(promise, limit, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TIMEOUT: ${description} (${limit} мс)`)), limit);
    })]);
  } finally { clearTimeout(timer); }
}

export function launch(argv, args, options) {
  const child = spawn(argv[0], [...argv.slice(1), ...args], {
    ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  });
  const record = { child, stdout: '', stderr: '', exited: false, closed: false };
  child.stdout.setEncoding('utf8').on('data', data => { record.stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { record.stderr += data; });
  // Слушатели устанавливаются до возврата: быстрый CLI не может обойти проверку exit.
  record.exit = new Promise(resolveExit => {
    child.once('exit', (code, signal) => {
      record.exited = true;
      record.outcome = { code, signal };
      resolveExit(record.outcome);
    });
    child.once('error', error => {
      record.spawnError = error;
      resolveExit({ error });
    });
  });
  record.close = new Promise(resolveClose => child.once('close', () => {
    record.closed = true;
    resolveClose();
  }));
  child.stdin.on('error', () => {}); // EPIPE при аварии будет виден через exit/stderr.
  return record;
}

export async function cliJson(record, limit) {
  const outcome = await within(record.exit, limit, 'фактический выход процесса CLI');
  if (outcome.error?.code === 'ENOENT') {
    throw new Error(`TECHNICAL_BLOCKER: отсутствует исполняемый CLI ${record.child.spawnfile}; ` +
      'реализация ещё не предоставлена. Это не содержательный RED.', { cause: outcome.error });
  }
  if (outcome.error) throw new Error(`TECHNICAL_BLOCKER: CLI не запущен (${outcome.error.code ?? 'spawn'})`);
  await within(record.close, limit, 'закрытие stdout/stderr CLI');
  assert.equal(outcome.signal, null, 'CLI завершён сигналом (сырой stderr не включается в отчёт)');
  assert.equal(outcome.code, 0, 'CLI завершён с ошибкой (сырой stderr не включается в отчёт)');
  let value;
  try { value = JSON.parse(record.stdout); }
  catch { throw new Error('CLI должен вернуть один JSON-объект (сырой stdout не включается в отчёт)'); }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Ответ CLI должен быть объектом JSON');
  return value;
}

// Linux требует BSD-опции без дефиса. Значения чужого окружения не выводятся.
export function taggedProcesses(token) {
  let listing;
  try {
    const selection = process.platform === 'linux' ? ['axeww', '-o'] : ['eww', '-axo'];
    listing = execFileSync('ps', [...selection, 'uid=,pid=,lstart=,stat=,command='], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Ошибка execFileSync содержит stdout с окружением: не передавать её форматтеру.
    throw new Error('TECHNICAL_BLOCKER: ps не предоставил список процессов для безопасной очистки');
  }
  // Аргументы процесса тоже могут содержать LF: не терять метку окружения на последней строке.
  return listing.split(/\n(?=\s*\d+\s+\d+\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s)/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(\S+)\s+([\s\S]*)$/);
    if (!match || Number(match[1]) !== process.getuid() || match[4].startsWith('Z') ||
      !match[5].split(/\s+/).includes(`DWF_ACCEPTANCE_TOKEN=${token}`)) return [];
    return [{ uid: Number(match[1]), pid: Number(match[2]), born: match[3].replace(/\s+/g, ' ') }];
  });
}

export function processIdentity(pid = process.pid) {
  const value = execFileSync('ps', ['-p', String(pid), '-o', 'uid=,pid=,lstart='], {
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const match = value.match(/^(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)$/);
  assert(match, 'Не удалось определить идентичность процесса');
  return { uid: Number(match[1]), pid: Number(match[2]), born: match[3].replace(/\s+/g, ' ') };
}

const sameProcess = (a, b) => a.uid === b.uid && a.pid === b.pid && a.born === b.born;

function commandName(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim(); }
  catch { return undefined; }
}

export function captureOwnedExecution(world, name = commandName) {
  const clients = new Set(world.sandbox.records.map(record => record.child.pid));
  const execution = taggedProcesses(world.sandbox.token).filter(identity => {
    if (identity.pid === process.pid || clients.has(identity.pid)) return false;
    const command = name(identity.pid);
    return command === 'opencode' || command?.endsWith('/opencode');
  });
  assert(execution.length > 0,
    'HARNESS_EXECUTION_WITNESS: нет живого tagged native OpenCode backend; остановка исполнения не доказана');
  return execution;
}

export async function assertExecutionStopped(execution) {
  assert(execution.length > 0, 'HARNESS_EXECUTION_WITNESS: нет исходного backend PID');
  await waitFor(() => {
    for (const identity of execution) {
      let current;
      try { current = processIdentity(identity.pid); }
      catch (error) {
        if (error.status === 1) continue; // ps confirmed this PID is gone.
        throw error;
      }
      if (sameProcess(current, identity)) return false;
    }
    return true;
  }, 3000, 'HARNESS_EXECUTION_WITNESS: исходный backend PID ещё жив после остановки исполнения');
}

export function assertOriginalAlive(token, identity) {
  assert(taggedProcesses(token).some(item => sameProcess(item, identity)),
    'LIFETIME_FAILURE: первоначальный процесс прекратил удержанную незавершённую работу после выхода start');
}

export async function originalStillWorking(world,
  readEvents = () => transcript(join(world.sandbox.control, 'provider.jsonl')), assertAlive = assertOriginalAlive) {
  let seen = await readEvents();
  if (world.controlledModel) {
    const completed = () => seen.some(event => event.type === 'completed' && event.callId === world.ready.callId);
    const transport = world.controlledModel.status(world.ready.callId);
    if (!completed() && (!transport || transport.closed)) {
      // A normal HTTP finish may race this snapshot; re-read the independent witness.
      seen = await readEvents();
      if (!completed()) {
        world.lifetimeFailure = { callId: world.ready.callId, transport,
          startExited: world.startClient.exited, promptVerified: world.ready.prompt.includes(world.task),
          completed: false, released: Boolean(world.released) };
        throw new Error('LIFETIME_FAILURE: исходный SSE transport закрылся до завершения удержанного ответа');
      }
    }
    assert.equal(seen.filter(event => event.type === 'received').length, 1,
      'LIFETIME_FAILURE: новый модельный вызов не должен скрывать потерю исходного SSE transport');
    return;
  }
  if (!seen.some(event => event.type === 'completed' && event.callId === world.ready.callId)) {
    try { assertAlive(world.sandbox.token, world.ready.identity); }
    catch (error) {
      // Ответ мог завершиться между первым чтением и проверкой процесса.
      seen = await readEvents();
      if (!seen.some(event => event.type === 'completed' && event.callId === world.ready.callId)) {
        world.lifetimeFailure = { callId: world.ready.callId, identity: world.ready.identity,
          startExited: world.startClient.exited, promptVerified: world.ready.prompt.includes(world.task),
          completed: false, released: Boolean(world.released) };
        throw error;
      }
    }
  }
  assert.equal(seen.filter(event => event.type === 'received').length, 1,
    'Новый модельный вызов не должен скрывать прекращение первоначальной работы');
}

function signalOwned(token, identity, name) {
  if (taggedProcesses(token).some(item => sameProcess(item, identity))) signal(identity.pid, name);
}

function signal(pid, name) {
  try { process.kill(pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function createSandbox() {
  assert(['darwin', 'linux'].includes(process.platform), 'Приёмочный harness требует macOS или Linux с ps');
  const root = await mkdtemp(join(tmpdir(), 'dwf-acceptance-'));
  const workspace = join(root, 'project');
  const control = join(root, 'control');
  const state = join(root, 'state');
  await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(control, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
  const profile = join(root, 'profile');
  for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'runtime']) {
    await mkdir(join(profile, name), { recursive: true, mode: 0o700 });
  }
  await writeFile(join(workspace, 'untouched.txt'), 'Файлы проекта планнер не изменяет.\n');
  const token = randomUUID();
  const env = { ...process.env, HOME: join(profile, 'home'), OPENCODE_TEST_HOME: join(profile, 'home'),
    OPENCODE_CONFIG_DIR: join(profile, 'config'), OPENCODE_CONFIG: '',
    XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'),
    XDG_CACHE_HOME: join(profile, 'cache'), XDG_STATE_HOME: join(profile, 'state'),
    XDG_RUNTIME_DIR: join(profile, 'runtime'), TMPDIR: join(profile, 'tmp'),
    DWF_STATE_DIR: state, DWF_ACCEPTANCE_TOKEN: token,
    DWF_ACCEPTANCE_CONTROL_DIR: control };
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_DB;
  delete env.DWF_OPENCODE_PORT;
  delete env.DWF_MODEL_PROVIDER_MODULE;
  delete env.DWF_AUTH_SOURCE;
  delete env.DWF_PLANNER_REASONING;
  // Будущий локальный npm bin имеет приоритет над глобальным dwf.
  env.PATH = `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`;
  const records = [];
  return {
    root, workspace, control, state, token, env, records,
    spawn(argv, args = []) {
      const record = launch(argv, args, { cwd: workspace, env });
      records.push(record);
      return record;
    },
    async cleanupProcesses() {
      // Включая отделившихся потомков; никакие чужие группы процессов не затрагиваются.
      const owned = taggedProcesses(token);
      for (const item of owned) signalOwned(token, item, 'SIGTERM');
      const firstSeen = new Map(owned.map(item => [`${item.pid}:${item.born}`, Date.now()]));
      await waitFor(() => {
        const current = taggedProcesses(token);
        for (const item of current) {
          // Время рождения защищает от убийства другого процесса при повторном использовании PID.
          const key = `${item.pid}:${item.born}`;
          if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
          signalOwned(token, item, Date.now() - firstSeen.get(key) >= 500 ? 'SIGKILL' : 'SIGTERM');
        }
        return current.length === 0;
      }, 5000, 'удаление процессов данного теста');
    },
    async cleanup() {
      await this.cleanupProcesses();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function jsonLines(text) {
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

export function watchStates(text) {
  let state;
  return jsonLines(text.slice(0, text.lastIndexOf('\n') + 1)).map(event => {
    if (event.type === 'snapshot') state = event.state;
    else {
      assert.equal(event.type, 'update');
      assert.equal(event.runId, state?.runId);
      state = { ...state, ...event.changes };
      for (const key of event.removed ?? []) delete state[key];
      if (event.historyUpdates) {
        state.history = [...state.history];
        for (const { index, entry } of event.historyUpdates) state.history[index] = entry;
      }
    }
    return structuredClone(state);
  });
}

export async function transcript(file) {
  try {
    const bytes = await readFile(file, 'utf8');
    // Во время наблюдения последняя запись может ещё передаваться; принимать только LF-завершённые.
    return jsonLines(bytes.slice(0, bytes.lastIndexOf('\n') + 1));
  }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function plannerResult(events) {
  const received = events.filter(event => event.type === 'received').at(-1);
  assert(received, 'Нет независимого свидетельства модельного вызова');
  const last = events.filter(event => event.type === 'completed' && event.callId === received.callId).at(-1);
  assert(last, 'Получение поручения не доказывает завершение модельного вызова');
  assert.equal(last.stopReason, 'stop', `Исполнитель не вернул итоговый ответ: ${last.stopReason}`);
  const text = last.text;
  assert.equal(typeof text, 'string');
  assert(text.trim().length > 0, 'Исполнитель не сформировал текстовый результат');
  return text;
}

export async function snapshot(directory, prefix = '') {
  const files = {};
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}${entry.name}`;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, { [`${relative}/`]: 'directory' }, await snapshot(absolute, `${relative}/`));
    else if (entry.isFile()) files[relative] = createHash('sha256').update(await readFile(absolute)).digest('hex');
    else throw new Error(`Неожиданный тип файла в тестовом проекте: ${relative}`);
  }
  return files;
}
