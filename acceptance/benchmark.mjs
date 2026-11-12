import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Service } from '@opencode/client/service';
import { OpenCode } from '@opencode/client';
import { createModelProxy, writeSandboxProfile } from './isolation.mjs';
import { authorizeTester, canonical } from './tester.mjs';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const model = { providerID: 'openai', id: 'gpt-6.1-sol-ultrafast', variant: 'high' };
const runtimeFiles = ['dwf.mjs', 'workflow-definition.mjs', 'workflow-runtime.mjs', 'workflow-git.mjs',
  'run-store.mjs', 'opencode-runtime.mjs', 'opencode-tools.mjs', 'role-skills.mjs', 'skills', 'package.json', 'package-lock.json',
  'acceptance/tester.mjs', 'workflow-groups.mjs', 'research-workflow.mjs', 'acceptance/model-observer'];

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function save(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function archive(source, revision, target, paths = []) {
  const bytes = execFileSync('git', ['archive', revision, ...paths], { cwd: source, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', target], { input: bytes });
}

export async function prepareBenchmark(settings) {
  if (!settings.prompt?.trim()) throw new Error('A benchmark task is required.');
  const root = await canonical(resolve(settings.root));
  const source = await realpath(settings.project);
  const inside = relative(source, root);
  if (!inside || inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) {
    throw new Error('Benchmark storage must be outside the source repository.');
  }
  const id = randomUUID();
  const directory = join(root, 'attempts', id);
  const workspace = join(directory, 'project');
  const runtime = join(directory, 'runtime');
  for (const path of [workspace, runtime, join(directory, 'home'), join(directory, 'tmp'), join(directory, 'bin')]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const revision = git(source, ['rev-parse', `${settings.baseline}^{commit}`]);
  archive(source, revision, workspace);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'DWF Evaluation'],
    ['config', 'user.email', 'evaluation@example.invalid'], ['add', '--force', '.'], ['commit', '-qm', 'Evaluation baseline']]) {
    git(workspace, args);
  }
  const runtimeRevision = git(projectDirectory, ['rev-parse', `${settings.runtimeRevision ?? 'HEAD'}^{commit}`]);
  const available = new Set(git(projectDirectory, ['ls-tree', '--name-only', runtimeRevision]).split('\n'));
  archive(projectDirectory, runtimeRevision, runtime, runtimeFiles.filter(file => available.has(file.split('/')[0])));
  await symlink(join(projectDirectory, 'node_modules'), join(runtime, 'node_modules'));
  await cp(settings.skillDirectory ?? join(homedir(), '.codex/skills/dwf-oc'), join(directory, 'skill'), { recursive: true });
  await symlink(join(runtime, 'dwf.mjs'), join(directory, 'bin/dwf'));
  for (const item of settings.copy ?? []) {
    const target = resolve(directory, item.to);
    if (!target.startsWith(directory + sep)) throw new Error('A support file escaped the attempt directory.');
    await cp(item.from, target, { recursive: true, dereference: true });
  }
  const attempt = { id, directory, workspace, root: directory, runtime,
    stateDirectory: join(directory, 'dwf-state'), base: { commit: git(workspace, ['rev-parse', 'HEAD']) },
    model: settings.model ?? model, sessionId: 'ses_' + randomUUID(), inputId: 'msg_' + randomUUID(),
    prompt: settings.prompt, createdAt: Date.now() };
  await writeFile(join(directory, 'prompt.txt'), settings.prompt, { mode: 0o600 });
  await save(join(directory, 'attempt.json'), attempt);
  await mkdir(join(root, 'provenance'), { recursive: true, mode: 0o700 });
  await save(join(root, 'provenance', `${id}.json`), { id, source, revision, runtimeRevision, model: attempt.model,
    sourceTree: git(source, ['rev-parse', `${revision}^{tree}`]),
    baselineTree: git(workspace, ['rev-parse', 'HEAD^{tree}']),
    skillHash: createHash('sha256').update(await readFile(join(directory, 'skill/SKILL.md')))
      .update(await readFile(join(directory, 'skill/references/cli.md'))).digest('hex'),
    promptHash: createHash('sha256').update(settings.prompt).digest('hex') });
  return attempt;
}

async function observeModel(attempt, env, shared) {
  env.DWF_ACCEPTANCE_CONTROL_DIR = join(attempt.directory, 'evidence');
  env.DWF_ACCEPTANCE_TOKEN = randomUUID();
  await mkdir(env.DWF_ACCEPTANCE_CONTROL_DIR, { mode: 0o700 });
  const directories = shared ? [env.OPENCODE_CONFIG_DIR] :
    [join(attempt.root, 'opencode/config'), join(attempt.stateDirectory, 'opencode/config')];
  for (const directory of directories) {
    const plugins = join(directory, 'plugins');
    await mkdir(plugins, { recursive: true, mode: 0o700 });
    await symlink(join(attempt.runtime, 'acceptance/model-observer'), join(plugins, 'dwf-model-observer'));
  }
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export function benchmarkEnvironment(attempt, proxy, port, extra = {}) {
  const env = Object.fromEntries(Object.keys(process.env).map(key => [key, '']));
  const profile = join(attempt.directory, 'opencode');
  const expand = value => value.replaceAll('{{attempt}}', attempt.directory).replaceAll('{{project}}', attempt.workspace);
  Object.assign(env, { HOME: join(attempt.directory, 'home'), TMPDIR: join(attempt.directory, 'tmp'),
    OPENCODE_CONFIG_DIR: join(profile, 'config'),
    OPENCODE_DB: join(profile, 'opencode.sqlite'),
    XDG_CONFIG_HOME: join(profile, 'xdg-config'),
    XDG_DATA_HOME: join(profile, 'data'),
    XDG_CACHE_HOME: join(profile, 'cache'),
    XDG_STATE_HOME: join(profile, 'state'),
    PATH: join(attempt.directory, 'bin') + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8', USER: 'dwf-evaluation', HTTP_PROXY: proxy, HTTPS_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    DWF_OPENCODE_PORT: String(port), OPENCODE_DISABLE_MODELS_FETCH: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    PYTHONDONTWRITEBYTECODE: '1',
  }, Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, expand(value)])));
  env.DWF_STATE_DIR = attempt.stateDirectory;
  env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
  env.PATH = env.DEVELOPER_DIR + '/usr/bin:' + env.PATH;
  return env;
}

export function benchmarkWorkflows(attempt) {
  const file = join(attempt.stateDirectory, 'dwf.sqlite');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'workflows'").get()) return [];
    return db.prepare('SELECT state FROM workflows ORDER BY id').all().map(row => JSON.parse(row.state));
  } finally { db.close(); }
}

export function benchmarkAssessment(tester, workflows) {
  const running = tester.status === 'running' || workflows.some(workflow => workflow.status === 'running');
  const succeeded = tester.status === 'succeeded' && workflows.length > 0 &&
    workflows.every(workflow => workflow.status === 'succeeded' &&
      (!workflow.definition.merge || Boolean(workflow.result?.commit)));
  return { status: running ? 'running' : succeeded ? 'succeeded' : 'failed', testerStatus: tester.status,
    workflows: workflows.map(workflow => ({ runId: workflow.id, status: workflow.status,
      integration: workflow.definition.merge ? workflow.result?.commit ? 'merged' : 'unmerged' : 'not-requested',
      ...(workflow.error ? { error: workflow.error } : {}) })) };
}

export async function monitorBenchmark(attempt, { inspect, resume, interval = 2000 }) {
  let previous;
  for (;;) {
    const state = await inspect();
    const workflows = benchmarkWorkflows(attempt);
    const assessment = benchmarkAssessment(state, workflows);
    const status = JSON.stringify({ ...assessment, messages: state.messageCount, tool: state.lastTool });
    if (status !== previous) console.log(status);
    previous = status;
    if (assessment.status !== 'running') {
      await save(join(attempt.directory, 'assessment.json'), assessment);
      return { state, assessment };
    }
    if (state.status !== 'running') {
      for (const workflow of workflows.filter(workflow => workflow.status === 'running')) {
        try { await resume(workflow.id); }
        catch { console.log(JSON.stringify({ monitor: 'retrying', runId: workflow.id })); }
      }
    }
    await pause(interval);
  }
}

async function checkBoundary(attempt, profile, env, hidden, port) {
  const probe = `
    const fs=require('node:fs'),net=require('node:net'),assert=require('node:assert/strict');
    for(const path of JSON.parse(process.argv[1]))assert.throws(()=>fs.readFileSync(path),{code:'EPERM'});
    const socket=net.connect(Number(process.argv[2]),'127.0.0.1');
    socket.once('connect',()=>{throw Error('Unrelated local endpoint is reachable')});
    socket.once('error',error=>{assert(['EPERM','EACCES'].includes(error.code));console.log('boundary passed')});
  `;
  const output = execFileSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', probe,
    JSON.stringify(hidden), String(port)], { cwd: attempt.workspace, env, encoding: 'utf8', timeout: 10000 });
  if (output.trim() !== 'boundary passed' || git(attempt.workspace, ['rev-list', '--all', '--count']) !== '1') {
    throw new Error('The evaluation isolation check failed.');
  }
}

export async function runBenchmark(settings) {
  const attempt = await prepareBenchmark(settings);
  const proxy = await createModelProxy();
  const ports = [await freePort(), await freePort()];
  const profile = join(attempt.directory, 'sandbox.sb');
  const env = benchmarkEnvironment(attempt, proxy.url, ports[0], settings.environment);
  const sentinel = join(settings.root, 'private-boundary-' + attempt.id);
  await writeFile(sentinel, 'private reference boundary', { mode: 0o600 });
  const unrelated = createServer(socket => socket.end('must be inaccessible'));
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  let registrations = [];
  try {
    const runtime = await import(pathToFileURL(join(attempt.runtime, 'opencode-runtime.mjs')));
    const shared = typeof runtime.openCodeProfile === 'function';
    registrations = shared ? [join(env.XDG_STATE_HOME, 'opencode/service.json')] :
      [join(attempt.stateDirectory, 'opencode/state/opencode/service.json'), join(attempt.root, 'opencode/state/opencode/service.json')];
    if (settings.observeModel) await observeModel(attempt, env, shared);
    await writeSandboxProfile(profile, { writable: [attempt.directory],
      readable: [join(projectDirectory, 'node_modules'), ...settings.readable ?? []], ports: [...ports, proxy.port] });
    await checkBoundary(attempt, profile, env, [sentinel, ...settings.hidden ?? []], unrelated.address().port);
    await save(join(attempt.directory, 'boundary.json'), { passed: true, oneCommit: true,
      filesystem: true, unrelatedLocalhost: true, sourceNetwork: 'denied by kernel and model proxy', checkedAt: Date.now() });
    const tester = await import(pathToFileURL(join(attempt.runtime, 'acceptance/tester.mjs')));
    // The tester and DWF share one service inside this attempt's kernel sandbox.
    const bootstrap = `
      const runtime = await import(process.argv[1]);
      const tester = await import(process.argv[2]);
      await runtime.connect(process.argv[3]);
      await tester.connectTester(process.argv[4], process.argv[3], true,
        {port: Number(process.argv[5]), skillDirectory: process.argv[6], authorize: false});
      process.exit(0);
    `;
    execFileSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '--input-type=module', '-e', bootstrap,
      pathToFileURL(join(attempt.runtime, 'opencode-runtime.mjs')).href,
      pathToFileURL(join(attempt.runtime, 'acceptance/tester.mjs')).href,
      attempt.stateDirectory, attempt.root, String(ports[1]), join(attempt.directory, 'skill')],
    { cwd: attempt.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 });
    const clients = [];
    for (const file of registrations) {
      const endpoint = await Service.discover({ file });
      if (!endpoint) throw new Error('An isolated service did not start.');
      clients.push(OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }));
    }
    const [client, testerClient = client] = clients;
    if (shared) attempt.opencode = runtime.openCodeProfile(env);
    await save(join(attempt.directory, 'attempt.json'), attempt);
    await authorizeTester(client);
    await runtime.checkModel(client, attempt.workspace,
      { provider: attempt.model.providerID, modelId: attempt.model.id }, attempt.model.variant);
    if (testerClient !== client) await authorizeTester(testerClient);
    await tester.checkTester(testerClient, attempt);
    if (settings.preset) {
      const presetFile = join(attempt.directory, 'preset.json');
      await save(presetFile, settings.preset.definition);
      execFileSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, join(attempt.runtime, 'dwf.mjs'),
        'preset', 'save', settings.preset.name, '--file', presetFile],
      { cwd: attempt.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    }
    await tester.admitTester(testerClient, attempt);
    console.log(JSON.stringify({ attempt: attempt.directory, sessionId: attempt.sessionId, isolation: 'passed' }));
    const result = await monitorBenchmark(attempt, {
      inspect: () => tester.inspectTester(testerClient, attempt),
      resume: id => execFileSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath,
        join(attempt.runtime, 'dwf.mjs'), 'inspect', id],
      { cwd: attempt.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }),
    });
    return { attempt, ...result };
  } finally {
    await save(join(attempt.directory, 'proxy-events.json'), proxy.events);
    await new Promise(resolve => unrelated.close(resolve));
    for (const file of registrations) await Service.stop({ file }).catch(() => {});
    await proxy.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const result = await runBenchmark(settings);
  console.log(JSON.stringify({ attempt: result.attempt.directory, ...result.assessment, report: result.state.report }));
  process.exitCode = result.assessment.status === 'succeeded' ? 0 : 1;
}
