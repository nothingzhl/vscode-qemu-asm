// Operate the actual VS Code inspector and capture three independent workbench
// screenshots. RAM, descriptors and changed bytes come from the same live QEMU.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function until(predicate, description, timeout = 90000) {
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
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close() { socket.close(); }
  };
}
const inView = expression => `(() => {
  const d = document.getElementById('active-frame')?.contentDocument;
  if (!d) return null;
  return (${expression});
})()`;
const hex = value => `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;

async function main() {
  const extensionRoot = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu actual inspection ui, '));
  const outputRoot = path.resolve(process.env.QEMU_ASM_INSPECTION_SCREENSHOT_DIRECTORY || path.join(extensionRoot, '..'));
  const root = path.join(temporary, 'workspace with spaces, and commas');
  const profile = path.join(temporary, 'profile');
  const ready = path.join(temporary, 'inspection-ready.json');
  const clients = [];
  let workbench, inspector, monitor, host, hostError, hostFinished = false;
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
      'workbench.panel.defaultLocation': 'bottom', 'debug.openDebug': 'openOnSessionStart',
      'debug.console.closeOnEnd': true
    }));
    host = runTests({
      vscodeExecutablePath: executable, extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: path.join(extensionRoot, 'test', 'host', 'index.cjs'),
      extensionTestsEnv: {
        QEMU_ASM_HOST_PHASE: 'inspection', QEMU_ASM_HOST_ROOT: root,
        QEMU_ASM_INSPECTION_UI_READY: ready, VSCODE_PORTABLE: path.join(temporary, 'portable')
      },
      launchArgs: [root, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions'),
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1800,1200']
    }).catch(error => { hostError = error; }).finally(() => { hostFinished = true; });
    const checkHost = () => {
      if (hostError) throw hostError;
      if (hostFinished) throw new Error('Inspection host finished before the screenshot handshake');
    };
    const evidence = await until(async () => {
      checkHost();
      try { return JSON.parse(await fs.readFile(ready, 'utf8')); } catch { return false; }
    }, 'actual QEMU inspection breakpoint');
    assert(Number.isInteger(evidence.dataAddress), 'host must expose the actual CPU EDI data pointer');
    const connected = new Map();
    await until(async () => {
      checkHost();
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      for (const target of targets) {
        const relevant = target.type === 'page' && /workbench/i.test(target.url)
          || target.type === 'iframe' && /extensionId=nothingzhl\.vscode-qemu-asm/.test(target.url);
        if (!relevant) continue;
        let client = connected.get(target.id);
        if (!client) { client = await connect(target.webSocketDebuggerUrl); connected.set(target.id, client); clients.push(client); }
        if (target.type === 'page') workbench = client;
        else {
          // Both monitor and inspector belong to this extension. Identify their
          // real active frames instead of relying on target ordering.
          const kind = await client.evaluate(inView(`d.getElementById('tab-memory') ? 'inspector' : d.getElementById('frame') ? 'monitor' : null`));
          if (kind === 'inspector') inspector = client;
          if (kind === 'monitor') monitor = client;
        }
      }
      return workbench && inspector && monitor;
    }, 'actual Electron workbench, bottom inspector and right monitor webviews');
    // Xvfb has no window manager and Electron omits CDP Browser window methods.
    // Resize the actual native X11 window; this changes no DOM or guest data.
    if (process.platform === 'linux' && process.env.DISPLAY) execFileSync('python3', ['-c', `
import ctypes, ctypes.util
x = ctypes.CDLL(ctypes.util.find_library('X11'))
display_type, window_type = ctypes.c_void_p, ctypes.c_ulong
x.XOpenDisplay.argtypes = [ctypes.c_char_p]; x.XOpenDisplay.restype = display_type
x.XDefaultRootWindow.argtypes = [display_type]; x.XDefaultRootWindow.restype = window_type
x.XQueryTree.argtypes = [display_type, window_type, ctypes.POINTER(window_type), ctypes.POINTER(window_type), ctypes.POINTER(ctypes.POINTER(window_type)), ctypes.POINTER(ctypes.c_uint)]
x.XFetchName.argtypes = [display_type, window_type, ctypes.POINTER(ctypes.c_char_p)]
class ClassHint(ctypes.Structure): _fields_ = [('name',ctypes.c_char_p),('kind',ctypes.c_char_p)]
x.XGetClassHint.argtypes = [display_type, window_type, ctypes.POINTER(ClassHint)]
x.XMoveResizeWindow.argtypes = [display_type, window_type, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint]
x.XFlush.argtypes = [display_type]; x.XCloseDisplay.argtypes = [display_type]
d = x.XOpenDisplay(None)
if not d: raise RuntimeError('Cannot open the screenshot X11 display')
root, parent, children, count = window_type(), window_type(), ctypes.POINTER(window_type)(), ctypes.c_uint()
if not x.XQueryTree(d, x.XDefaultRootWindow(d), ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)): raise RuntimeError('Cannot query native workbench windows')
matched, observed = 0, []
for index in range(count.value):
    title, hint = ctypes.c_char_p(), ClassHint()
    x.XFetchName(d, children[index], ctypes.byref(title)); x.XGetClassHint(d,children[index],ctypes.byref(hint))
    observed.append((title.value,hint.name,hint.kind))
    if b'code' in (hint.kind or b'').lower() or b'workspace with spaces' in (title.value or b''):
        x.XMoveResizeWindow(d, children[index], 0, 0, 1800, 1200); matched += 1
if not matched: raise RuntimeError('No actual Visual Studio Code X11 window found: '+repr(observed))
x.XFlush(d); x.XCloseDisplay(d)
`], { stdio: 'pipe' });
    await until(() => workbench.evaluate('innerWidth >= 1700 && innerHeight >= 1100'), 'actual native 1800x1200 workbench window');
    const frame = await until(() => monitor.evaluate(inView(`(() => {
      const image = d.getElementById('frame');
      return image && !image.hidden && image.naturalWidth > 0 && image.src.startsWith('data:image/png;base64,')
        ? { width: image.naturalWidth, height: image.naturalHeight, connected: d.getElementById('status-dot').classList.contains('connected') } : null;
    })()`)), 'real QEMU VGA image');
    assert(frame.connected);
    // Resize the actual workbench panel through its sash. No DOM layout or
    // displayed data is replaced for the screenshots.
    const sash = await workbench.evaluate(`(() => {
      const panel = document.querySelector('.part.panel');
      if (!panel) return null;
      const bounds = panel.getBoundingClientRect();
      const handle = [...document.querySelectorAll('.monaco-sash.horizontal')]
        .map(element => element.getBoundingClientRect())
        .find(rect => rect.width > 500 && Math.abs(rect.top - bounds.top) < 12);
      return handle ? { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2,
        target: Math.round(innerHeight * .52) } : null;
    })()`);
    if (sash) {
      await workbench.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sash.x, y: sash.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 8; step++) await workbench.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: sash.x, y: sash.y + (sash.target - sash.y) * step / 8, button: 'left', buttons: 1
      });
      await workbench.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sash.x, y: sash.target, button: 'left', buttons: 0, clickCount: 1 });
    }
    const memoryState = () => inspector.evaluate(inView(`({
      selected: d.getElementById('tab-memory').getAttribute('aria-selected'),
      status: d.getElementById('status').textContent,
      stopped: d.getElementById('status-dot').classList.contains('stopped'),
      stale: d.body.classList.contains('stale'),
      address: d.getElementById('address').value,
      range: d.getElementById('memory-range').textContent,
      cells: [...d.querySelectorAll('#memory-body td.byte')].map(cell => ({ text: cell.textContent, changed: cell.classList.contains('changed'), title: cell.title })),
      editableCells: d.querySelectorAll('td[contenteditable="true"], textarea, input:not(#address)').length,
      writeButtons: [...d.querySelectorAll('button')].filter(button => /写入|write/i.test(button.textContent)).length,
      followHeight: d.getElementById('follow').getBoundingClientRect().height,
      followLineHeight: d.defaultView.getComputedStyle(d.getElementById('follow')).lineHeight,
      followAppearance: d.defaultView.getComputedStyle(d.getElementById('follow')).appearance,
      goDisabled: d.getElementById('go').disabled
    })`));
    await until(async () => { const state = await memoryState(); return state?.stopped && !state.goDisabled; }, 'paused inspector address controls');
    await inspector.evaluate(inView(`(() => {
      d.getElementById('tab-memory').click();
      const input = d.getElementById('address');
      input.value = ${JSON.stringify(hex(evidence.dataAddress))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      d.getElementById('address-form').requestSubmit();
      return true;
    })()`));
    const baseline = await until(async () => {
      const state = await memoryState();
      return state?.stopped && !state.stale && state.range.startsWith(hex(evidence.dataAddress)) && state.cells.length >= 12 ? state : null;
    }, 'actual memory at the CPU EDI pointer');
    assert.equal(baseline.cells.slice(0, 12).map(cell => cell.text).join('').toLowerCase(), evidence.expectedData || '443322118877665500000000');
    assert.equal(baseline.editableCells, 0); assert.equal(baseline.writeButtons, 0);
    await fs.writeFile(`${ready}.step`, 'memory baseline read in real webview');
    const changedEvidence = await until(async () => {
      checkHost();
      try { return JSON.parse(await fs.readFile(`${ready}.changed`, 'utf8')); } catch { return false; }
    }, 'actual QEMU NOP and INC stepping');
    const memory = await until(async () => {
      const state = await memoryState();
      return state?.stopped && !state.stale && state.cells[8]?.text === '01' && state.cells[8].changed ? state : null;
    }, 'real RAM byte highlighted after CPU INC');
    assert.equal(memory.cells.slice(0, 12).map(cell => cell.text).join('').toLowerCase(), '443322118877665501000000');
    assert.equal(memory.editableCells, 0); assert.equal(memory.writeButtons, 0);
    assert(memory.followHeight >= 28, 'actual native follow selector must leave readable space for its text');
    assert.equal(memory.followAppearance, 'none', 'follow selector must use the tested text layout instead of the clipping native theme');
    assert.equal(memory.followLineHeight, '26px');
    const bounds = await workbench.evaluate(`(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      panel: (() => { const r = document.querySelector('.part.panel')?.getBoundingClientRect(); return r ? { left:r.left,top:r.top,width:r.width,height:r.height } : null; })(),
      webviews: [...document.querySelectorAll('iframe.webview')].map(element => { const r=element.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height}; })
    }))()`);
    console.log(`Actual inspector layout: ${JSON.stringify({ bounds, sash })}`);
    if (!bounds.panel || bounds.panel.height < 300) {
      const diagnostic = await workbench.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await fs.writeFile(path.join(outputRoot, 'qemu-asm-inspection-layout.png'), Buffer.from(diagnostic.data, 'base64'));
    }
    assert(bounds.panel && bounds.panel.height >= 300, 'actual bottom inspector needs readable space');
    const text = await workbench.evaluate('document.body.innerText');
    assert(/stage2\.asm/.test(text), 'actual source must remain open beside the monitor');
    await fs.mkdir(outputRoot, { recursive: true });
    const capture = async (tab, snapshot) => {
      await workbench.evaluate(`(() => {
        for (const close of document.querySelectorAll('.notifications-toasts .codicon-close')) close.click();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 250));
      const output = path.join(outputRoot, `qemu-asm-inspection-${tab}.png`);
      const result = await workbench.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await fs.writeFile(output, Buffer.from(result.data, 'base64'));
      await fs.writeFile(`${output}.json`, JSON.stringify({
        ...evidence, changedEvidence, tab, screenshot: output, monitor: frame, bounds, snapshot,
        sourceOfScreenshot: 'Actual VS Code Electron workbench and real QEMU. Controls operated through local CDP; no mock, replaced data, or compositing.'
      }, null, 2));
      console.log(`PASS: actual live inspector ${tab} screenshot: ${output}`);
    };
    await capture('memory', memory);
    const descriptors = async tab => {
      await inspector.evaluate(inView(`(() => { d.getElementById('tab-${tab}').click(); return true; })()`));
      return until(() => inspector.evaluate(inView(`(() => {
        if (d.getElementById('tab-${tab}').getAttribute('aria-selected') !== 'true' || d.body.classList.contains('stale') || d.getElementById('descriptor-view').hidden) return null;
        const rows = [...d.querySelectorAll('#descriptor-body tr')].map(row => ({cells:[...row.cells].map(cell=>cell.textContent), title:row.title}));
        return rows.length ? { title:d.getElementById('descriptor-title').textContent, meta:d.getElementById('table-meta').textContent,
          rows, headers:[...d.querySelectorAll('#descriptor-head th')].map(cell=>cell.textContent), status:d.getElementById('status').textContent } : null;
      })()`)), `actual ${tab.toUpperCase()} descriptor read`);
    };
    const gdt = await descriptors('gdt');
    assert(gdt.rows.length >= 3);
    assert(gdt.rows[1].cells[0].includes('0x0008') && gdt.rows[1].cells[0].includes('CS'));
    assert.equal(gdt.rows[1].cells[2], '0x00000000'); assert.equal(gdt.rows[1].cells[3], '0xFFFFFFFF');
    assert(gdt.rows[1].cells[6].includes('32'));
    assert(gdt.rows[2].cells[0].includes('0x0010') && gdt.rows[2].cells[0].includes('SS'));
    if (Number.isInteger(evidence.gdt?.base)) assert(gdt.meta.includes(hex(evidence.gdt.base)));
    await capture('gdt', gdt);
    const idt = await descriptors('idt');
    assert.equal(idt.rows.length, 4); assert.equal(idt.rows[3].cells[2], '0x0008');
    assert.equal(idt.rows[3].cells[4], '1'); assert.equal(idt.rows[3].cells[5], '0'); assert.equal(idt.rows[3].cells[6], '32');
    assert(/中断|interrupt/i.test(idt.rows[3].cells[1]));
    if (Number.isInteger(evidence.idt?.base)) assert(idt.meta.includes(hex(evidence.idt.base)));
    const gate = evidence.idt?.entries?.find(entry => entry.index === 3);
    if (gate) assert.equal(idt.rows[3].cells[3], hex(gate.offset));
    await capture('idt', idt);
    // Return through the real tab control so the host's remaining restart and
    // fresh-session checks exercise the default memory view as usual.
    await inspector.evaluate(inView(`(() => { d.getElementById('tab-memory').click(); return true; })()`));
    await until(async () => { const state = await memoryState(); return state?.selected === 'true' && state.stopped && !state.stale; }, 'memory tab restored for restart validation');
    await fs.writeFile(`${ready}.continue`, 'three actual inspector screenshots captured');
    for (const client of clients) client.close(); clients.length = 0;
    await host;
    if (hostError) throw hostError;
  } finally {
    for (const client of clients) client.close();
    await fs.writeFile(`${ready}.step`, 'cleanup').catch(() => {});
    await fs.writeFile(`${ready}.continue`, 'cleanup').catch(() => {});
    await host;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
