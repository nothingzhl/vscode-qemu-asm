const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { MiClient } = require('../dist/debug/mi');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function running(pid) {
 try {
  process.kill(pid, 0);
  // Orphans may briefly await reaping by the container's PID 1; a zombie is no
  // longer executing and cannot retain an active wrapper/worker.
  if (process.platform === 'linux' && /\) Z /.test(await fs.readFile(`/proc/${pid}/stat`, 'utf8'))) return false;
  return true;
 } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return false; throw error; }
}
async function untilStopped(pid) {
 for (let attempt = 0; attempt < 100; attempt++) { if (!await running(pid)) return; await delay(20); }
 assert.fail(`owned MI worker ${pid} is still running`);
}

async function wrapper(t, mode = 'ready') {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'MI owned group '));
 const pidFile = path.join(root, 'worker pid');
 const worker = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);`;
 const script = `
  const fs=require('node:fs'),{spawn}=require('node:child_process');
  const child=spawn(process.execPath,['-e',${JSON.stringify(worker)},process.argv[1]],{stdio:'ignore'});child.unref();
  const gate=setInterval(()=>{if(!fs.existsSync(process.argv[1]))return;clearInterval(gate);
   if(process.argv[2]==='no-prompt')return;
   process.stdout.write('(gdb)\\n');
  },5);
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
   const [,token,command]=/^(\\d+)(.*)$/.exec(line);
   process.stdout.write(token+'^done\\n');
   if(command==='-exit-wrapper')setTimeout(()=>process.exit(0),10);
  });
 `;
 let pid;
 t.after(async () => {
  try {
   pid ??= Number(await fs.readFile(pidFile, 'utf8'));
   if (pid && await running(pid)) { process.kill(pid, 'SIGKILL'); await untilStopped(pid); }
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  await fs.rm(root, { recursive: true, force: true });
 });
 return {
  root, pidFile,
  start: (signal, timeout = 1000) => MiClient.start(process.execPath, ['-e', script, pidFile, mode], root, timeout, signal),
  async workerPid() { pid = Number(await fs.readFile(pidFile, 'utf8')); assert(pid > 0); return pid; },
 };
}

test('owned MI wrapper disposal kills its SIGTERM-resistant descendant and preserves unrelated children', { skip: process.platform === 'win32' }, async t => {
 const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
 await once(foreign, 'spawn');
 t.after(async () => {
  if (foreign.exitCode === null && foreign.signalCode === null) { const closed = once(foreign, 'close'); foreign.kill('SIGKILL'); await closed; }
 });
 const fixture = await wrapper(t);
 const client = await fixture.start();
 t.after(() => client.dispose());
 assert.equal(client.executable, process.execPath);
 assert.equal((await client.command('-query')).class, 'done');
 const pid = await fixture.workerPid();
 assert.equal(await running(pid), true);
 const disposal = client.dispose(); assert.equal(client.dispose(), disposal); await disposal;
 await untilStopped(pid);
 assert.equal(await running(foreign.pid), true);
});

test('normal MI wrapper exit clears a detached worker that ignored stdio', { skip: process.platform === 'win32' }, async t => {
 const fixture = await wrapper(t);
 const client = await fixture.start();
 t.after(() => client.dispose());
 const pid = await fixture.workerPid();
 const terminated = once(client, 'terminated');
 await client.command('-exit-wrapper');
 await terminated;
 await untilStopped(pid);
});

test('MI startup timeout cleans the owned wrapper group before rejecting', { skip: process.platform === 'win32' }, async t => {
 const fixture = await wrapper(t, 'no-prompt');
 await assert.rejects(fixture.start(), /启动超时/);
 await untilStopped(await fixture.workerPid());
});

test('aborting MI startup immediately clears a real no-prompt wrapper and its resistant worker', { skip: process.platform === 'win32' }, async t => {
 const fixture = await wrapper(t, 'no-prompt');
 const controller = new AbortController();
 const starting = fixture.start(controller.signal, 15000);
 for (let attempt = 0; attempt < 100; attempt++) {
  try { await fs.access(fixture.pidFile); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await delay(20);
 }
 const pid = await fixture.workerPid();
 const failed = assert.rejects(starting, /启动已取消/);
 const cancelledAt = Date.now();
 controller.abort();
 await failed;
 await untilStopped(pid);
 assert(Date.now() - cancelledAt < 3000, 'cancellation waited for the 15-second startup timeout');
});

test('pre-aborted MI startup rejects before resolving or launching an executable', async () => {
 const controller = new AbortController(); controller.abort();
 await assert.rejects(MiClient.start('missing-tool-must-not-resolve', [], process.cwd(), 15000, controller.signal), /启动已取消/);
});

test('public MI constructor retains single-child termination without claiming its process group', async t => {
 const child = spawn(process.execPath, ['-e', "process.stdout.write('(gdb)\\n');setInterval(()=>{},1000);"], { stdio: ['pipe', 'pipe', 'pipe'] });
 const client = new MiClient(child, 1000);
 t.after(() => client.dispose());
 assert.equal(client.executable, undefined);
 await once(child, 'spawn');
 await client.dispose();
 assert(child.exitCode !== null || child.signalCode !== null);
});
