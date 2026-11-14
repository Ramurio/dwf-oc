import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAttempt, admitTester, visibleMessages, testerState, inspectTester, checkTester, prepareTesterSkill } from './tester.mjs';

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
  const inherited = await readFile(join(first.directory, 'AGENTS.md'), 'utf8');
  // TMPDIR may have additional project instructions above this fixture.
  assert(inherited.endsWith('Inherited project instructions.\n'));
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
  pending = true;
  assert.equal((await inspectTester(client, attempt)).status, 'running');
  await assert.rejects(readFile(join(directory, 'report.md')), { code: 'ENOENT' });
});

for (const active of [false, true]) test(`tester completion changing during activity waits for a fresh poll (busy=${active})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-tester-moving-completion-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attempt = { id: 'one', sessionId: 'ses_one', inputId: 'msg_one', directory, workspace: '/project' };
  let messages = [{ type: 'user', id: 'msg_one' },
    { type: 'assistant', id: 'msg_early', finish: 'stop', time: { completed: 1 },
      content: [{ type: 'text', text: 'Early success' }] }, { type: 'idle', outcome: 'succeeded' }];
  const client = {
    message: { list: async () => ({ data: messages, cursor: {} }) },
    shell: { list: async () => ({ data: [] }) },
    session: {
      inbox: { list: async () => [] },
      active: async () => {
        messages = [...messages, { type: 'synthetic', text: 'Background completion' },
          { type: 'assistant', id: 'msg_late', finish: 'error', time: { completed: 2 },
            error: { message: 'Late failure' }, content: [] },
          { type: 'idle', outcome: 'failed', error: 'Late failure' }];
        return active ? { ses_one: true } : {};
      },
    },
  };
  const first = await inspectTester(client, attempt);
  assert.equal(first.status, 'running');
  assert.equal(first.report, undefined);
  await assert.rejects(readFile(join(directory, 'report.md')), { code: 'ENOENT' });
  const journal = JSON.parse(await readFile(join(directory, 'messages.json'), 'utf8'));
  assert.equal(journal.at(-1).outcome, 'failed');
  const last = await inspectTester(client, attempt);
  assert.equal(last.status, 'failed');
  assert.equal(last.error, 'Late failure');
});

test('resumed tester reports replace old completions and retain length continuations', () => {
  const attempt = { id: 'one', sessionId: 'ses_one', inputId: 'msg_one', workspace: '/project' };
  const answer = (id, text, finish = 'stop') => ({ type: 'assistant', id, finish,
    time: { completed: 1 }, content: [{ type: 'text', text }] });
  const messages = [{ type: 'user', id: 'msg_one' }, answer('early', 'Early success'),
    { type: 'idle', outcome: 'succeeded' }];
  for (const resume of [[], [{ type: 'synthetic', text: 'Background completion' }]]) {
    const state = testerState(attempt, [...messages, ...resume, answer('late', 'Late correction'),
      { type: 'idle', outcome: 'succeeded' }]);
    assert.equal(state.report, 'Late correction');
  }
  assert.equal(testerState(attempt, [{ type: 'user', id: 'msg_one' }, answer('first', 'Long ', 'length'),
    answer('last', 'report'), { type: 'idle', outcome: 'succeeded' }]).report, 'Long report');
});


test('explicit candidate skills cannot silently reuse another launcher in an existing profile', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-tester-skill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'candidate');
  const target = join(directory, 'profile/skills/dwf-oc');
  await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: dwf-oc\ndescription: test\n---\nCandidate launcher\n');
  await writeFile(join(source, 'references/cli.md'), 'Candidate CLI\n');
  const evidence = await prepareTesterSkill(source, target);
  assert.equal(evidence.sourceDirectory, await realpath(source));
  assert.equal(evidence.installedDirectory, await realpath(target));
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await prepareTesterSkill(source, target), evidence);
  await writeFile(join(source, 'references/cli.md'), 'Changed reference\n');
  await assert.rejects(prepareTesterSkill(source, target), /fresh|свеж/i);
  assert.equal(await readFile(join(target, 'references/cli.md'), 'utf8'), 'Candidate CLI\n');
});

test('tester verifies the native loaded launcher path and body, not only its ID', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dwf-tester-loaded-skill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'candidate');
  const target = join(directory, 'profile/skills/dwf-oc');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: dwf-oc\n---\nCandidate launcher\n');
  const dwfTesterSkill = await prepareTesterSkill(source, target);
  const selected = { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' };
  let loaded = { id: 'dwf-oc', path: join(source, 'SKILL.md'), content: 'Candidate launcher' };
  const client = { dwfTesterSkill,
    model: { list: async () => ({ data: [{ ...selected, enabled: true, variants: [{ id: 'high' }] }] }) },
    skill: { list: async () => ({ data: [loaded] }) } };
  const attempt = { directory, workspace: directory, model: selected };
  await assert.rejects(checkTester(client, attempt), /path|путь/i);
  loaded.path = join(target, 'SKILL.md'); loaded.content = 'Stale launcher';
  await assert.rejects(checkTester(client, attempt), /content|содерж/i);
  loaded.content = 'Candidate launcher';
  await checkTester(client, attempt);
  const saved = JSON.parse(await readFile(join(directory, 'skill-evidence.json'), 'utf8'));
  assert.equal(saved.sha256, dwfTesterSkill.sha256);
  assert.equal(saved.loadedPath, loaded.path);
  await writeFile(join(target, 'SKILL.md'), 'Changed after connection');
  await assert.rejects(checkTester(client, attempt), /fresh|свеж/i);
});
