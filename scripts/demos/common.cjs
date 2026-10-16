// Actual Electron/X11 recordings. Captions occupy a separate bar below the UI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(80); }
  throw new Error(`Timeout: ${description}`);
}
const inView = expression => `(() => { const d=document.getElementById('active-frame')?.contentDocument; if(!d)return null; return (${expression}); })()`;
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0; const requests = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  return {
    send(method, params = {}) { return new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    }); },
    async evaluate(expression) {
      const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    },
    close() { socket.close(); }
  };
}
function resizeWindow() {
  execFileSync('python3', ['-c', `import ctypes,ctypes.util
x=ctypes.CDLL(ctypes.util.find_library('X11'));P=ctypes.c_void_p;W=ctypes.c_ulong
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=P
x.XDefaultRootWindow.argtypes=[P];x.XDefaultRootWindow.restype=W
x.XQueryTree.argtypes=[P,W,ctypes.POINTER(W),ctypes.POINTER(W),ctypes.POINTER(ctypes.POINTER(W)),ctypes.POINTER(ctypes.c_uint)]
x.XFetchName.argtypes=[P,W,ctypes.POINTER(ctypes.c_char_p)]
class Hint(ctypes.Structure): _fields_=[('name',ctypes.c_char_p),('kind',ctypes.c_char_p)]
x.XGetClassHint.argtypes=[P,W,ctypes.POINTER(Hint)]
x.XMoveResizeWindow.argtypes=[P,W,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint]
x.XFlush.argtypes=[P];x.XCloseDisplay.argtypes=[P]
d=x.XOpenDisplay(None)
if not d: raise RuntimeError('No recording X11 display')
r,p,c,n=W(),W(),ctypes.POINTER(W)(),ctypes.c_uint()
x.XQueryTree(d,x.XDefaultRootWindow(d),ctypes.byref(r),ctypes.byref(p),ctypes.byref(c),ctypes.byref(n))
matched=0
for i in range(n.value):
 title=ctypes.c_char_p();hint=Hint();x.XFetchName(d,c[i],ctypes.byref(title));x.XGetClassHint(d,c[i],ctypes.byref(hint))
 if b'Extension Development Host' in (title.value or b'') or b'code' in (hint.kind or b'').lower():
  x.XMoveResizeWindow(d,c[i],0,0,1800,1200);matched+=1
if not matched: raise RuntimeError('Recording extension-development window not found')
x.XFlush(d);x.XCloseDisplay(d)
`]);
}
function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}
async function runDemo(options) {
  assert(/^[0-9]{2}-[a-z-]+$/.test(options.id));
  if (!process.env.DISPLAY) throw new Error("Use xvfb-run -a -s '-screen 0 1800x1200x24'");
  const repository = path.resolve(__dirname, '../..'), temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu-feature-demo-'));
  const root = path.join(temporary, 'workspace'), profile = path.join(temporary, 'profile'), ready = path.join(temporary, 'ready.json');
  const outputDirectory = path.resolve(process.env.QEMU_ASM_DEMO_OUTPUT || path.join(repository, 'docs/demos'));
  const output = path.join(outputDirectory, options.id), raw = path.join(temporary, 'recording.mkv');
  const port = await freePort(), clients = new Map(), actions = [], captions = [];
  let hostError, hostFinished = false, recorder, recordingFinished, clock, host, completed = false, capturedThisRun = false, requestSerial = 0;
  const checkHost = () => { if (hostError) throw hostError; if (hostFinished) throw new Error('Recording extension host ended early'); };
  const elapsed = () => clock === undefined ? 0 : (performance.now() - clock) / 1000;
  const context = {
    inView, evidence: undefined, workbench: undefined, inspector: undefined, monitor: undefined,
    mark(text) { captions.push({ time: elapsed(), text }); console.log(`SCENE ${options.id} ${elapsed().toFixed(1)}s ${text}`); },
    async hold(seconds) { if (seconds < 0 || seconds > 55) throw new Error('Hold must be 0..55 seconds'); await delay(seconds * 1000); checkHost(); },
    async rpc(action, args = {}) {
      const serial = ++requestSerial;
      await fs.writeFile(`${ready}.request`, JSON.stringify({ serial, action, args }));
      const response = await until(async () => {
        checkHost();
        let reply; try { reply = JSON.parse(await fs.readFile(`${ready}.reply`, 'utf8')); } catch { return false; }
        return reply.serial === serial ? reply : false;
      }, `host action ${action}`, 60000);
      if (response.error) throw new Error(response.error);
      actions.push({ time: elapsed(), action, args, result: response.result }); return response.result;
    },
    async refreshTargets() {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      for (const target of targets) {
        if (!(target.type === 'page' && /workbench/i.test(target.url)) && !(target.type === 'iframe' && /extensionId=nothingzhl\.vscode-qemu-asm/.test(target.url))) continue;
        let client = clients.get(target.id);
        if (!client) { client = await connect(target.webSocketDebuggerUrl); clients.set(target.id, client); }
        if (target.type === 'page') context.workbench = client;
        else {
          const kind = await client.evaluate(inView("d.getElementById('tab-memory')?'inspector':d.getElementById('frame')?'monitor':null"));
          if (kind) context[kind] = client;
        }
      }
      return context;
    },
    async click(client, selector, webview = false) {
      const expression = `(() => {const node=${webview ? 'd' : 'document'}.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing control '+${JSON.stringify(selector)});node.click();return true;})()`;
      return client.evaluate(webview ? inView(expression) : expression);
    },
    async setInput(client, selector, value, webview = false) {
      const expression = `(() => {const node=${webview ? 'd' : 'document'}.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing input');node.focus();node.value=${JSON.stringify(String(value))};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;
      return client.evaluate(webview ? inView(expression) : expression);
    },
    async mouse(client, point) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    },
    async layout() {
      const sash = await context.workbench.evaluate(`(() => {
        const panel=document.querySelector('.part.panel');if(!panel)return null;
        const p=panel.getBoundingClientRect();
        const r=[...document.querySelectorAll('.monaco-sash.horizontal')].map(e=>e.getBoundingClientRect()).find(r=>r.width>500&&Math.abs(r.top-p.top)<12);
        return r?{x:r.left+r.width/2,y:r.top+r.height/2,target:Math.round(innerHeight*.52)}:null;
      })()`);
      if (!sash) return;
      await context.workbench.send('Input.dispatchMouseEvent',{type:'mousePressed',x:sash.x,y:sash.y,button:'left',buttons:1,clickCount:1});
      for(let i=1;i<=8;i++)await context.workbench.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:sash.x,y:sash.y+(sash.target-sash.y)*i/8,button:'left',buttons:1});
      await context.workbench.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:sash.x,y:sash.target,button:'left',buttons:0,clickCount:1});
      await context.workbench.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1050,y:580});
    },
    async capture() {
      const image = await context.workbench.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await fs.writeFile(`${output}.png`, Buffer.from(image.data, 'base64')); capturedThisRun = true; return `${output}.png`;
    }
  };
  try {
    await Promise.all([fs.mkdir(root, { recursive: true }), fs.mkdir(path.join(profile, 'User'), { recursive: true }), fs.mkdir(outputDirectory, { recursive: true })]);
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
      'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.enableExperiments': false,
      'chat.disableAIFeatures': true, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
      'window.newWindowDimensions': 'maximized', 'window.zoomLevel': 0, 'editor.fontSize': 16,
      'workbench.colorTheme': 'Default Dark Modern', 'window.commandCenter': false,
      'workbench.panel.defaultLocation': 'bottom', 'debug.openDebug': 'openOnSessionStart',
      'debug.console.closeOnEnd': true, 'workbench.activityBar.location': 'default'
    }));
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    host = runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: repository,
      extensionTestsPath: path.resolve(options.host),
      extensionTestsEnv: { QEMU_ASM_DEMO_READY: ready, QEMU_ASM_DEMO_ROOT: root, QEMU_ASM_DEMO_ID: options.id, VSCODE_PORTABLE: path.join(temporary, 'portable') },
      launchArgs: [root, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions'),
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--window-size=1800,1200']
    }).catch(error => { hostError = error; }).finally(() => { hostFinished = true; });
    context.evidence = await until(async () => { checkHost(); try { return JSON.parse(await fs.readFile(ready, 'utf8')); } catch { return false; } }, 'recording guest ready');
    await until(async () => { checkHost(); await context.refreshTargets(); return context.workbench; }, 'recording workbench');
    resizeWindow();
    await until(() => context.workbench.evaluate('innerWidth>=1700&&innerHeight>=1100'), 'full-size real workbench');
    if (options.prepare) await options.prepare(context);
    await context.layout();
    await context.workbench.evaluate("(() => {for(const close of document.querySelectorAll('.notifications-toasts .codicon-close'))close.click();})()");
    recorder = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'warning', '-f', 'x11grab', '-draw_mouse', '1',
      '-video_size', '1800x1200', '-framerate', '12', '-i', `${process.env.DISPLAY}+0,0`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', '2', raw],
      { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
    let recorderError = '';
    recorder.stderr.on('data', chunk => { recorderError = (recorderError + chunk).slice(-12000); });
    recordingFinished = new Promise((resolve, reject) => { recorder.once('error', reject); recorder.once('close', code => code === 0 ? resolve() : reject(new Error(`Recording failed (${code}): ${recorderError}`))); });
    void recordingFinished.catch(() => undefined);
    await new Promise((resolve, reject) => { recorder.once('spawn', resolve); recorder.once('error', reject); });
    clock = performance.now(); context.mark(options.title); await context.hold(.5);
    await options.driver(context);
    if (!capturedThisRun) await context.capture();
    await context.hold(.5); const measured = elapsed();
    recorder.stdin.write('q\n'); await recordingFinished; recorder = undefined;
    await fs.writeFile(`${ready}.done`, 'recorded'); await host; if (hostError) throw hostError;
    const probe = JSON.parse((await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', raw])).stdout);
    const duration = Number(probe.format.duration); assert(duration > 5 && duration < 180);
    const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1440\nPlayResY: 1020\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans CJK SC,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,24,24,15,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + captions.map((caption, index) => `Dialogue: 0,${assTime(caption.time)},${assTime(captions[index + 1]?.time ?? duration)},Default,,0,0,0,,${caption.text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N')}\n`).join('');
    const subtitles = path.join(temporary, 'captions.ass'); await fs.writeFile(subtitles, ass);
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw,
      '-vf', `scale=1440:960:flags=lanczos,pad=1440:1020:0:0:black,ass=${subtitles}`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', '+faststart', '-an', `${output}.mp4`], { maxBuffer: 1024 * 1024 });
    const previewStart = Math.max(0, Math.min(options.previewStart ?? 0, duration - 6));
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(previewStart), '-t', '12', '-i', `${output}.mp4`,
      '-filter_complex', '[0:v]fps=5,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
      '-threads', '2', '-loop', '0', `${output}.gif`], { maxBuffer: 1024 * 1024 });
    const metadata = { title: options.title, id: options.id, capturedAt: new Date().toISOString(),
      productCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
      extensionVersion: context.evidence.extensionVersion, vscodeVersion: context.evidence.vscodeVersion,
      platform: process.platform, capture: { width: 1800, height: 1200, fps: 12, method: 'FFmpeg X11 grab of actual VS Code Electron window', measuredSeconds: measured },
      video: { width: 1440, height: 1020, codec: 'H.264', pixelFormat: 'yuv420p', audio: false, durationSeconds: duration },
      gif: { width: 960, fps: 5, previewStartSeconds: previewStart, previewSeconds: Math.min(12, duration - previewStart) },
      captions, actions, initialEvidence: context.evidence,
      recordingScript: path.relative(repository, options.script || process.argv[1]),
      provenance: 'Automated real VS Code controls, owned QEMU/GDB and live guest memory. Captions are added in a separate bottom bar. No replacement UI or fabricated debugger data.' };
    await fs.writeFile(`${output}.json`, JSON.stringify(metadata, null, 2) + '\n');
    completed = true; console.log(`RECORDED ${options.id}: ${duration.toFixed(1)} seconds, MP4/GIF/poster/JSON`);
    return metadata;
  } finally {
    if (recorder) { recorder.stdin.write('q\n'); await Promise.race([recordingFinished.catch(() => {}), delay(3000)]); if (recorder.exitCode === null) recorder.kill('SIGKILL'); }
    await fs.writeFile(`${ready}.done`, 'cleanup').catch(() => {});
    for (const client of clients.values()) client.close();
    if (host) await host;
    if (!completed) console.error(`Recording ${options.id} did not complete; temporary evidence: ${temporary}`);
    else await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
module.exports = { runDemo, until, inView, connect, freePort, resizeWindow };
