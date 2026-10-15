// Operate actual VS Code disassembly and data-breakpoint controls against live QEMU.
// Every edit is independently checked by the extension host through native DAP.
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
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu actual machine ui, '));
  const outputRoot = path.resolve(process.env.QEMU_ASM_MACHINE_SCREENSHOT_DIRECTORY || path.join(extensionRoot, '..'));
  const root = path.join(temporary, 'workspace with spaces, and commas');
  const profile = path.join(temporary, 'profile');
  const ready = path.join(temporary, 'machine-ready.json');
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
        QEMU_ASM_HOST_PHASE: 'machine', QEMU_ASM_HOST_ROOT: root,
        QEMU_ASM_MACHINE_UI_READY: ready, VSCODE_PORTABLE: path.join(temporary, 'portable')
      },
      launchArgs: [root, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions'),
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1800,1200']
    }).catch(error => { hostError = error; }).finally(() => { hostFinished = true; });
    const checkHost = () => {
      if (hostError) throw hostError;
      if (hostFinished) throw new Error('Machine host finished before the screenshot handshake');
    };
    const evidence = await until(async () => {
      checkHost();
      try { return JSON.parse(await fs.readFile(ready, 'utf8')); } catch { return false; }
    }, 'actual QEMU instruction/data breakpoint');
    assert(Number.isInteger(evidence.dataAddress) && Number.isInteger(evidence.codeAddress), 'host must expose actual guest code/data addresses');
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
    // Select the real native call-stack frame. Raw DAP integration requests do
    // not select a VS Code frame, so variable scopes need this user action.
    const currentFrame = await until(() => workbench.evaluate(`(() => {
      const row = [...document.querySelectorAll('.monaco-list-row')].find(item => item.textContent.includes('当前指令'));
      const r = row?.getBoundingClientRect();
      return r && r.width && r.height ? { x: r.left + Math.min(80, r.width / 2), y: r.top + r.height / 2, label: row.textContent } : null;
    })()`), 'native unmapped-current-instruction call-stack row');
    await workbench.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: currentFrame.x, y: currentFrame.y, button: 'left', buttons: 1, clickCount: 1 });
    await workbench.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: currentFrame.x, y: currentFrame.y, button: 'left', buttons: 0, clickCount: 1 });
    const nativeRegisters = await until(() => workbench.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.monaco-list-row')].map(row => row.textContent.trim());
      return rows.some(row => row.startsWith('EAX') && row.includes('0x00000004'))
        && rows.some(row => row.startsWith('EIP') && row.includes(${JSON.stringify(hex(evidence.pc))}))
        ? { text: rows.join(' | '), rows } : null;
    })()`), 'native register scope and EAX=4 at the source-independent stopped frame', 20000);
    console.log(`PASS: actual native call-stack selection exposes original register scopes at an unmapped PC: ${JSON.stringify(nativeRegisters.rows)}`);
    const disassemblyState = () => inspector.evaluate(inView(`({
      selected: d.getElementById('tab-disassembly').getAttribute('aria-selected'),
      status: d.getElementById('status').textContent,
      stopped: d.getElementById('status-dot').classList.contains('stopped'),
      stale: d.body.classList.contains('stale'),
      address: d.getElementById('disassembly-address').value,
      following: d.getElementById('disassembly-follow').checked,
      meta: d.getElementById('disassembly-meta').textContent,
      goDisabled: d.getElementById('disassembly-go').disabled,
      rows: [...d.querySelectorAll('#disassembly-body tr')].map(row => ({
        address: Number(row.dataset.address), bytes: row.cells[2].textContent, text: row.cells[3].textContent,
        current: row.classList.contains('current-pc'), breakpoint: row.querySelector('button').textContent,
        disabled: row.querySelector('button').disabled, title: row.querySelector('button').title
      }))
    })`));
    const watchpointState = () => inspector.evaluate(inView(`({
      selected: d.getElementById('tab-watchpoints').getAttribute('aria-selected'),
      status: d.getElementById('status').textContent,
      stopped: d.getElementById('status-dot').classList.contains('stopped'),
      stale: d.body.classList.contains('stale'),
      addDisabled: d.getElementById('watchpoint-add').disabled,
      hit: d.getElementById('watchpoint-hit').hidden ? '' : d.getElementById('watchpoint-hit').textContent,
      sizeHeight: d.getElementById('watchpoint-size').getBoundingClientRect().height,
      accessHeight: d.getElementById('watchpoint-access').getBoundingClientRect().height,
      rows: [...d.querySelectorAll('#watchpoint-body tr[data-id]')].map(row => ({
        id: Number(row.dataset.id), address: Number(row.dataset.address),
        cells: [...row.cells].map(cell => cell.textContent), hit: row.classList.contains('watchpoint-hit'),
        removeDisabled: row.querySelector('button').disabled
      }))
    })`));
    let probeSerial = 0;
    const probe = async () => {
      const serial = ++probeSerial;
      await fs.writeFile(`${ready}.probe`, JSON.stringify({ serial }));
      return until(async () => {
        checkHost();
        try { const result = JSON.parse(await fs.readFile(`${ready}.probe-result`, 'utf8')); return result.serial === serial ? result : null; }
        catch { return false; }
      }, 'independent extension-host DAP breakpoint list');
    };
    const jump = async address => {
      await inspector.evaluate(inView(`(() => {
        d.getElementById('tab-disassembly').click();
        d.getElementById('disassembly-address').value = ${JSON.stringify(hex(address))};
        d.getElementById('disassembly-form').requestSubmit();
        return true;
      })()`));
      return until(async () => {
        const state = await disassemblyState();
        return state?.selected === 'true' && state.stopped && !state.stale && !state.goDisabled && state.rows[0]?.address === address ? state : null;
      }, `actual disassembly jump to ${hex(address)}`);
    };
    await until(async () => {
      const state = await disassemblyState(); return state?.stopped && !state.stale && !state.goDisabled;
    }, 'actual paused disassembly controls');
    const jumped = await jump(evidence.codeAddress + 4);
    assert.match(jumped.rows[0].text, /mov\s+eax/i); assert.equal(jumped.following, false);
    let disassembly = await jump(evidence.codeAddress);
    assert.equal(disassembly.rows[0].bytes.replace(/\s/g, '').toLowerCase(), '66b83412');
    assert.match(disassembly.rows[0].text, /mov\s+ax/i); assert(disassembly.meta.includes('32 位'));
    assert(disassembly.rows.some(row => row.current && row.address === evidence.pc), 'actual stopped EIP needs a current-instruction marker');
    const baseline = await probe();
    const instructionAddress = evidence.codeAddress + 4;
    assert(!baseline.instructionBreakpoints.breakpoints.some(item => item.address === instructionAddress));
    const toggleInstruction = () => inspector.evaluate(inView(`(() => {
      const button = d.querySelector('#disassembly-body tr[data-address="${instructionAddress}"] button');
      if (!button || button.disabled) return false;
      button.click(); return true;
    })()`));
    assert.equal(await toggleInstruction(), true);
    disassembly = await until(async () => {
      const state = await disassemblyState(); const row = state?.rows.find(item => item.address === instructionAddress);
      return state?.stopped && !state.stale && row?.breakpoint === '●' && !row.disabled ? state : null;
    }, 'actual address breakpoint added through its webview row');
    const instructionAdded = await probe();
    assert(instructionAdded.instructionBreakpoints.breakpoints.some(item => item.address === instructionAddress && item.origin === 'custom' && item.verified));
    const bounds = await workbench.evaluate(`(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      panel: (() => { const r = document.querySelector('.part.panel')?.getBoundingClientRect(); return r ? { left:r.left,top:r.top,width:r.width,height:r.height } : null; })()
    }))()`);
    assert(bounds.panel?.height >= 300, 'actual bottom panel must have readable space');
    const source = await workbench.evaluate('document.body.innerText'); assert(/stage2\.asm/.test(source));
    const capture = async (tab, snapshot, backend) => {
      await workbench.evaluate(`(() => { for (const close of document.querySelectorAll('.notifications-toasts .codicon-close')) close.click(); })()`);
      await new Promise(resolve => setTimeout(resolve, 250));
      const output = path.join(outputRoot, `qemu-asm-machine-${tab}.png`);
      await fs.mkdir(outputRoot, { recursive: true });
      const result = await workbench.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await fs.writeFile(output, Buffer.from(result.data, 'base64'));
      await fs.writeFile(`${output}.json`, JSON.stringify({
        ...evidence, tab, screenshot: output, monitor: frame, bounds, currentFrame, nativeRegisters, snapshot, backend,
        sourceOfScreenshot: 'Actual VS Code Electron workbench and real QEMU. Controls operated through local CDP; native DAP independently confirms every breakpoint edit. No mock, replaced data, or compositing.'
      }, null, 2));
      console.log(`PASS: actual live machine-debug ${tab} screenshot: ${output}`);
    };
    await capture('disassembly', disassembly, instructionAdded);
    assert.equal(await toggleInstruction(), true);
    await until(async () => {
      const state = await disassemblyState(); const row = state?.rows.find(item => item.address === instructionAddress);
      return !state?.stale && row?.breakpoint === '○' && !row.disabled;
    }, 'actual address breakpoint removed through its row');
    const instructionRemoved = await probe();
    assert(!instructionRemoved.instructionBreakpoints.breakpoints.some(item => item.address === instructionAddress));
    await inspector.evaluate(inView(`(() => { d.getElementById('tab-watchpoints').click(); return true; })()`));
    let watchpoints = await until(async () => {
      const state = await watchpointState();
      return state?.selected === 'true' && state.stopped && !state.stale && !state.addDisabled && state.hit.includes(hex(evidence.dataAddress)) ? state : null;
    }, 'actual data-breakpoint hit and edit controls');
    assert(watchpoints.rows.some(item => item.address === evidence.dataAddress && item.hit));
    assert(watchpoints.sizeHeight >= 28 && watchpoints.accessHeight >= 28, 'actual selectors must leave enough height for readable text');
    const dataAddress = evidence.dataAddress + 8;
    assert(!baseline.watchpoints.breakpoints.some(item => item.address === dataAddress));
    await inspector.evaluate(inView(`(() => {
      d.getElementById('watchpoint-address').value = ${JSON.stringify(hex(dataAddress))};
      d.getElementById('watchpoint-size').value = '4';
      d.getElementById('watchpoint-access').value = 'write';
      d.getElementById('watchpoint-form').requestSubmit();
      return true;
    })()`));
    watchpoints = await until(async () => {
      const state = await watchpointState();
      return !state?.stale && !state?.addDisabled && state.rows.some(item => item.address === dataAddress && !item.removeDisabled) ? state : null;
    }, 'actual data breakpoint added from the form');
    const watchAdded = await probe();
    const added = watchAdded.watchpoints.breakpoints.find(item => item.address === dataAddress);
    assert(added?.verified && added.origin === 'custom'); assert.equal(added.access, 'write'); assert.equal(added.size, 4);
    assert.equal(watchAdded.watchpoints.lastHit.address, evidence.dataAddress);
    await capture('watchpoints', watchpoints, watchAdded);
    assert.equal(await inspector.evaluate(inView(`(() => {
      const button = d.querySelector('#watchpoint-body tr[data-id="${added.id}"] button');
      if (!button || button.disabled) return false; button.click(); return true;
    })()`)), true);
    await until(async () => {
      const state = await watchpointState(); return !state?.stale && !state?.addDisabled && !state.rows.some(item => item.address === dataAddress);
    }, 'actual data breakpoint removed with its row control');
    const watchRemoved = await probe();
    assert.deepEqual(watchRemoved.watchpoints.breakpoints, baseline.watchpoints.breakpoints, 'UI operations must retain the original watchpoint');
    assert.deepEqual(watchRemoved.instructionBreakpoints.breakpoints, baseline.instructionBreakpoints.breakpoints);
    assert.equal(watchRemoved.watchpoints.lastHit.pc, evidence.pc);
    console.log('PASS: actual webview address jump, instruction breakpoint toggle, data breakpoint add/remove, native DAP list verification and real watchpoint hit all agree');
    // Leave the original instruction view active for restart/new-session checks.
    await inspector.evaluate(inView(`(() => {
      d.getElementById('tab-disassembly').click();
      const follow = d.getElementById('disassembly-follow'); follow.checked = true; follow.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })()`));
    await until(async () => { const state = await disassemblyState(); return state?.selected === 'true' && state.stopped && !state.stale && state.following && state.rows[0]?.address === evidence.pc; }, 'follow-PC disassembly view restored before restarting to real16');
    await fs.writeFile(`${ready}.continue`, 'actual machine debugger UI actions and two genuine screenshots complete');
    for (const client of clients) client.close(); clients.length = 0;
    await host;
    if (hostError) throw hostError;
  } finally {
    for (const client of clients) client.close();
    await fs.writeFile(`${ready}.continue`, 'cleanup').catch(() => {});
    await host;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
