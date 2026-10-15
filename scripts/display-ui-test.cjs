// Capture the real VS Code Electron workbench and exercise its QEMU webview.
// Uses Node.js 22's WebSocket and Chromium's local DevTools protocol. No browser
// replacement, UI mock, image compositing or extra npm package is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function until(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
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
      const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
      return response.result.value;
    },
    close() { socket.close(); }
  };
}
async function main() {
  const extensionRoot = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu actual display ui, '));
  const output = path.resolve(process.env.QEMU_ASM_DISPLAY_SCREENSHOT || path.join(extensionRoot, '..', 'qemu-asm-display-live.png'));
  const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
  const port = await freePort();
  const root = path.join(temporary, 'workspace with spaces, and commas');
  const profile = path.join(temporary, 'profile');
  const ready = path.join(temporary, 'display-ready.json');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.enableExperiments': false,
    'chat.disableAIFeatures': true, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'window.newWindowDimensions': 'maximized', 'window.restoreFullscreen': true, 'window.zoomLevel': 0, 'editor.fontSize': 16,
    'workbench.colorTheme': 'Default Dark Modern', 'window.commandCenter': false
  }));
  let workbench, webview, hostError;
  const host = runTests({
    vscodeExecutablePath: executable, extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, 'test', 'host', 'index.cjs'),
    extensionTestsEnv: { QEMU_ASM_HOST_PHASE: 'display', QEMU_ASM_HOST_ROOT: root, QEMU_ASM_DISPLAY_READY_FILE: ready, VSCODE_PORTABLE: path.join(temporary, 'portable') },
    launchArgs: [root, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions'),
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1440,1000']
  }).catch(error => { hostError = error; });
  try {
    const evidence = await until(async () => {
      if (hostError) throw hostError;
      try { return JSON.parse(await fs.readFile(ready, 'utf8')); } catch { return false; }
    }, 'real QEMU host display readiness');
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    const workbenchTarget = targets.find(target => target.type === 'page' && /workbench/i.test(target.url));
    const webviewTarget = targets.find(target => target.type === 'iframe' && /extensionId=nothingzhl\.vscode-qemu-asm/.test(target.url));
    assert(workbenchTarget && webviewTarget, 'actual Electron workbench and contributed webview must be inspectable');
    workbench = await connect(workbenchTarget.webSocketDebuggerUrl);
    webview = await connect(webviewTarget.webSocketDebuggerUrl);
    const guestDocument = "document.getElementById('active-frame')?.contentDocument";
    const imageExpression = `(() => { const d = ${guestDocument}; const image = d?.getElementById('frame'); return image && !image.hidden && image.naturalWidth > 0 && image.src.startsWith('data:image/png;base64,') ? { width: image.naturalWidth, height: image.naturalHeight, data: image.src, connected: d.getElementById('status-dot').classList.contains('connected') } : null; })()`;
    const beforeInput = await until(() => webview.evaluate(imageExpression), 'real QEMU image loaded in the actual webview');
    assert.equal(beforeInput.width, evidence.width);
    assert.equal(beforeInput.height, evidence.height);
    assert(beforeInput.connected, 'actual webview must display the live connected state');
    // Click the actual DOM control, focus the real screen and inject a Chromium
    // key event. The extension's message handler and real QMP send-key run intact.
    await webview.evaluate(`(() => { const d = ${guestDocument}; d.getElementById('keyboard').click(); d.getElementById('screen').focus(); })()`);
    await webview.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81, text: 'q', unmodifiedText: 'q' });
    await webview.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81 });
    await until(async () => {
      try { await fs.access(`${ready}.keyboard`); return true; } catch { return false; }
    }, 'actual Chromium keyboard event echoed on real guest serial');
    await new Promise(resolve => setTimeout(resolve, 600));
    await until(async () => { const image = await webview.evaluate(imageExpression); return image && image.data !== beforeInput.data; }, 'BIOS keyboard echo changed the real QEMU image');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const capture = await workbench.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fs.writeFile(output, Buffer.from(capture.data, 'base64'));
    await fs.writeFile(`${output}.json`, JSON.stringify({
      ...evidence, screenshot: output, keyboardInputSent: 'q', keyboardEchoVerifiedOnGuestSerial: true,
      source: 'Actual VS Code Electron workbench, real QEMU QMP screen capture; no UI mock or compositing.'
    }, null, 2));
    await fs.writeFile(`${ready}.captured`, 'captured');
    console.log(`PASS: actual live VS Code + QEMU workbench screenshot: ${output}`);
    workbench.close(); workbench = undefined; webview.close(); webview = undefined;
    await host;
    if (hostError) throw hostError;
  } finally {
    workbench?.close(); webview?.close();
    // Release the host on screenshot failure, so it still disposes owned QEMU.
    await fs.writeFile(`${ready}.captured`, 'cleanup').catch(() => {});
    await host;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
