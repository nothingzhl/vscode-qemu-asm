const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { qemuArguments, qemuMachineArguments, qemuLaunchConfiguration, formatQemuLaunchConfiguration } = require('../dist/backends/qemu/arguments');
const { qemuCpuModels, validateProfileCpu } = require('../dist/backends/qemu/cpuModels');
const { QemuVirtualMachine } = require('../dist/backends/qemu/virtualMachine');
const { QemuRspBackend } = require('../dist/backends/qemu/rspBackend');
const { QemuGdbBackend } = require('../dist/backends/gdb/qemuBackend');
const { checkEnvironment, formatEnvironmentReport } = require('../dist/dependencies/doctor');
const { Processes } = require('../dist/platform/processes');
const { localHost } = require('../dist/platform/host');

function project(overrides = {}) {
  return {
    workspace: process.cwd(), root: process.cwd(), source: 'boot.asm', image: 'image,with comma.img',
    stages: [], nasm: 'nasm', qemu: 'qemu-system-i386', qemuArgs: [], ...overrides
  };
}
function profile(settings, source = 'default') { return { name: 'test profile', source, settings }; }
function boundary(help = 'Available CPUs:\n  qemu32  QEMU Virtual CPU\n  486-v1\n\nRecognized CPUID flags:\n') {
  const calls = [];
  let disposed = 0;
  return {
    host: localHost,
    calls,
    get disposed() { return disposed; },
    start(command, args, cwd, log) {
      calls.push({ command, args: [...args], cwd });
      const probe = args[0] === '-cpu' && args[1] === 'help';
      if (probe) log(help);
      return { child: {}, ready: Promise.resolve(), done: probe ? Promise.resolve() : new Promise(() => {}), tool: { executable: command } };
    },
    async dispose() { disposed++; }
  };
}

test('legacy machine arguments retain order, duplicates and caller isolation', () => {
  const config = project({ qemuArgs: ['-m', '16M', '-cpu', 'qemu32,+sse', '-m', '32M', '-smp', '2'] });
  const args = qemuMachineArguments(config);
  assert.deepEqual(args, config.qemuArgs);
  args[1] = '128M';
  assert.equal(config.qemuArgs[1], '16M');
  const full = qemuArguments(config, { identity: { platform: 'linux' }, paths: path.posix });
  assert.equal(full[full.indexOf('-drive') + 1], 'file=image,,with comma.img,format=raw,if=floppy,readonly=on');
  assert.deepEqual(full.slice(-8), config.qemuArgs);
});

test('Windows drive arguments use the project cwd, escape commas and preserve cross-drive paths', () => {
  const host = { identity: { platform: 'win32' }, paths: path.win32 };
  const root = 'C:\\Users\\开发者\\project with spaces';
  for (const [image, expected] of [
    [path.win32.join(root, '-boot, image.img'), '.\\-boot,, image.img'],
    ['build\\boot.img', '.\\build\\boot.img'],
    ['D:\\images\\boot, image.img', 'D:\\images\\boot,, image.img'],
    ['\\\\server\\share\\boot.img', '\\\\server\\share\\boot.img']
  ]) {
    const args = qemuArguments(project({ root, image }), host);
    assert.equal(args[args.indexOf('-drive') + 1], `file=${expected},format=raw,if=floppy,readonly=on`);
  }
});

test('the VM generates image arguments for its injected process host and matching working directory', async t => {
  const processes = boundary();
  processes.host = { identity: { platform: 'win32' }, paths: path.win32 };
  const config = project({ root: 'C:\\中文 project', image: 'C:\\中文 project\\build\\boot, disk.img' });
  const machine = new QemuVirtualMachine(config, processes, () => {});
  t.after(() => machine.dispose());
  await machine.start();
  const call = processes.calls[0];
  assert.equal(call.cwd, config.root);
  assert.equal(call.args[call.args.indexOf('-drive') + 1], 'file=.\\build\\boot,, disk.img,format=raw,if=floppy,readonly=on');
  assert.equal(processes.calls.length, 1);
});

test('profile overrides remove every matching legacy option and preserve untouched resource pairs', () => {
  const config = project({
    qemuArgs: ['-m', '16M', '-cpu', 'old', '-smp', '1', '-m', '32M', '-cpu', 'old2'],
    machineProfile: profile({ memoryMiB: 64, cpuModel: 'qemu32' })
  });
  assert.deepEqual(qemuMachineArguments(config), ['-smp', '1', '-m', '64M', '-cpu', 'qemu32']);
  config.machineProfile.settings = { memoryMiB: 128 };
  assert.deepEqual(qemuMachineArguments(config), ['-cpu', 'old', '-smp', '1', '-cpu', 'old2', '-m', '128M']);
  config.machineProfile.settings = {};
  assert.deepEqual(qemuMachineArguments(config), config.qemuArgs);
});

test('launch diagnostics retain provenance, unresolved QEMU defaults and detached snapshots', () => {
  const config = project({ qemuArgs: ['-m', '16M', '-m', '32M'] });
  assert.deepEqual(qemuLaunchConfiguration(config), {
    memory: { value: '32M', source: 'qemuArgs' }, cpu: { value: null, source: 'qemu-default' },
    display: { value: 'auto', source: 'default' }, arguments: config.qemuArgs
  });
  config.displayMode = 'off';
  assert.deepEqual(qemuLaunchConfiguration(config).display, { value: 'off', source: 'workspace' });
  config.machineProfile = profile({ cpuModel: '486', display: true }, 'launch');
  const report = qemuLaunchConfiguration(config);
  assert.deepEqual(report.profile, { name: 'test profile', source: 'launch' });
  assert.deepEqual(report.cpu, { value: '486', source: 'profile' });
  assert.deepEqual(report.display, { value: 'auto', source: 'profile' });
  report.profile.name = 'mutated'; report.arguments[1] = '999M'; report.cpu.value = 'other';
  assert.equal(config.machineProfile.name, 'test profile');
  assert.equal(qemuLaunchConfiguration(config).memory.value, '32M');
  assert.match(formatQemuLaunchConfiguration(qemuLaunchConfiguration(config)), /launch\.json 指定/);
  assert.match(formatQemuLaunchConfiguration(qemuLaunchConfiguration(project())), /QEMU 默认（未查询）/);
});

test('both backend capability scopes bind the effective machine options and isolate later mutations', async t => {
  const config = project({ qemuArgs: ['-m', '32M'], machineProfile: profile({ memoryMiB: 64 }) });
  const machine = { async dispose() {}, async start() { throw new Error('not needed'); } };
  const backends = [new QemuRspBackend(config, machine), new QemuGdbBackend(config, () => {}, machine)];
  t.after(() => Promise.all(backends.map(backend => backend.dispose())));
  for (const backend of backends) assert.deepEqual(backend.capabilities.snapshot().scope.machine, ['-m', '64M']);
  config.machineProfile.settings.memoryMiB = 256;
  config.qemuArgs[1] = '512M';
  const snapshot = backends[0].capabilities.snapshot(); snapshot.scope.machine[1] = '1M';
  for (const backend of backends) assert.deepEqual(backend.capabilities.snapshot().scope.machine, ['-m', '64M']);
});

test('CPU model parsing accepts older x86-column and newer direct-list help formats', () => {
  assert.deepEqual([...qemuCpuModels('Available CPUs:\r\nx86 qemu32 QEMU Virtual CPU\r\nx86 486 (alias)\r\n\r\nRecognized CPUID flags:\r\nxsave')], ['qemu32', '486']);
  assert.deepEqual([...qemuCpuModels('Available CPUs:\n  486-v1\n  qemu32  QEMU CPU\n\nRecognized CPUID flags:\n foo bar')], ['486-v1', 'qemu32']);
  assert.equal(qemuCpuModels('Unexpected executable output: qemu32').size, 0);
});

test('old and memory-only launch configurations create exactly one owned process', async t => {
  for (const machineProfile of [undefined, profile({ memoryMiB: 16, display: false })]) {
    const processes = boundary();
    const machine = new QemuVirtualMachine(project({ machineProfile }), processes, () => {});
    t.after(() => machine.dispose());
    await machine.start();
    assert.equal(processes.calls.length, 1);
    assert.equal(processes.calls[0].args.includes('help'), false);
  }
});

test('explicit CPU profiles query the same tool and working directory before the guest starts', async t => {
  const processes = boundary();
  const config = project({ root: '/project with spaces', qemu: '/tools with spaces/qemu', machineProfile: profile({ cpuModel: 'qemu32', memoryMiB: 64 }) });
  const logs = [];
  const machine = new QemuVirtualMachine(config, processes, text => logs.push(text));
  t.after(() => machine.dispose());
  const run = await machine.start({ debug: true, paused: true });
  assert.equal(processes.calls.length, 2);
  assert.deepEqual(processes.calls[0], { command: config.qemu, args: ['-cpu', 'help'], cwd: config.root });
  assert(processes.calls[1].args.includes('-S'));
  assert(processes.calls[1].args.includes('-gdb'));
  const memory = processes.calls[1].args.indexOf('-m');
  assert.deepEqual(processes.calls[1].args.slice(memory, memory + 4), ['-m', '64M', '-cpu', 'qemu32']);
  assert.match(logs.join(''), /启动方案：test profile/);
  assert.match(logs.join(''), /有效机器参数：\["-m","64M","-cpu","qemu32"\]/);
  assert.equal(run.executable, config.qemu);
  assert.equal(run.debugEndpoint.host, '127.0.0.1');
  await assert.rejects(machine.start(), /重复启动/);
});

test('single-CPU debugging restrictions remain in force while ordinary runs retain SMP', async t => {
  const config = project({ qemuArgs: ['-smp', '2'], machineProfile: profile({ cpuModel: 'qemu32' }) });
  const failed = boundary();
  const debug = new QemuVirtualMachine(config, failed, () => {});
  t.after(() => debug.dispose());
  await assert.rejects(debug.start({ debug: true }), /仅支持单 CPU/);
  assert.equal(failed.calls.length, 0);
  const running = boundary();
  const machine = new QemuVirtualMachine(config, running, () => {});
  t.after(() => machine.dispose());
  await machine.start();
  assert.deepEqual(running.calls[1].args.slice(-4), ['-smp', '2', '-cpu', 'qemu32']);
});

test('unsupported or unrecognized CPU models fail before allocating a guest process', async t => {
  for (const [help, reason] of [
    ['Available CPUs:\n  486-v1\n', /test profile.*qemu32.*-cpu help/],
    ['not QEMU output', /无法识别.*CPU/],
    ['Available CPUs:\n  qemu32\n' + 'x'.repeat(70000), /超过 64 KiB/]
  ]) {
    const processes = boundary(help);
    const machine = new QemuVirtualMachine(project({ machineProfile: profile({ cpuModel: 'qemu32' }) }), processes, () => {});
    t.after(() => machine.dispose());
    await assert.rejects(machine.start(), reason);
    assert.equal(processes.calls.length, 1);
  }
});

async function executableFixture(t, body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile CPU probe '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, 'qemu with spaces.exe');
  await fs.writeFile(command, body, { mode: 0o755 });
  const children = [];
  const calls = [];
  const host = {
    ...localHost,
    // Native process-tree cleanup must not be interpreted as another Node fixture.
    terminateProcessTree: localHost.terminateProcessTree.bind(localHost),
    spawn(command, args, options) {
      calls.push([...args]);
      const child = spawn(process.execPath, [command, ...args], options);
      children.push(child);
      return child;
    }
  };
  const processes = new Processes(host);
  t.after(() => processes.dispose());
  return { processes, children, calls, project: project({ root, qemu: command, nasm: command, machineProfile: profile({ cpuModel: 'qemu32' }) }) };
}

test('CPU probe failures preserve actual execution errors and do not start a guest', async t => {
  const f = await executableFixture(t, 'process.exit(7)');
  const machine = new QemuVirtualMachine(f.project, f.processes, () => {});
  t.after(() => machine.dispose());
  await assert.rejects(machine.start(), /无法查询 QEMU CPU 型号.*退出码 7/);
  assert.deepEqual(f.calls, [['-cpu', 'help']]);
  assert.notEqual(f.children[0].exitCode, null);
});

test('CPU probe timeout waits for owned process exit without launching a guest', async t => {
  const f = await executableFixture(t, 'setInterval(() => {}, 1000)');
  await assert.rejects(validateProfileCpu(f.project, f.processes, () => false, 100), /无法查询 QEMU CPU 型号.*超时/);
  assert.equal(f.calls.length, 1);
  assert(f.children[0].signalCode || f.children[0].exitCode !== null);
});

test('pre-cancelled CPU validation starts no process and disposed machines cannot be started', async () => {
  const processes = boundary();
  const config = project({ machineProfile: profile({ cpuModel: 'qemu32' }) });
  await assert.rejects(validateProfileCpu(config, processes, () => true), /虚拟机启动已取消/);
  assert.equal(processes.calls.length, 0);
  const machine = new QemuVirtualMachine(config, processes, () => {});
  await machine.dispose();
  await assert.rejects(machine.start(), /释放后启动/);
  assert.equal(processes.calls.length, 0);
});

test('disposing during a CPU probe cancels startup and waits for owned cleanup', async t => {
  const f = await executableFixture(t, 'setInterval(() => {}, 1000)');
  const machine = new QemuVirtualMachine(f.project, f.processes, () => {});
  const started = machine.start();
  const rejected = assert.rejects(started, /虚拟机启动已取消/);
  await new Promise(resolve => f.children[0].once('spawn', resolve));
  await machine.dispose();
  await rejected;
  assert.equal(f.calls.length, 1);
  assert(f.children[0].signalCode || f.children[0].exitCode !== null);
  await assert.rejects(machine.start(), /释放后启动/);
});

test('basic dependency checks expose effective launch diagnostics without probing CPUs or claiming defaults', async t => {
  const f = await executableFixture(t, 'console.log(process.argv.includes("-v") ? "NASM version 2.16.03" : "QEMU emulator version 10.0.13")');
  f.project.qemuArgs = ['-m', '16M'];
  f.project.machineProfile = profile({ memoryMiB: 64, display: false }, 'selected');
  const report = await checkEnvironment(f.project, f.processes);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.launchConfiguration.memory, { value: '64M', source: 'profile' });
  assert.deepEqual(report.launchConfiguration.cpu, { value: null, source: 'qemu-default' });
  assert.deepEqual(report.launchConfiguration.display, { value: 'off', source: 'profile' });
  assert.deepEqual(report.capabilities.scope.machine, ['-m', '64M']);
  assert.deepEqual(f.calls, [['-v'], ['--version']]);
  const text = formatEnvironmentReport(report);
  assert.match(text, /test profile（来源：项目手选）/);
  assert.match(text, /64M（来源：启动方案）/);
  assert.match(text, /QEMU 默认（未查询）/);
});
