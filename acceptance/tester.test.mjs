import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAttempt, admitTester, visibleMessages, testerState, inspectTester, checkTester } from './tester.mjs';

test('fresh tester attempts clone one baseline without changing the source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-tester-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  const git = args => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git(['config', 'user.name', 'DWF Test']);
  git(['config', 'user.email', 'dwf-test@example.invalid']);
  await writeFile(join(directory, 'AGENTS.md'), 'Inherited project instructions.\n');
  await writeFile(join(project, 'code.txt'), 'baseline\n');
  git(['add', '.']);
  git(['commit', '-qm', 'baseline']);
  const root = join(directory, 'tester');
  const first = await createAttempt(root, project, 'Use DWF for this task.', directory);
  const second = await createAttempt(root, project, 'Use DWF for this task.', directory);
  assert.equal(first.base.commit, second.base.commit);
  assert.match(first.sessionId, /^ses_/);
  assert.match(first.inputId, /^msg_/);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.workspace, second.workspace);
  assert.equal(await readFile(join(first.workspace, 'code.txt'), 'utf8'), 'baseline\n');
  assert.equal(await readFile(join(first.directory, 'AGENTS.md'), 'utf8'), 'Inherited project instructions.\n');
  await writeFile(join(first.workspace, 'code.txt'), 'changed\n');
  assert.equal(await readFile(join(project, 'code.txt'), 'utf8'), 'baseline\n');
  assert.equal(await readFile(join(second.workspace, 'code.txt'), 'utf8'), 'baseline\n');
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(execFileSync('git', ['-C', first.workspace, 'remote'], { encoding: 'utf8' }).trim(), '');
  const saved = JSON.parse(await readFile(join(first.directory, 'attempt.json'), 'utf8'));
  assert.equal(saved.sessionId, first.sessionId);
  await assert.rejects(createAttempt(join(project, 'tester'), project, 'task', directory), /вне исходного/);
  await writeFile(join(project, 'dirty.txt'), 'pending');
  await assert.rejects(createAttempt(root, project, 'task', directory), /чистый/);
});

test('reconnecting uses the persisted native input ID and rejects a foreign session', async () => {
  const prompts = [];
  const attempt = { id: 'one', sessionId: 'ses_one', inputId: 'msg_one', prompt: 'task' };
  const client = { session: {
    get: async () => ({ metadata: { testerAttemptId: 'one' } }),
    prompt: async prompt => { prompts.push(prompt); },
  } };
  await admitTester(client, attempt);
  await admitTester(client, attempt);
  assert.deepEqual(prompts, Array(2).fill({ sessionID: 'ses_one', id: 'msg_one', text: 'task' }));
  await assert.rejects(admitTester(client, { ...attempt, id: 'other' }), /другой пробе/);
});

test('tester waits for asynchronously loaded skills before admission', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-tester-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let loaded = false;
  const client = {
    model: { list: async () => ({ data: [{ providerID: 'openai', id: 'gpt-6.1-sol-ultrafast',
      enabled: true, variants: [{ id: 'high' }] }] }) },
    skill: { list: async () => {
      const data = loaded ? [{ id: 'dwf-oc' }] : [];
      loaded = true;
      return { data };
    } },
  };
  await checkTester(client, { directory, workspace: directory });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'skills.json'), 'utf8')), [{ id: 'dwf-oc' }]);
});

test('a crash before admission can create the exact persisted session', async () => {
  let session;
  const prompts = [];
  const attempt = { id: 'one', sessionId: 'ses_one', inputId: 'msg_one', prompt: 'task',
    model: { providerID: 'openai', id: 'model', variant: 'high' }, workspace: '/project' };
  const client = { session: {
    get: async () => { if (!session) throw { _tag: 'SessionNotFoundError' }; return session; },
    create: async request => { session = request; return session; },
    prompt: async prompt => { prompts.push(prompt); },
  } };
  await admitTester(client, attempt);
  await admitTester(client, attempt);
  assert.equal(session.id, attempt.sessionId);
  assert.equal(session.location.directory, attempt.workspace);
  assert.deepEqual(session.model, attempt.model);
  assert.equal(prompts.length, 2);
  assert(prompts.every(prompt => prompt.id === attempt.inputId));
});

test('visible journal retains commands and output while omitting private reasoning', () => {
  const messages = [{ type: 'assistant', id: 'msg_answer', content: [
    { type: 'reasoning', text: 'private' }, { type: 'text', text: 'visible' },
    { type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'dwf --help' }, content: ['help'] } },
  ] }];
  const visible = visibleMessages(messages);
  assert.equal(visible[0].content.length, 2);
  assert.equal(visible[0].content[1].state.input.command, 'dwf --help');
  assert.equal(messages[0].content.length, 3);
});

test('a report is terminal only after the matching prompt reaches native idle', () => {
  const attempt = { id: 'one', sessionId: 'ses_one', inputId: 'msg_one', workspace: '/project' };
  const old = [{ type: 'assistant', content: [{ type: 'text', text: 'old report' }] },
    { type: 'idle', outcome: 'succeeded' }];
  assert.equal(testerState(attempt, old).status, 'running');
  const messages = [...old, { type: 'user', id: 'msg_one' },
    { type: 'assistant', id: 'msg_first', finish: 'error', error: {}, content: [] },
    { type: 'assistant', id: 'msg_final', finish: 'stop', time: { completed: 1 },
      content: [{ type: 'text', text: 'verified report' }] }];
  assert.equal(testerState(attempt, messages).status, 'running');
  const result = testerState(attempt, [...messages, { type: 'idle', outcome: 'succeeded' }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.report, 'verified report');
  assert.equal(testerState(attempt, [...messages, { type: 'idle', outcome: 'interrupted' }]).status, 'interrupted');
  const incomplete = structuredClone(messages);
  delete incomplete.at(-1).time.completed;
  assert.equal(testerState(attempt, [...incomplete, { type: 'idle', outcome: 'succeeded' }]).status, 'failed');
  assert.equal(testerState(attempt, [...messages, { type: 'idle', outcome: 'succeeded' },
    { type: 'synthetic', text: 'Background command completed.' }]).status, 'running');
  assert.equal(testerState(attempt, [...messages, { type: 'idle', outcome: 'succeeded' },
    { type: 'assistant', id: 'msg_next', content: [] }]).status, 'running');
});

test('background work delays the final report and unrelated sessions do not block it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-tester-background-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attempt = { id: 'one', sessionId: 'ses_one', inputId: 'msg_one', directory, workspace: '/project' };
  const messages = [{ type: 'user', id: 'msg_one' },
    { type: 'assistant', id: 'msg_final', finish: 'stop', time: { completed: 1 },
      content: [{ type: 'text', text: 'Final report' }] }, { type: 'idle', outcome: 'succeeded' }];
  let pending = true;
  const client = {
    message: { list: async () => ({ data: messages, cursor: {} }) },
    session: { active: async () => ({}), inbox: { list: async () => [] } },
    shell: { list: async () => ({ data: [{ id: 'sh_one', status: 'running',
      metadata: { sessionID: pending ? 'ses_one' : 'ses_other' } }] }) },
  };
  const running = await inspectTester(client, attempt);
  assert.equal(running.status, 'running');
  assert.equal(running.report, undefined);
  await assert.rejects(readFile(join(directory, 'report.md')), { code: 'ENOENT' });
  messages[1].content[0].text = '';
  assert.equal((await inspectTester(client, attempt)).status, 'running');
  messages[1].content[0].text = 'Final report';
  pending = false;
  assert.equal((await inspectTester(client, attempt)).status, 'succeeded');
  assert.equal(await readFile(join(directory, 'report.md'), 'utf8'), 'Final report');
});
