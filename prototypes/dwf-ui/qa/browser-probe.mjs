import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

// Each reviewer owns an isolated browser and temporary profile. No shared port.
export async function openBrowser(file = 'index.html') {
  const profile = await mkdtemp(join(tmpdir(), 'dwf-design-chrome-'));
  const child = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'],
    { stdio: 'ignore' });
  let socket;
  const pending = new Map();
  const errors = [];
  const close = async () => {
    socket?.close();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser closed')); }
    pending.clear();
    if (child.exitCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, pause(3000)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  };
  let launchError;
  child.on('error', error => { launchError = error; });
  try {
    let port;
    for (let i = 0; i < 200; i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Chrome exited during launch');
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {}
      if (port) break;
      await pause(50);
    }
    if (!port) throw new Error('Chrome debugging port did not appear');
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
    let next = 0;
    socket.addEventListener('message', ({ data }) => {
      const m = JSON.parse(data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(resolve(file)).href });
    for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState === "complete"')) break; await pause(50); }
    return {
      send, evaluate, errors, close,
      viewport: async (width, height) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await pause(100); },
      screenshot: async file => { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(file, Buffer.from(result.data, 'base64')); },
    };
  } catch (error) { await close(); throw error; }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'dwf-design-evidence-'));
  await mkdir(evidence, { recursive: true });
  const browser = await openBrowser(process.argv[2] || 'index.html');
  try {
    for (const [w, h] of [[1440, 900], [1280, 720], [1024, 768], [390, 844]]) {
      await browser.viewport(w, h);
      await browser.screenshot(join(evidence, `${w}x${h}.png`));
      await writeFile(join(evidence, `${w}x${h}.txt`), await browser.evaluate('document.body.innerText'));
    }
    console.log(JSON.stringify({ evidence, errors: browser.errors }));
  } finally { await browser.close(); }
}
