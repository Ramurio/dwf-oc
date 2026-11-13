import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readUiRuns } from './ui-data.mjs';
import { writeUiRegistration, clearUiRegistration, uiProcessIdentity } from './ui-service.mjs';

const [root, token] = process.argv.slice(2);
const instance = randomUUID();
if (!root || !token) throw new Error('Internal UI server requires a state directory and token');
const assets = new Map(['app.mjs', 'layout.mjs', 'styles.css'].map(name => [
  '/' + name, new URL('./prototypes/dwf-ui/' + name, import.meta.url),
]));
assets.set('/index.html', new URL('./prototypes/dwf-ui/index.html', import.meta.url));
assets.set('/', assets.get('/index.html'));
let info;
let closing = false;
let snapshot;

const server = createServer(async (req, res) => {
  const reply = (status, data, type = 'application/json') => {
    res.writeHead(status, {
      'Content-Type': type + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  // Loopback bind alone does not prevent DNS rebinding or cross-site reads.
  if (!info || req.headers.host !== new URL(info.url).host ||
      req.headers.origin && req.headers.origin !== new URL(info.url).origin) {
    return reply(403, { error: 'Local UI origin required' });
  }
  let path;
  try {
    path = new URL(req.url, info.url).pathname;
  } catch {
    return reply(400, { error: 'Invalid URL' });
  }
  const authorized = req.headers.authorization === `Bearer ${token}`;
  if (path === '/api/health') {
    return authorized ? reply(200, { service: 'dwf-ui', instance }) : reply(403, { error: 'Unauthorized' });
  }
  if (path === '/api/stop') {
    if (req.method !== 'POST' || !authorized) return reply(403, { error: 'Unauthorized' });
    reply(200, { status: 'stopping' });
    void stop();
    return;
  }
  if (req.method !== 'GET') return reply(405, { error: 'Read-only UI' });
  try {
    if (path === '/api/runs') {
      snapshot ??= readUiRuns(root).finally(() => { snapshot = null; });
      return reply(200, await snapshot);
    }
    const asset = assets.get(path);
    if (!asset) return reply(404, { error: 'Not found' });
    let body = await readFile(asset, 'utf8');
    if (path === '/' || path === '/index.html') {
      body = body.replace('<body>', '<body data-live="true">')
        .replace('LOCAL DEMO <span>· Fictional sessions</span>', 'LOCAL UI <span id="connection">· Connecting…</span>')
        .replace('No live connection. All demo data stays in this browser.', 'Read-only view of this DWF_STATE_DIR. No workflow controls.')
        .replace('This is an offline design prototype, not a scheduler or editor. Every ID is fictional. Live DWF and OpenCode integration are future work.',
          'Live observations from saved DWF runs. Unknown fields are not inferred. Copy a command to continue in OpenCode; nothing is executed here.')
        .replace('This interactive, fictional map needs JavaScript. Serve this folder locally as described in README.md.',
          'This local workflow viewer needs JavaScript.');
    }
    let type = 'text/html';
    if (path.endsWith('.mjs')) type = 'text/javascript';
    else if (path.endsWith('.css')) type = 'text/css';
    return reply(200, body, type);
  } catch {
    return reply(503, { error: 'Saved DWF state is temporarily unavailable or incompatible. Retrying does not change runs.' });
  }
});

async function stop() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await clearUiRegistration(root, instance);
  setImmediate(() => process.exit(0));
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
server.listen(0, '127.0.0.1', async () => {
  try {
    info = {
      host: server.address().address,
      url: `http://127.0.0.1:${server.address().port}/`,
      instance, token, pid: process.pid, processIdentity: uiProcessIdentity(process.pid),
    };
    await writeUiRegistration(root, info);
    if (process.connected) process.send({ ready: true, url: info.url });
  } catch {
    server.close();
    process.exitCode = 1;
  }
});
