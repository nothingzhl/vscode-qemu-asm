// Capture the real VS Code workbench while QEMU is paused in a 32-bit nested
// call. Uses Node.js 22 WebSocket and local Chromium DevTools; no UI mock,
// replacement browser, image compositing or extra npm package is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function until(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for ${description}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let serial = 0;
  const requests = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
        requests.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    close() { socket.close(); }
  };
}
async function main() {
  const extensionRoot = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu actual protected ui, '));
  const output = path.resolve(process.env.QEMU_ASM_PROTECTED_SCREENSHOT || path.join(extensionRoot, '..', 'qemu-asm-protected-live.png'));
  const root = path.join(temporary, 'workspace with spaces, and commas');
  const profile = path.join(temporary, 'profile');
  const ready = path.join(temporary, 'protected-ready.json');
  let workbench, webview, host, hostError, hostFinished = false;
  try {
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    const port = await freePort();
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.enableExperiments': false,
      'chat.disableAIFeatures': true, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
      'window.newWindowDimensions': 'maximized', 'window.zoomLevel': 0, 'editor.fontSize': 15,
      'workbench.colorTheme': 'Default Dark Modern', 'window.commandCenter': false,
      'debug.openDebug': 'openOnSessionStart', 'debug.showBreakpointsInOverviewRuler': true,
      'debug.console.closeOnEnd': true
    }));
    host = runTests({
      vscodeExecutablePath: executable, extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: path.join(extensionRoot, 'test', 'host', 'index.cjs'),
      extensionTestsEnv: {
        QEMU_ASM_HOST_PHASE: 'protected', QEMU_ASM_HOST_ROOT: root,
        QEMU_ASM_PROTECTED_UI_READY: ready, VSCODE_PORTABLE: path.join(temporary, 'portable')
      },
      launchArgs: [root, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions'),
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1680,1080']
    }).catch(error => { hostError = error; }).finally(() => { hostFinished = true; });
    const evidence = await until(async () => {
      if (hostError) throw hostError;
      if (hostFinished) throw new Error('Protected host finished before the screenshot handshake');
      try { return JSON.parse(await fs.readFile(ready, 'utf8')); } catch { return false; }
    }, 'actual 32-bit QEMU nested breakpoint');
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    const workbenchTarget = targets.find(target => target.type === 'page' && /workbench/i.test(target.url));
    const webviewTarget = targets.find(target => target.type === 'iframe' && /extensionId=nothingzhl\.vscode-qemu-asm/.test(target.url));
    assert(workbenchTarget && webviewTarget, 'actual Electron workbench and QEMU webview must be inspectable');
    workbench = await connect(workbenchTarget.webSocketDebuggerUrl);
    webview = await connect(webviewTarget.webSocketDebuggerUrl);
    const imageExpression = `(() => {
      const d = document.getElementById('active-frame')?.contentDocument;
      const image = d?.getElementById('frame');
      return image && !image.hidden && image.naturalWidth > 0 && image.src.startsWith('data:image/png;base64,')
        ? { width: image.naturalWidth, height: image.naturalHeight, connected: d.getElementById('status-dot').classList.contains('connected') } : null;
    })()`;
    const frame = await until(() => webview.evaluate(imageExpression), 'real QEMU protected-mode frame in the actual webview');
    assert(frame.connected, 'monitor must remain connected while QEMU is paused');
    // Keep the real four-byte stack slots visible beside the compact register
    // Watch expressions prepared by the host. Every value comes from QEMU.
    for (let attempt = 0; attempt < 3; attempt++) {
      await workbench.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.debug-variables [role="treeitem"]')];
        for (const row of rows) {
          if (/寄存器/.test(row.textContent) && row.getAttribute('aria-expanded') === 'true') row.querySelector('.monaco-tl-twistie')?.click();
          if (/栈内存/.test(row.textContent) && row.getAttribute('aria-expanded') === 'false') row.querySelector('.monaco-tl-twistie')?.click();
        }
        for (const close of document.querySelectorAll('.notifications-toasts .codicon-close')) close.click();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const watch = await workbench.evaluate(`(() => {
      const view = document.querySelector('.debug-watch');
      if (!view) return null;
      const bounds = view.getBoundingClientRect();
      const top = view.closest('.pane')?.getBoundingClientRect().top ?? bounds.top;
      const sash = [...document.querySelectorAll('.monaco-sash.horizontal')].map(element => element.getBoundingClientRect())
        .find(rect => rect.width > 200 && rect.left < 350 && Math.abs(rect.top - top) < 10);
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2,
        sash: sash ? { x: sash.left + sash.width / 2, y: sash.top + sash.height / 2 } : null };
    })()`);
    if (watch?.sash) {
      await workbench.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...watch.sash, button: 'left', buttons: 1, clickCount: 1 });
      await workbench.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: watch.sash.x, y: watch.sash.y - 50, button: 'left', buttons: 1 });
      await workbench.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: watch.sash.x, y: watch.sash.y - 50, button: 'left', buttons: 0, clickCount: 1 });
    }
    if (watch) await workbench.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: watch.x, y: watch.y, deltaX: 0, deltaY: -500 });
    await new Promise(resolve => setTimeout(resolve, 300));
    const text = await workbench.evaluate('document.body.innerText');
    assert(/stage2\.asm/.test(text), 'actual stage2 source must be open');
    assert(/eax/i.test(text) && /esp/i.test(text) && /11223344/i.test(text), 'real debug Watch tree must expose the actual 32-bit register values');
    const visibleMonitor = await workbench.evaluate(`(() => {
      const frame = [...document.querySelectorAll('iframe')].find(frame => frame.classList.contains('webview') && frame.getBoundingClientRect().width > 300);
      if (!frame) return null;
      const bounds = frame.getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    })()`);
    assert(visibleMonitor && visibleMonitor.left > 500 && visibleMonitor.height > 300, 'real monitor must be visible in the right editor group beside the source');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const capture = await workbench.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fs.writeFile(output, Buffer.from(capture.data, 'base64'));
    await fs.writeFile(`${output}.json`, JSON.stringify({
      ...evidence, screenshot: output, monitor: { ...frame, bounds: visibleMonitor },
      sourceOfScreenshot: 'Actual VS Code Electron workbench paused at a real QEMU 32-bit nested-call breakpoint; no UI mock or compositing.'
    }, null, 2));
    console.log(`PASS: actual paused 32-bit VS Code + QEMU screenshot: ${output}`);
    await fs.writeFile(`${ready}.continue`, 'captured');
    workbench.close(); workbench = undefined; webview.close(); webview = undefined;
    await host;
    if (hostError) throw hostError;
  } finally {
    workbench?.close(); webview?.close();
    await fs.writeFile(`${ready}.continue`, 'cleanup').catch(() => {});
    await host;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
