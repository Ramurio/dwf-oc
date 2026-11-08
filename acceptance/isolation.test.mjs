import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createModelProxy, writeSandboxProfile } from './isolation.mjs';

test('model proxy denies source hosts and arbitrary local targets', async t => {
  const proxy = await createModelProxy();
  t.after(() => proxy.close());
  for (const target of ['github.com:443', 'chatgpt.com:80', '127.0.0.1:80', 'chatgpt.com:443@github.com:443']) {
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
      req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.once('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  }
  assert(proxy.events.every(event => !event.permitted));
});

test('kernel sandbox blocks sibling files, symlink escapes and unlisted network endpoints',
  { skip: process.platform !== 'darwin' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dwf-boundary-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    const work = join(root, 'work');
    await mkdir(work);
    const secret = join(root, 'hidden.txt');
    await writeFile(secret, 'hidden reference');
    await writeFile(join(work, 'allowed.txt'), 'source');
    await symlink(secret, join(work, 'escape.txt'));
    const profile = join(root, 'profile.sb');
    await writeSandboxProfile(profile, { writable: [work], ports: [] });
    const script = `
      const fs=require('node:fs'), net=require('node:net'), assert=require('node:assert/strict');
      assert.equal(fs.readFileSync(process.argv[1]+'/allowed.txt','utf8'),'source');
      for(const file of [process.argv[2],process.argv[1]+'/escape.txt'])
        assert.throws(()=>fs.readFileSync(file), {code:'EPERM'});
      const socket=net.connect(443,'1.1.1.1');
      socket.once('connect',()=>{throw Error('network escape')});
      socket.once('error',error=>{assert(['EPERM','EACCES'].includes(error.code));console.log('isolated')});
    `;
    const output = execFileSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', script, work, secret],
      { cwd: work, env: { PATH: '/usr/bin:/bin', HOME: work, TMPDIR: work }, encoding: 'utf8', timeout: 10000 });
    assert.equal(output.trim(), 'isolated');
  });

test('kernel sandbox can signal its own descendants while rejecting outside processes',
  { skip: process.platform !== 'darwin' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dwf-signal-boundary-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const profile = join(root, 'sandbox.sb');
    await writeSandboxProfile(profile, { writable: [root], ports: [] });
    const outside = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    t.after(() => outside.kill('SIGKILL'));
    const code = `
      const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
      assert.throws(()=>process.kill(Number(process.argv[1]),'SIGUSR1'), {code:'EPERM'});
      const child=spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)']);
      child.stdout.once('data',()=>process.kill(child.pid,'SIGKILL'));
      child.once('exit',(_code,signal)=>{assert.equal(signal,'SIGKILL');console.log('own child stopped')});
    `;
    const output = execFileSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', code, String(outside.pid)],
      { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root }, encoding: 'utf8', timeout: 10000 });
    assert.equal(output.trim(), 'own child stopped');
  });
