import { createServer } from 'node:http';
import { connect } from 'node:net';
import { realpath, writeFile } from 'node:fs/promises';

const modelHosts = new Set(['chatgpt.com', 'api.openai.com', 'auth.openai.com']);

export async function createModelProxy() {
  const events = [];
  const sockets = new Set();
  const server = createServer((_request, response) => response.writeHead(403).end());
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('connect', (request, client, head) => {
    const permitted = [...modelHosts].some(host => request.url === `${host}:443`);
    events.push({ target: request.url, permitted, at: Date.now() });
    if (!permitted) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const host = request.url.slice(0, -4);
    const upstream = connect(443, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { port, url: `http://127.0.0.1:${port}`, events,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    } };
}

export async function writeSandboxProfile(file, { writable, readable = [], ports }) {
  if (process.platform !== 'darwin') throw new Error('Verified benchmark isolation currently requires macOS sandbox-exec.');
  const writePaths = await Promise.all(writable.map(path => realpath(path)));
  const readPaths = await Promise.all(readable.map(path => realpath(path)));
  if (!ports.every(port => Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('Invalid sandbox port.');
  const subpaths = paths => paths.map(path => `(subpath ${JSON.stringify(path)})`).join(' ');
  const profile = [
    '(version 1)', '(deny default)',
    '(allow process-exec process-fork sysctl-read mach-lookup signal)',
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/"))',
    `(allow file-read* file-map-executable ${subpaths(['/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/private/etc', '/private/var/db', ...readPaths])})`,
    `(allow file-read* file-write* ${subpaths(['/dev', ...writePaths])})`,
    '(allow network-bind network-inbound (local tcp "localhost:*"))',
    ...ports.map(port => `(allow network-outbound (remote tcp "localhost:${port}"))`),
  ].join('\n') + '\n';
  await writeFile(file, profile, { mode: 0o600 });
  return profile;
}
