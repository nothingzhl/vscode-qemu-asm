// Operate the actual VS Code paging and virtual/physical memory controls against live QEMU.
// The extension-host handshake independently records paused CPU and page-table evidence.
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
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu actual paging ui, '));
  const outputRoot = path.resolve(process.env.QEMU_ASM_PAGING_SCREENSHOT_DIRECTORY || path.join(extensionRoot, '..'));
  const root = path.join(temporary, 'workspace with spaces, and commas');
  const profile = path.join(temporary, 'profile');
  const ready = path.join(temporary, 'paging-ready.json');
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
        QEMU_ASM_HOST_PHASE: 'paging', QEMU_ASM_HOST_ROOT: root,
        QEMU_ASM_PAGING_UI_READY: ready, VSCODE_PORTABLE: path.join(temporary, 'portable')
      },
      launchArgs: [root, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions'),
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1800,1200']
    }).catch(error => { hostError = error; }).finally(() => { hostFinished = true; });
    const checkHost = () => {
      if (hostError) throw hostError;
      if (hostFinished) throw new Error('Paging host finished before the screenshot handshake');
    };
    const evidence = await until(async () => {
      checkHost();
      try { return JSON.parse(await fs.readFile(ready, 'utf8')); } catch { return false; }
    }, 'actual QEMU paged instruction/data breakpoint');
    assert(Number.isInteger(evidence.linearAddress) && Number.isInteger(evidence.physicalAddress), 'host must expose actual virtual/physical addresses');
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
    const currentFrame = await until(() => workbench.evaluate(`(() => {
      const row = [...document.querySelectorAll('.monaco-list-row')].find(item => item.textContent.includes('当前指令'));
      const r = row?.getBoundingClientRect(); return r && r.width && r.height ? { x:r.left + Math.min(80,r.width/2),y:r.top+r.height/2,label:row.textContent } : null;
    })()`), 'native current-instruction frame');
    await workbench.send('Input.dispatchMouseEvent', { type:'mousePressed', x:currentFrame.x,y:currentFrame.y,button:'left',buttons:1,clickCount:1 });
    await workbench.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:currentFrame.x,y:currentFrame.y,button:'left',buttons:0,clickCount:1 });
    const nativeRegisters = await until(() => workbench.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.monaco-list-row')].map(row => row.textContent.trim());
      return rows.some(row => row.startsWith('EIP') && row.includes(${JSON.stringify(hex(evidence.pc))})) ? rows : null;
    })()`), 'native EIP in paged code register scope');
    const pagingState = () => inspector.evaluate(inView(`({
      selected:d.getElementById('tab-paging').getAttribute('aria-selected'),
      stale:d.body.classList.contains('stale'),stopped:d.getElementById('status-dot').classList.contains('stopped'),
      address:d.getElementById('paging-address').value,disabled:d.getElementById('paging-go').disabled,
      status:d.getElementById('status').textContent,result:d.getElementById('paging-result').textContent,
      path:d.getElementById('paging-path').textContent,meta:d.getElementById('paging-meta').textContent,
      permissions:d.getElementById('paging-permissions').textContent,
      explanation:d.getElementById('paging-explanation').textContent,
      rows:[...d.querySelectorAll('#paging-body tr')].map(row=>({level:row.dataset.level,cells:[...row.cells].map(cell=>cell.textContent)}))
    })`));
    const jump = async address => {
      await inspector.evaluate(inView(`(() => {
        d.getElementById('tab-paging').click(); d.getElementById('paging-address').value=${JSON.stringify(hex(address))};
        d.getElementById('paging-form').requestSubmit(); return true;
      })()`));
      return until(async () => { const state = await pagingState(); return state?.selected === 'true' && state.stopped && !state.stale && !state.disabled && state.address === hex(address) ? state : null; }, `actual page walk ${hex(address)}`);
    };
    let paging = await jump(evidence.linearAddress);
    assert(paging.path.includes(hex(evidence.physicalAddress)), 'page walk must show actual mapped physical address');
    assert(paging.path.includes('CR3') && paging.path.includes('PDE') && paging.path.includes('PTE'));
    assert(paging.rows.length === 2 && paging.rows[0].level === 'directory' && paging.rows[1].level === 'table');
    assert(paging.result.includes('4 KiB')); assert(paging.permissions.includes('管理态写入 允许'));
    if (evidence.pdeAddress !== undefined) assert(paging.rows[0].cells.includes(hex(evidence.pdeAddress)));
    if (evidence.pteAddress !== undefined) assert(paging.rows[1].cells.includes(hex(evidence.pteAddress)));
    const memoryState = () => inspector.evaluate(inView(`({
      stale:d.body.classList.contains('stale'),space:d.getElementById('memory-space').value,
      follow:d.getElementById('follow').value,followDisabled:d.getElementById('follow').disabled,
      context:d.getElementById('memory-context').textContent,range:d.getElementById('memory-range').textContent,
      bytes:[...d.querySelectorAll('#memory-body tr:first-child td.byte')].map(cell=>cell.textContent),
      changed:d.querySelectorAll('#memory-body td.changed').length
    })`));
    const memory = async (address,space) => {
      await inspector.evaluate(inView(`(() => {
        d.getElementById('tab-memory').click(); const selector=d.getElementById('memory-space'); selector.value=${JSON.stringify(space)}; selector.dispatchEvent(new Event('change',{bubbles:true}));
        d.getElementById('address').value=${JSON.stringify(hex(address))};d.getElementById('address-form').requestSubmit();return true;
      })()`));
      return until(async()=>{ const state=await memoryState(); return !state?.stale && state.space===space && state.range.startsWith(hex(address)) ? state:null; },`actual ${space} memory ${hex(address)}`);
    };
    const virtualMemory=await memory(evidence.linearAddress,'virtual');
    assert(virtualMemory.context.includes(hex(evidence.cr3))); assert.equal(virtualMemory.bytes[0],(evidence.dataValue ?? 1).toString(16).toUpperCase().padStart(2,'0'));
    // Choosing physical memory must force fixed-address mode, even after a stack follow.
    await inspector.evaluate(inView(`(() => { const follow=d.getElementById('follow');follow.value='esp';follow.dispatchEvent(new Event('change',{bubbles:true}));return true; })()`));
    const physicalMemory=await memory(evidence.physicalAddress,'physical');
    assert.equal(physicalMemory.follow,'address');assert.equal(physicalMemory.followDisabled,true);
    assert.equal(physicalMemory.context,'物理地址');assert.deepEqual(physicalMemory.bytes,virtualMemory.bytes);assert.equal(physicalMemory.changed,0);
    const virtualAgain=await memory(evidence.linearAddress,'virtual');assert.equal(virtualAgain.followDisabled,false);assert.deepEqual(virtualAgain.bytes,virtualMemory.bytes);
    // A missing PTE has no physical result, and switching back restores the valid walk.
    const missing=await jump(evidence.unmappedAddress ?? 0xc0101000);
    assert(missing.result.includes('P=0') && !missing.path.includes('映射成功'));
    paging=await jump(evidence.linearAddress);
    const bounds=await workbench.evaluate(`(() => {const r=document.querySelector('.part.panel')?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,panel:r?{left:r.left,top:r.top,width:r.width,height:r.height}:null};})()`);
    assert(bounds.panel?.height >= 300);
    await workbench.evaluate(`(() => {for(const close of document.querySelectorAll('.notifications-toasts .codicon-close'))close.click();})()`);
    await new Promise(resolve=>setTimeout(resolve,300));
    const output=path.join(outputRoot,'qemu-asm-paging.png');await fs.mkdir(outputRoot,{recursive:true});
    const captured=await workbench.send('Page.captureScreenshot',{format:'png',fromSurface:true});await fs.writeFile(output,Buffer.from(captured.data,'base64'));
    await fs.writeFile(`${output}.json`,JSON.stringify({...evidence,capturedAt:new Date().toISOString(),screenshot:output,monitor:frame,bounds,currentFrame,nativeRegisters,paging,virtualMemory,physicalMemory,missing,
      sourceOfScreenshot:'Actual VS Code Electron workbench and real QEMU with CR0.PG set. Local CDP operates actual controls; extension host independently checks page walk, virtual and physical memory, stepping and watchpoint evidence. No mock, replaced data, or compositing.'},null,2));
    await fs.mkdir(path.join(extensionRoot,'docs','images'),{recursive:true});await fs.copyFile(output,path.join(extensionRoot,'docs','images','paging.png'));
    console.log(`PASS: actual paging inspector and virtual/physical memory controls verified; genuine screenshot ${output}`);
    await fs.writeFile(`${ready}.continue`,'actual paging UI and screenshot complete');
    for(const client of clients)client.close();clients.length=0;await host;if(hostError)throw hostError;
  } finally {
    for(const client of clients)client.close();await fs.writeFile(`${ready}.continue`,'cleanup').catch(()=>{});await host;
    await fs.rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
