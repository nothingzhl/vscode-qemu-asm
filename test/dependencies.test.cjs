const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { localHost } = require('../dist/platform/host');
const { Processes } = require('../dist/platform/processes');
const { resolveExecutable } = require('../dist/dependencies/tools');
const { CapabilityLedger, capabilityIds } = require('../dist/dependencies/capabilities');
const { checkEnvironment, formatEnvironmentReport } = require('../dist/dependencies/doctor');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dependencies test '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'tools with spaces');
  await fs.mkdir(bin);
  const names = { nasm: 'NASM version 2.16.03 compiled on Oct 15 2026', qemu: 'QEMU emulator version 10.0.13', gdb: 'GNU gdb (Debian 16.3-1) 16.3' };
  const commands = {};
  for (const [id, output] of Object.entries(names)) {
    const command = path.join(bin, `${id}.exe`);
    const args = id === 'nasm' ? ['-v'] : ['--version'];
    const body = options[id] ?? `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))}) process.exit(42); console.log(${JSON.stringify(output)});`;
    await fs.writeFile(command, body, { mode: 0o755 });
    commands[id] = command;
  }
  const builder = path.join(bin, 'custom builder.exe');
  await fs.writeFile(builder, 'throw new Error("Doctor must never execute a builder");', { mode: 0o755 });
  const calls = [];
  // Execute real owned processes through the injected host. Text fixture files are
  // interpreted by Node here; this checks dependency contracts, not native PE support.
  const host = {
    ...localHost,
    identity: { ...localHost.identity },
    env: { ...process.env, PATH: bin },
    // Keep native cleanup (including Windows taskkill) out of the Node tool wrapper.
    terminateProcessTree: localHost.terminateProcessTree.bind(localHost),
    spawn(command, args, spawnOptions) {
      calls.push({ command, args: [...args], cwd: spawnOptions.cwd });
      return spawn(process.execPath, [command, ...args], spawnOptions);
    },
  };
  const processes = new Processes(host);
  t.after(() => processes.dispose());
  const project = {
    workspace: root, root, source: path.join(root, 'boot.asm'), image: path.join(root, 'build', 'boot.img'), stages: [],
    nasm: commands.nasm, qemu: commands.qemu, qemuArgs: ['-m', '32M'],
  };
  return { root, bin, project, commands, builder, calls, host, processes };
}

test('capabilities stay unknown until observed and snapshots cannot mutate a session', () => {
  const scope = { sessionId: 'one', targetId: '127.0.0.1:1234', tools: { qemu: '/tools/qemu' }, machine: ['-m', '32M'], host: { platform: 'linux', arch: 'x64' } };
  let milliseconds = Date.UTC(2026, 9, 15);
  const ledger = new CapabilityLedger(scope, () => new Date(milliseconds++));
  const first = ledger.snapshot();
  assert.equal(first.entries.length, capabilityIds.length);
  assert(first.entries.every(entry => entry.state === 'unknown' && entry.evidence === 'not-checked'));
  scope.tools.qemu = '/changed'; scope.machine[1] = '64M'; scope.host.arch = 'arm64';
  const details = { architecture: 'i386' };
  ledger.record('qemu.rspTarget', { state: 'supported', evidence: 'protocol', reason: 'XML architecture i386', details });
  details.architecture = 'aarch64';
  const second = ledger.snapshot();
  assert.equal(second.entries.find(entry => entry.id === 'qemu.rspTarget').details.architecture, 'i386');
  assert.equal(second.scope.tools.qemu, '/tools/qemu'); assert.equal(second.scope.machine[1], '32M'); assert.equal(second.scope.host.arch, 'x64');
  second.scope.tools.qemu = 'mutated'; second.entries[0].reason = 'mutated';
  assert.equal(ledger.snapshot().scope.tools.qemu, '/tools/qemu');
  assert.equal(ledger.snapshot().entries[0].reason, 'XML architecture i386');
  assert.notEqual(second.createdAt, second.updatedAt);
  const next = new CapabilityLedger({ sessionId: 'two', targetId: 'new-target' });
  assert(next.snapshot().entries.every(entry => entry.state === 'unknown'));
  ledger.record('qemu.rspTarget', { state: 'unsupported', evidence: 'protocol', reason: 'Target changed architecture' });
  assert.equal(ledger.snapshot().entries[0].state, 'unsupported');
  assert.throws(() => new CapabilityLedger({ sessionId: '' }), /会话/);
  assert.throws(() => ledger.record('qemu.rspTarget', { state: 'unknown', evidence: 'not-checked', reason: '' }), /原因/);
});

test('NASM doctor uses shared resolver paths and executable evidence without requiring GDB', async t => {
  const f = await fixture(t);
  f.project.nasm = 'nasm.exe';
  const report = await checkEnvironment(f.project, f.processes);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.tools.map(tool => tool.id), ['nasm', 'qemu']);
  assert.deepEqual(report.tools.map(tool => tool.version), ['2.16.03', '10.0.13']);
  assert.deepEqual(report.tools[0].resolution, resolveExecutable('nasm.exe', f.root, f.host));
  assert.equal(report.tools[0].resolution.source, 'path');
  assert.equal(report.tools[1].resolution.source, 'configured');
  assert.deepEqual(f.calls.map(call => [call.command, call.args]), [[f.commands.nasm, ['-v']], [f.commands.qemu, ['--version']]]);
  assert(report.capabilities.entries.every(entry => entry.state === 'unknown' && entry.evidence === 'not-checked'));
  assert(report.tools.every(tool => tool.evidence === 'executable'));
  assert.equal(report.capabilities.scope.tools.nasm, f.commands.nasm);
  const text = formatEnvironmentReport(report);
  assert.match(text, /版本可识别不等于目标功能可用/);
  assert.match(text, /NASM 2\.16\.03/);
  assert.doesNotMatch(text, /最低版本|完整集成.*通过/);
});

test('external C doctor resolves builder without executing it or requiring NASM', async t => {
  const f = await fixture(t);
  f.project.nasm = path.join(f.root, 'missing-nasm');
  f.project.build = { command: f.builder, args: ['custom', '--dangerous-if-run'], cwd: f.root, timeout: 120000 };
  f.project.debug = { elf: path.join(f.root, 'kernel.elf'), gdb: f.commands.gdb };
  const report = await checkEnvironment(f.project, f.processes);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.tools.map(tool => tool.id), ['builder', 'qemu', 'gdb']);
  assert.equal(report.tools[0].status, 'not-run');
  assert.equal(report.tools[0].evidence, 'not-checked');
  assert.match(report.tools[0].reason, /不执行用户构建/);
  assert.equal(report.tools[2].version, '16.3');
  assert.deepEqual(f.calls.map(call => call.command), [f.commands.qemu, f.commands.gdb]);
  assert.equal(report.capabilities.entries.find(entry => entry.id === 'gdb.mi').state, 'unknown');
});

test('missing and non-executable tools produce structured failures without being launched', async t => {
  const f = await fixture(t);
  f.project.nasm = path.join(f.root, 'missing nasm');
  f.project.qemu = path.join(f.root, 'not a tool.exe');
  await fs.mkdir(f.project.qemu);
  const report = await checkEnvironment(f.project, f.processes);
  assert.equal(report.status, 'failed'); assert.equal(f.calls.length, 0);
  assert.deepEqual(report.tools.map(tool => tool.resolution.status), ['missing', 'not-executable']);
  assert(report.tools.every(tool => tool.status === 'failed' && tool.evidence === 'not-checked'));
  assert.match(formatEnvironmentReport(report), /找不到工具/);
});

test('nonzero exit and unrecognized version identity fail even if a version number is printed', async t => {
  const f = await fixture(t, {
    nasm: 'console.log("NASM version 2.16.03"); process.exit(7);',
    qemu: 'console.log("Unrelated tool version 10.0.13");',
  });
  const report = await checkEnvironment(f.project, f.processes);
  assert.equal(report.status, 'failed');
  assert.match(report.tools[0].reason, /退出码 7/);
  assert.match(report.tools[1].reason, /无法识别为预期工具/);
  assert(report.tools.every(tool => tool.version === undefined));
  assert.match(report.tools[0].output, /NASM version/);
});

test('doctor bounds unexpected output and retains separate runtime evidence', async t => {
  const f = await fixture(t, { nasm: 'process.stdout.write("x".repeat(200000));' });
  const ledger = new CapabilityLedger({ sessionId: 'active-c', targetId: 'existing:1234', backend: 'c' });
  ledger.record('gdb.mi', { state: 'supported', evidence: 'protocol', reason: 'Actual MI handshake completed' });
  const runtime = ledger.snapshot();
  const report = await checkEnvironment(f.project, f.processes, { runtimeReport: runtime });
  assert.equal(report.tools[0].output.length, 16384);
  assert.notEqual(report.capabilities.scope.sessionId, runtime.scope.sessionId);
  assert(report.capabilities.entries.every(entry => entry.state === 'unknown'));
  assert.equal(report.runtimeReport.entries.find(entry => entry.id === 'gdb.mi').evidence, 'protocol');
  runtime.entries[4].reason = 'mutated';
  assert.equal(report.runtimeReport.entries[4].reason, 'Actual MI handshake completed');
  assert.match(formatEnvironmentReport(report), /实际会话能力（独立范围）：active-c/);
  assert.match(formatEnvironmentReport(report), /gdb\.mi：可用；证据：协议探针/);
});

test('doctor cancellation skips subsequent probes and timeout terminates the owned executable', async t => {
  const f = await fixture(t, { nasm: 'setInterval(() => {}, 1000);' });
  const timedOut = await checkEnvironment(f.project, f.processes, { timeout: 500 });
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.tools[0].reason, /超时/);
  assert.equal(timedOut.tools[1].status, 'passed');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const cancelled = await checkEnvironment(f.project, f.processes, { signal: controller.signal });
  clearTimeout(timer);
  assert.equal(cancelled.status, 'cancelled');
  assert(cancelled.tools.every(tool => tool.status === 'not-run'));
  assert.equal(f.calls.length, 3); // timeout NASM + QEMU, then cancelled NASM only
  const before = f.calls.length;
  const preCancelled = await checkEnvironment(f.project, f.processes, { signal: controller.signal });
  assert.equal(preCancelled.status, 'cancelled');
  assert.equal(f.calls.length, before);
});

test('doctor refuses a resolver host different from the actual process host', async t => {
  const f = await fixture(t);
  await assert.rejects(checkEnvironment(f.project, f.processes, { host: { ...f.host } }), /同一宿主/);
});
