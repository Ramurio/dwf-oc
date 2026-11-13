import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { publicError, withServiceLock } from './run-store.mjs';

export function uiProcessIdentity(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'uid=,lstart=,command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
  } catch {
    return null;
  }
}

export async function uiRegistration(root) {
  try {
    return JSON.parse(await readFile(join(root, 'ui.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function registeredUi(root) {
  const info = await uiRegistration(root);
  if (info?.host !== '127.0.0.1' || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(info.url) || typeof info.token !== 'string') {
    return null;
  }
  try {
    const response = await fetch(info.url + 'api/health', {
      headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1200),
    });
    const health = await response.json();
    return response.ok && health.service === 'dwf-ui' && health.instance === info.instance ? info : null;
  } catch {
    // A busy event loop or temporarily locked SQLite must not create a second
    // UI. PID alone is insufficient: compare birth time AND full command.
    if (info.processIdentity && uiProcessIdentity(info.pid) === info.processIdentity) {
      return { ...info, unresponsive: true };
    }
    return null;
  }
}

export async function writeUiRegistration(root, info) {
  const temp = join(root, `ui.${info.instance}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(info) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, join(root, 'ui.json'));
  } finally {
    await unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function clearUiRegistration(root, instance) {
  if ((await uiRegistration(root))?.instance === instance) {
    await unlink(join(root, 'ui.json')).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function uiCommand(root, args) {
  const action = (args[0] ?? 'status').replace(/^--/, '');
  if (args.length > 1 || !['start', 'stop', 'status'].includes(action)) {
    throw publicError('Использование: dwf ui --start | --stop | --status');
  }
  process.umask(0o077);
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Same short-lived cross-process SQLite lock as native service startup. The
  // child does not touch SQLite until after its readiness acknowledgement.
  return withServiceLock(root, async () => {
    const existing = await registeredUi(root);
    if (action === 'status') {
      return existing ? { status: 'running', url: existing.url } : { status: 'stopped' };
    }
    if (action === 'stop') {
      if (existing) {
        const response = await fetch(existing.url + 'api/stop', {
          method: 'POST', headers: { Authorization: `Bearer ${existing.token}` }, signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw publicError('UI не подтвердил остановку.');
        for (let attempt = 0; attempt < 60; attempt++) {
          if (!await registeredUi(root)) {
            await clearUiRegistration(root, existing.instance);
            return { status: 'stopped' };
          }
          await pause(50);
        }
        throw publicError('Не удалось подтвердить остановку UI.');
      }
      return { status: 'stopped' };
    }
    if (existing) return { status: 'running', url: existing.url };
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./ui-server.mjs', import.meta.url)), root, randomBytes(24).toString('hex'),
    ], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env, cwd: root,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(publicError('UI не подтвердил запуск.')), 15000);
      function finish(error, message) {
        clearTimeout(timer);
        child.removeAllListeners();
        if (error) child.kill('SIGTERM');
        if (child.connected) child.disconnect();
        child.unref();
        if (error) reject(error);
        else resolve({ status: 'running', url: message.url });
      }
      child.once('error', finish);
      child.once('exit', () => finish(publicError('UI завершился до готовности.')));
      child.once('message', message => {
        if (message.ready) finish(null, message);
        else finish(publicError('Не удалось запустить UI.'));
      });
    });
  });
}
