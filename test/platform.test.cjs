const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ChildProcess, spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { localHost } = require('../dist/platform/host');
const { Processes, execute } = require('../dist/platform/processes');

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform test '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('local host describes the extension execution process and native paths', () => {
  assert.deepEqual(localHost.identity, { platform: process.platform, arch: process.arch, release: os.release() });
  assert.equal(localHost.paths.resolve('a', '..', 'b'), path.resolve('b'));
  assert.equal(localHost.paths.delimiter, path.delimiter);
  assert.equal(localHost.env, process.env);
  assert.equal(localHost.spawn, spawn);
});

test('process launches use the injected host environment, resolved path and argument array', async t => {
  const root = await temporary(t);
  const env = { ...process.env, QEMU_ASM_PLATFORM_TEST: 'injected value' };
  const calls = [];
  const host = {
    ...localHost, env,
    spawn(command, args, options) { calls.push({ command, args, options }); return spawn(command, args, options); },
  };
  const runner = new Processes(host);
  t.after(() => runner.dispose());
  let output = '';
  const argument = 'literal argument; $HOME $(must-not-run) & |';
  const run = runner.start(process.execPath, ['-e', 'console.log(JSON.stringify([process.argv[1],process.env.QEMU_ASM_PLATFORM_TEST,process.cwd()]))', argument], root, text => { output += text; });
  await run.ready;
  await run.done;
  assert.deepEqual(JSON.parse(output), [argument, 'injected value', root]);
  assert.equal(run.tool.status, 'resolved');
  assert.equal(calls[0].command, run.tool.executable);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, host.identity.platform !== 'win32');
});

test('missing tool fails with ENOENT before spawn and leaves the manager reusable', async t => {
  const root = await temporary(t);
  let calls = 0;
  const host = { ...localHost, env: { ...process.env, PATH: '' }, spawn(...args) { calls++; return spawn(...args); } };
  const runner = new Processes(host);
  t.after(() => runner.dispose());
  assert.throws(() => runner.start('qemu-asm-definitely-missing', [], root, () => {}), error => error.code === 'ENOENT');
  await assert.rejects(execute(runner, path.join(root, 'missing binary'), [], root, () => {}), error => error.code === 'ENOENT');
  assert.equal(calls, 0);
  await execute(runner, process.execPath, ['-e', ''], root, () => {});
  assert.equal(calls, 1);
});

test('process ownership gates termination before and after close', async t => {
  const root = await temporary(t);
  const child = new ChildProcess();
  child.pid = 12345;
  const signals = [];
  const host = {
    ...localHost,
    spawn() { queueMicrotask(() => child.emit('spawn')); return child; },
    terminateProcessTree(target, signal) { signals.push({ target, signal }); },
  };
  const runner = new Processes(host);
  let closed = false;
  child.once('close', () => { closed = true; });
  t.after(async () => {
    if (!closed) child.emit('close', 0, null);
    await runner.dispose();
  });
  const run = runner.start(process.execPath, [], root, () => {});
  await run.ready;
  runner.terminate({ pid: 99999 }, 'SIGKILL');
  assert.equal(signals.length, 0);
  runner.terminate(child, 'SIGTERM');
  assert.deepEqual(signals, [{ target: child, signal: 'SIGTERM' }]);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await run.done;
  assert.equal(signals.length, 2);
  assert.equal(signals[1].signal, 'SIGKILL');
  runner.terminate(child, 'SIGKILL');
  await runner.stop();
  assert.equal(signals.length, 2);
  await runner.dispose();
  assert.throws(() => runner.start(process.execPath, [], root, () => {}), /退出/);
});

test('pre-cancelled execution does not resolve or launch a tool', async t => {
  const root = await temporary(t);
  const runner = new Processes({ ...localHost, spawn() { assert.fail('cancelled execution launched a process'); } });
  t.after(() => runner.dispose());
  await assert.rejects(execute(runner, 'missing', [], root, () => {}, 1000, () => true), /已停止/);
});

test('live cancellation kills the owned group and preserves an unrelated process', async t => {
  const root = await temporary(t);
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(foreign, 'spawn');
  t.after(async () => {
    if (foreign.exitCode === null && foreign.signalCode === null) {
      const closed = once(foreign, 'close');
      foreign.kill('SIGKILL');
      await closed;
    }
  });
  const owned = [];
  const host = { ...localHost, spawn(...args) { const child = spawn(...args); owned.push(child); return child; } };
  const runner = new Processes(host);
  t.after(() => runner.dispose());
  let cancelled = false;
  await assert.rejects(execute(runner, process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], root, () => { cancelled = true; }, 3000, () => cancelled), /已停止/);
  assert(owned[0].exitCode !== null || owned[0].signalCode !== null);
  assert.equal(foreign.exitCode, null);
  assert.equal(foreign.signalCode, null);
  process.kill(foreign.pid, 0);
});

test('timeout retains its cause after the owned process has been killed', async t => {
  const root = await temporary(t);
  const runner = new Processes();
  t.after(() => runner.dispose());
  await assert.rejects(execute(runner, process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, () => {}, 60), /执行超时/);
  await runner.stop();
});

test('POSIX leader exit cleans an owned descendant even with ignored stdio', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  const marker = path.join(root, 'descendant heartbeat');
  const pidFile = path.join(root, 'descendant pid');
  let descendantPid;
  const runner = new Processes();
  t.after(() => runner.dispose());
  t.after(async () => {
    if (descendantPid === undefined) return;
    try { process.kill(descendantPid, 'SIGKILL'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  });
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'.'),20)`;
  const parent = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);console.log(fs.readFileSync(${JSON.stringify(pidFile)},'utf8'));process.exit(0)}},10)`;
  await execute(runner, process.execPath, ['-e', parent], root, text => { const pid = Number(text.trim()); if (Number.isSafeInteger(pid) && pid > 0) descendantPid = pid; }, 3000);
  await delay(80);
  const before = await fs.readFile(marker, 'utf8');
  await delay(120);
  assert.equal(await fs.readFile(marker, 'utf8'), before, 'descendant continued after its owned leader exited');
});

test('simulated Windows contract uses taskkill without a shell and falls back on failure', () => {
  const killer = new EventEmitter();
  const calls = [];
  const signals = [];
  const child = { pid: 43210, kill(signal) { signals.push(signal); } };
  const host = {
    ...localHost,
    identity: { ...localHost.identity, platform: 'win32' },
    paths: path.win32,
    spawn(command, args, options) { calls.push({ command, args, options }); return killer; },
  };
  host.terminateProcessTree(child, 'SIGTERM');
  assert.deepEqual(calls[0].args, ['/PID', '43210', '/T', '/F']);
  assert.equal(calls[0].command, 'taskkill');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env, host.env);
  killer.emit('exit', 1);
  assert.deepEqual(signals, ['SIGTERM']);
  host.terminateProcessTree({}, 'SIGKILL');
  assert.equal(calls.length, 1);
});
