// Real startup-profile acceptance. Protocol observation stays inside this test;
// product consumers continue to use the normal machine/debugging capabilities.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');
const { QemuScreen } = require('../dist/display/screen');
const { CSourceDebugAdapter } = require('../dist/debug/cAdapter');
const { fixture: cFixture } = require('./c-source-fixture.cjs');

const profiles = {
  small: { memoryMiB: 16, cpuModel: 'qemu32', display: false },
  normal: { memoryMiB: 64, cpuModel: 'pentium3', display: true },
  invalidCPU: { memoryMiB: 16, cpuModel: 'missing-profile-cpu', display: false }
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(25); }
  throw new Error('Timeout waiting for ' + description);
}
function observeProcesses() {
  const original = core.Processes.prototype.start;
  const qemus = [];
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = original.call(this, command, args, cwd, log);
    if (args.includes('-drive')) qemus.push({ args, run });
    return run;
  };
  return { qemus, restore: () => { core.Processes.prototype.start = original; } };
}
function assertArguments(args, name) {
  const expected = profiles[name];
  for (const [flag, value] of [['-m', expected.memoryMiB + 'M'], ['-cpu', expected.cpuModel]]) {
    assert.equal(args.filter(item => item === flag).length, 1, flag + ' must have one effective value');
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.equal(args.includes('-qmp'), expected.display, 'profile display must control QMP allocation');
}
class Client {
  constructor(getProject, screens, Adapter = AssemblyDebugAdapter) {
    this.seq = 1; this.events = []; this.pending = new Map();
    this.adapter = new Adapter({ getProject, isTrusted: () => true, log: text => process.stdout.write(text),
      createDisplay: async project => {
        if (project.displayMode === 'off') return undefined;
        const screen = await QemuScreen.create(); screens.push(screen); return screen;
      }
    });
    this.listener = this.adapter.onDidSendMessage(message => {
      if (message.type === 'event') this.events.push(message);
      const pending = message.type === 'response' && this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq); clearTimeout(pending.timer);
      message.success ? pending.resolve(message.body || {}) : pending.reject(new Error(message.message || message.command));
    });
  }
  request(command, args = {}) {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(command + ' timed out')); }, 30000);
      this.pending.set(seq, { resolve, reject, timer });
      Promise.resolve(this.adapter.handleMessage({ seq, type: 'request', command, arguments: args })).catch(reject);
    });
  }
  async stoppedAfter(command, args = {}) {
    const before = this.events.length; await this.request(command, args);
    return until(() => this.events.slice(before).find(event => event.event === 'stopped'), command + ' stop');
  }
  async launch() {
    await this.request('initialize', { adapterID: 'qemu-asm', linesStartAt1: true });
    await this.request('launch', { stopOnEntry: true });
    await this.request('configurationDone');
    await until(() => this.events.find(event => event.event === 'stopped'), 'NASM entry');
  }
  async disconnect() {
    const before = this.events.length; await this.request('disconnect', { terminateDebuggee: true });
    await until(() => this.events.slice(before).find(event => event.event === 'terminated'), 'debug termination');
  }
  async dispose() {
    await this.adapter.dispose(); this.listener.dispose();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
  }
}
async function exerciseAssembly(temporary, tools = {}) {
  const root = path.join(temporary, 'profile NASM with spaces, and commas');
  await core.createProject(root);
  const config = { machineProfiles: profiles, defaultMachineProfile: 'small' };
  await fs.writeFile(path.join(root, 'qemu-asm.json'), JSON.stringify(config));
  const settings = { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH,
    gdb: path.join(root, 'GDB must never run'), qemuArgs: ['-m', '32M', '-cpu', 'qemu32', '-smp', '1'], displayMode: 'auto', ...tools };
  let selected;
  const getProject = async () => core.resolveProject(temporary, root, config, settings, selected);
  const screens = [], observed = observeProcesses(), client = new Client(getProject, screens);
  try {
    await client.launch(); assertArguments(observed.qemus.at(-1).args, 'small');
    const backend = client.adapter.resources.owned.backend;
    const tree = await backend.client.command('qRcmd,' + Buffer.from('info mtree').toString('hex'));
    assert.match(tree.toLowerCase(), /0000000000ffffff[^\n]*pc\.ram/, 'actual RSP monitor must expose 16 MiB RAM extent');
    const first = observed.qemus[0].run;
    selected = { name: 'normal', source: 'selected' };
    assertArguments(observed.qemus[0].args, 'small');
    await client.stoppedAfter('restart');
    assert.equal(observed.qemus.length, 2); assertArguments(observed.qemus.at(-1).args, 'normal');
    await first.done;
    assert(first.child.exitCode !== null || first.child.signalCode !== null, 'restart terminates previous QEMU');
    const screen = screens.at(-1); await screen.connect();
    const memory = await screen.client.command('query-memory-size-summary');
    assert.equal(memory['base-memory'], 64 * 1024 * 1024, JSON.stringify(memory));
    const cpus = await screen.client.command('query-hotpluggable-cpus');
    assert.equal(cpus[0].type, 'pentium3-i386-cpu', 'QMP must report the actual selected CPU implementation');
    const frame = (await client.request('stackTrace', { threadId: 1 })).stackFrames[0];
    assert.equal(await fs.realpath(frame.source.path), await fs.realpath(path.join(root, 'boot.asm')));
    const report = await client.request('qemuAsm.dependencyReport');
    assert.equal(report.scope.backend, 'nasm-rsp');
    await client.request('disconnect', { terminateDebuggee: true });
    selected = { name: 'invalidCPU', source: 'launch' };
    await assert.rejects(client.request('launch', { stopOnEntry: true }), /CPU|cpu|QEMU|退出/);
    console.log('PASS: real NASM profiles replace legacy memory/CPU exactly once; RSP proves 16 MiB, QMP proves 64 MiB; restart changes CPU/display, missing CPU fails and no GDB is used');
    return { profiles: ['small', 'normal'], memoryBytes: [16, 64].map(value => value * 1024 * 1024), missingCPU: 'failed-as-expected' };
  } finally {
    await client.dispose();
    for (const item of observed.qemus) {
      await item.run.done.catch(() => undefined);
      assert(item.run.child.exitCode !== null || item.run.child.signalCode !== null, 'every profile-owned QEMU exits');
    }
    for (const screen of screens) await screen.dispose();
    observed.restore();
  }
}
async function exerciseC(temporary) {
  const fixture = await cFixture(path.join(temporary, 'C profile DWARF'));
  const config = { ...fixture.configuration, machineProfiles: profiles, defaultMachineProfile: 'small' };
  let selected;
  const getProject = () => core.resolveProject(temporary, fixture.root, config, {
    nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, gdb: process.env.GDB_PATH
  }, selected);
  const screens = [];
  const client = new Client(async () => getProject(), screens, CSourceDebugAdapter);
  const observed = observeProcesses();
  try {
    await client.launch(); assertArguments(observed.qemus.at(-1).args, 'small');
    await client.request('setBreakpoints', { source: { path: fixture.source }, breakpoints: [{ line: fixture.line('KERNEL_READY') }] });
    await client.stoppedAfter('continue');
    const frame = (await client.request('stackTrace', { threadId: 1 })).stackFrames[0];
    const scopes = (await client.request('scopes', { frameId: frame.id })).scopes;
    const locals = scopes.find(item => /locals|局部/i.test(item.name)); assert(locals);
    const variables = (await client.request('variables', { variablesReference: locals.variablesReference })).variables;
    const sample = variables.find(item => item.name === 'sample'); assert(sample?.variablesReference > 0);
    assert.equal(Number((await client.request('evaluate', { expression: 'sample.left', frameId: frame.id })).result), 17);
    selected = { name: 'normal', source: 'launch' };
    await client.stoppedAfter('restart', {});
    assertArguments(observed.qemus.at(-1).args, 'normal');
    const screen = screens.at(-1); await screen.connect();
    assert.equal((await screen.client.command('query-memory-size-summary'))['base-memory'], 64 * 1024 * 1024);
    await assert.rejects(client.request('evaluate', { expression: 'sample.left', frameId: frame.id }), /帧|frame|过期|invalid/i);
    const stale = await client.request('variables', { variablesReference: sample.variablesReference }).catch(() => ({ variables: [] }));
    assert.deepEqual(stale.variables, []);
    await client.disconnect();
    console.log('PASS: C/GDB profiles reach initialized DWARF locals; changed-memory/CPU restart invalidates previous frame and variable handles');
  } finally {
    await client.dispose();
    for (const item of observed.qemus) await item.run.done.catch(() => undefined);
    for (const screen of screens) await screen.dispose();
    observed.restore();
  }
}
async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu startup profiles, '));
  try { await exerciseAssembly(temporary); await exerciseC(temporary); }
  finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
module.exports = { exerciseAssembly };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
