const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { CSourceDebugAdapter } = require('../dist/debug/cAdapter');
const { MiClient } = require('../dist/debug/mi');
const F = require('./c-source-fixture.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(20); }
  throw new Error('Timeout waiting for ' + description);
}
function number(value) {
  const text = String(value);
  const match = /0x[0-9a-f]+|^-?\d+/i.exec(text);
  assert(match, 'Expected numeric debugger value: ' + text);
  return Number(match[0]);
}
class Client {
  constructor(project) {
    this.seq = 1; this.events = []; this.pending = new Map(); this.trusted = true; this.log = '';
    this.adapter = new CSourceDebugAdapter({ getProject: async () => project, isTrusted: () => this.trusted, log: text => { this.log += text; process.stdout.write(text); } });
    this.listener = this.adapter.onDidSendMessage(message => {
      if (message.type === 'event') this.events.push(message);
      if (message.type !== 'response') return;
      const pending = this.pending.get(message.request_seq); if (!pending) return;
      this.pending.delete(message.request_seq); clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.body || {});
      else pending.reject(new Error(`${message.command}: ${message.message || JSON.stringify(message.body)}`));
    });
  }
  request(command, args = {}) {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error('DAP ' + command + ' response timeout')); }, 30000);
      this.pending.set(seq, { resolve, reject, timer });
      Promise.resolve(this.adapter.handleMessage({ seq, type: 'request', command, arguments: args })).catch(error => {
        clearTimeout(timer); this.pending.delete(seq); reject(error);
      });
    });
  }
  event(name, after = 0) { return until(() => this.events.slice(after).find(event => event.event === name), 'DAP ' + name); }
  async stoppedAfter(command, args = { threadId: 1 }) {
    const count = this.events.length; await this.request(command, args); return (await this.event('stopped', count)).body;
  }
  async launch() {
    const initialized = await this.request('initialize', { adapterID: 'qemu-asm', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    assert.equal(initialized.supportsDisassembleRequest, true);
    await this.request('launch', { name: 'Actual C ELF/DWARF source integration', type: 'qemu-asm', request: 'launch', stopOnEntry: true });
    await this.event('initialized'); await this.request('configurationDone');
    assert.equal((await this.event('stopped')).body.reason, 'entry');
  }
  async disconnect() { const count = this.events.length; await this.request('disconnect', { terminateDebuggee: true }); await this.event('terminated', count); }
  async dispose() { await this.adapter.dispose(); this.listener.dispose(); for (const pending of this.pending.values()) clearTimeout(pending.timer); }
}
async function frames(client) { return (await client.request('stackTrace', { threadId: 1 })).stackFrames; }
async function frame(client) { return (await frames(client))[0]; }
async function evaluate(client, expression, frameId) {
  const selected = frameId ?? (await frame(client)).id;
  return client.request('evaluate', { expression, frameId: selected, context: 'watch' });
}
async function scalar(client, expression, frameId) { return number((await evaluate(client, expression, frameId)).result); }
async function variables(client, current) {
  const scopes = (await client.request('scopes', { frameId: current.id })).scopes;
  const groups = await Promise.all(scopes.map(async scope => ({ ...scope, variables: (await client.request('variables', { variablesReference: scope.variablesReference })).variables })));
  return { scopes, groups, all: groups.flatMap(group => group.variables) };
}
async function breakpoint(client, fixture, markers) {
  const result = await client.request('setBreakpoints', { source: { path: fixture.source }, breakpoints: markers.map(marker => ({ line: fixture.line(marker) })) });
  for (const bp of result.breakpoints) assert.equal(bp.verified, true, JSON.stringify(bp));
  return result.breakpoints;
}
async function memory(client, address, count, space = 'virtual') { return client.request('qemuAsm.inspectMemory', { address, count, space, follow: 'address' }); }

async function exercise(client, fixture, ui) {
  await client.launch();
  let current = await frame(client);
  assert.equal(current.source.path, fixture.source);
  assert.match(current.name, /kernel_main/);
  assert(number(current.instructionPointerReference) >= F.CODE_VIRTUAL);
  await breakpoint(client, fixture, ['KERNEL_READY']);
  await client.stoppedAfter('continue');
  current = await frame(client);
  assert.equal(current.line, fixture.line('KERNEL_READY'));
  const caller = await variables(client, current);
  for (const name of ['sample', 'values', 'cursor', 'result']) assert(caller.all.some(item => item.name === name), 'C local ' + name + ' missing');
  const sample = caller.all.find(item => item.name === 'sample');
  assert(sample.variablesReference > 0);
  const fields = (await client.request('variables', { variablesReference: sample.variablesReference })).variables;
  assert.equal(number(fields.find(item => item.name === 'left').value), 17);
  assert.equal(number(fields.find(item => item.name === 'right').value), 20);
  const array = caller.all.find(item => item.name === 'values');
  const elements = (await client.request('variables', { variablesReference: array.variablesReference })).variables;
  assert.deepEqual(elements.map(item => number(item.value)), [1, 2, 3]);
  const cursor = caller.all.find(item => item.name === 'cursor');
  assert(cursor.variablesReference > 0, 'Pointers must have an expandable pointee');
  assert((await client.request('variables', { variablesReference: cursor.variablesReference })).variables.length > 0);
  assert.equal(await scalar(client, 'sample.left'), 17);
  assert.equal(await scalar(client, 'values[2]'), 3);
  assert.equal(await scalar(client, '*cursor'), 1);
  assert.equal(await scalar(client, 'result'), 0);
  const localsScope = caller.scopes.find(scope => /局部|local/i.test(scope.name));
  const localInfo = await client.request('dataBreakpointInfo', { variablesReference: localsScope.variablesReference, name: 'result' });
  assert(localInfo.dataId, 'Native VS Code variable data breakpoints must resolve a DWARF local address and size');
  const fieldInfo = await client.request('dataBreakpointInfo', { variablesReference: sample.variablesReference, name: 'left' });
  assert(fieldInfo.dataId, 'A displayed structure child must resolve its actual C address');
  const oversized = await client.request('dataBreakpointInfo', { variablesReference: localsScope.variablesReference, name: 'values' });
  assert.equal(oversized.dataId, null, 'Unsupported 12-byte array watchpoints must fail explicitly');
  await assert.rejects(evaluate(client, 'result++'), /表达式|副作用|只读|read.only|side.effect|unsupported|允许|不支持/i);
  await assert.rejects(evaluate(client, 'adjust(3)'), /表达式|调用|只读|read.only|call|unsupported|允许|不支持/i);
  assert.equal(await scalar(client, 'result'), 0, 'rejected expressions must not mutate guest memory');
  console.log('PASS: actual C source breakpoint resolves the real file; DWARF locals, struct fields, array elements, pointer children and read-only expressions match initialized guest data');

  const staleFrame = current.id, staleVariables = sample.variablesReference;
  const nextAddress = number(current.instructionPointerReference) + 1; // fixture's real one-byte NOP
  const instruction = await client.request('setInstructionBreakpoints', { breakpoints: [{ instructionReference: `0x${nextAddress.toString(16)}` }] });
  assert.equal(instruction.breakpoints[0].verified, true);
  const customInstruction = await client.request('qemuAsm.instructionBreakpoints', { action: 'add', address: nextAddress });
  assert.equal(customInstruction.breakpoints.find(item => item.address === nextAddress).origin, 'both');
  await breakpoint(client, fixture, []);
  const instructionHit = await client.stoppedAfter('next');
  assert(instructionHit.hitBreakpointIds?.includes(instruction.breakpoints[0].id));
  assert.equal((await frame(client)).line, fixture.line('CALL_NESTED'));
  await client.request('setInstructionBreakpoints', { breakpoints: [] });
  assert.equal((await client.request('qemuAsm.instructionBreakpoints', { action: 'list' })).breakpoints[0].origin, 'custom');
  await client.request('qemuAsm.instructionBreakpoints', { action: 'clear' });
  const stale = await client.request('variables', { variablesReference: staleVariables }).catch(() => ({ variables: [] }));
  assert.equal(stale.variables.length, 0, 'a variable handle from an older stop must not expose cached values');
  await assert.rejects(evaluate(client, 'sample.left', staleFrame), /帧|失效|frame|stale|过期|无效/i);
  await client.stoppedAfter('stepIn');
  current = await frame(client);
  assert.match(current.name, /compute/);
  assert.equal(await scalar(client, 'count'), 3);
  await breakpoint(client, fixture, ['CALL_ADJUST']);
  if (current.line !== fixture.line('CALL_ADJUST')) await client.stoppedAfter('continue');
  await breakpoint(client, fixture, []);
  await client.stoppedAfter('stepIn');
  assert.match((await frame(client)).name, /adjust/);
  assert.equal(await scalar(client, 'seed'), 3);
  await client.stoppedAfter('next');
  assert.equal(await scalar(client, 'adjustment'), 5);
  await client.stoppedAfter('stepOut');
  assert.match((await frame(client)).name, /compute/);
  await breakpoint(client, fixture, ['NESTED_READY']);
  await client.stoppedAfter('continue');
  const nestedFrames = await frames(client);
  assert.match(nestedFrames[0].name, /compute/); assert.match(nestedFrames[1].name, /kernel_main/);
  assert.equal(nestedFrames[0].line, fixture.line('NESTED_READY'));
  assert.equal(await scalar(client, 'delta'), 5); assert.equal(await scalar(client, 'total'), 42);
  assert.equal(await scalar(client, 'snapshot.left'), 17);
  assert.equal(await scalar(client, 'values[2]', nestedFrames[1].id), 3);
  assert.equal(await scalar(client, 'sample.right', nestedFrames[1].id), 20);
  assert.equal(await scalar(client, 'result', nestedFrames[1].id), 0);
  await assert.rejects(evaluate(client, 'delta', nestedFrames[1].id), /delta|symbol|符号|上下文|context|not|找不到|unable to create variable/i);
  console.log('PASS: actual F10/F11/Shift-F11 traverse two C calls; DWARF stack frames select independent caller/callee locals and stale stop handles are rejected');

  const pc = number(nestedFrames[0].instructionPointerReference);
  const disassembly = await client.request('qemuAsm.disassemble', { address: pc, count: 8 });
  assert.equal(disassembly.bits, 32); assert.equal(disassembly.mode, 'protected32'); assert(disassembly.instructions.length > 0);
  const physical = await client.request('qemuAsm.inspectPaging', { address: pc });
  assert.equal(physical.status, 'mapped'); assert.equal(physical.cr3, F.PD);
  assert.equal(physical.physicalAddress, F.CODE_PHYSICAL + pc - F.CODE_VIRTUAL);
  assert.deepEqual((await memory(client, pc, 8)).bytes, (await memory(client, physical.physicalAddress, 8, 'physical')).bytes);
  const registers = await variables(client, nestedFrames[0]);
  assert(registers.scopes.some(scope => /register|寄存器/i.test(scope.name)));
  const address = await scalar(client, '&global_result');
  assert(address >= F.CODE_VIRTUAL);
  const info = await client.request('dataBreakpointInfo', { name: 'global_result', memoryReference: `0x${address.toString(16)}`, bytes: 4 });
  assert(info.dataId);
  const watch = await client.request('setDataBreakpoints', { breakpoints: [{ dataId: info.dataId, accessType: 'write' }] });
  assert.equal(watch.breakpoints[0].verified, true, JSON.stringify(watch));
  if (ui) await ui({ fixture, frame: nestedFrames[0], frames: nestedFrames, disassembly, physical, address });
  await breakpoint(client, fixture, []);
  await client.stoppedAfter('stepOut');
  assert.match((await frame(client)).name, /kernel_main/);
  if ((await frame(client)).line === fixture.line('CALL_NESTED')) await client.stoppedAfter('next');
  assert.equal((await frame(client)).line, fixture.line('AFTER_NESTED'));
  assert.equal(await scalar(client, 'result'), 42);
  const watchHit = await client.stoppedAfter('next');
  assert.equal(watchHit.reason, 'data breakpoint', JSON.stringify(watchHit));
  assert(watchHit.hitBreakpointIds?.includes(watch.breakpoints[0].id), JSON.stringify(watchHit));
  assert.equal(await scalar(client, 'global_result'), 42);
  assert.equal(Buffer.from((await memory(client, address, 4)).bytes).readUInt32LE(), 42);
  await breakpoint(client, fixture, ['READ_RESULT']);
  const sameValueStop = await client.stoppedAfter('continue');
  assert.equal(sameValueStop.reason, 'breakpoint', 'GDB write watchpoints compare values and do not report an equal-value store');
  assert.equal((await frame(client)).line, fixture.line('READ_RESULT'));
  assert.equal(await scalar(client, 'global_result'), 42);
  await breakpoint(client, fixture, []);
  await client.request('setDataBreakpoints', { breakpoints: [] });
  const read = await client.request('qemuAsm.watchpoints', { action: 'add', address, size: 4, access: 'read' });
  const readHit = await client.stoppedAfter('continue');
  assert.equal(readHit.reason, 'data breakpoint', JSON.stringify(readHit));
  assert(readHit.hitBreakpointIds?.includes(read.breakpoints[0].id));
  await client.request('qemuAsm.watchpoints', { action: 'clear' });
  const access = await client.request('qemuAsm.watchpoints', { action: 'add', address, size: 4, access: 'readWrite' });
  const accessHit = await client.stoppedAfter('continue');
  assert.equal(accessHit.reason, 'data breakpoint', JSON.stringify(accessHit));
  assert(accessHit.hitBreakpointIds?.includes(access.breakpoints[0].id));
  assert.equal(await scalar(client, 'global_result'), 42);
  await client.request('qemuAsm.watchpoints', { action: 'clear' });
  console.log('PASS: C debug and high nonidentity paging share real disassembly, register scopes, physical/virtual memory, page-table resolution and a native data breakpoint on global_result=42');
  console.log('PASS: native/custom address breakpoints share ownership; actual GDB write watch skips an equal-value store, read watch catches the load and access watch catches the following same-value store');

  await breakpoint(client, fixture, ['C_DONE']);
  await client.stoppedAfter('continue');
  assert(client.log.includes('CDEBUG:42'), 'Actual guest must emit its completed C computation marker');
  await breakpoint(client, fixture, []);
  await client.request('continue', { threadId: 1 });
  await delay(100);
  await assert.rejects(client.request('qemuAsm.inspectPaging', { address: F.CODE_VIRTUAL }), /暂停|停止|stopped|running/i);
  await assert.rejects(client.request('readMemory', { memoryReference: `0x${address.toString(16)}`, count: 4 }), /暂停|停止|stopped|running/i);
  const runningEvents = client.events.length;
  await breakpoint(client, fixture, ['C_DONE']);
  const dynamicStop = (await client.event('stopped', runningEvents)).body;
  assert.equal(dynamicStop.reason, 'breakpoint', 'Adding a C source breakpoint to a running guest must resume its internal pause and stop at the real source line');
  assert.equal((await frame(client)).line, fixture.line('C_DONE'));
  await breakpoint(client, fixture, []);
  await client.request('continue', { threadId: 1 });
  await client.stoppedAfter('pause');
  client.trusted = false;
  await assert.rejects(client.request('qemuAsm.inspectPaging', { address: F.CODE_VIRTUAL }), /信任|trust/i);
  await assert.rejects(evaluate(client, 'global_result'), /信任|trust/i);
  client.trusted = true;
  await breakpoint(client, fixture, ['KERNEL_READY']);
  const before = await frame(client);
  await client.stoppedAfter('restart', {});
  assert.match((await frame(client)).name, /kernel_main/);
  await assert.rejects(evaluate(client, 'global_result', before.id), /帧|失效|frame|stale|过期|无效/i);
  await client.stoppedAfter('continue');
  assert.equal((await frame(client)).line, fixture.line('KERNEL_READY'), 'Restart retains configured C source breakpoints');
  assert.equal(await scalar(client, 'global_result'), 0);
  await client.disconnect();
  console.log('PASS: actual C guest emits CDEBUG:42; running/untrusted operations are guarded, restart rebuilds clean guest state and old frame handles cannot cross sessions');
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu C DWARF actual, '));
  const clients = [], owned = [], gdbs = [];
  const originalStart = core.Processes.prototype.start;
  const originalMiStart = MiClient.start;
  MiClient.start = async function(...args) {
    const client = await originalMiStart.apply(this, args);
    gdbs.push(client.child);
    return client;
  };
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    if (/^(?:qemu-system-(?:i386|x86_64)|gdb)(?:\.exe)?$/i.test(path.basename(command))) owned.push(run);
    return run;
  };
  try {
    const fixture = await F.fixture(path.join(temporary, 'C sources with spaces, and commas'));
    const project = core.resolveProject(temporary, fixture.root, fixture.configuration, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, qemuArgs: ['-m', '32M'] });
    const client = new Client(project); clients.push(client);
    await exercise(client, fixture);

    const mapped = await F.fixture(path.join(temporary, 'DWARF5 with source mapping'), { dwarfVersion: 5, sourcePrefix: '/build/reproducible C sources' });
    const mappedProject = core.resolveProject(temporary, mapped.root, mapped.configuration, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, qemuArgs: ['-m', '32M'] });
    const mappedClient = new Client(mappedProject); clients.push(mappedClient);
    await mappedClient.launch();
    assert.equal((await frame(mappedClient)).source.path, mapped.source);
    await breakpoint(mappedClient, mapped, ['KERNEL_READY']);
    await mappedClient.stoppedAfter('continue');
    assert.equal((await frame(mappedClient)).source.path, mapped.source);
    assert.equal(await scalar(mappedClient, 'sample.left'), 17);
    assert.equal(await scalar(mappedClient, 'values[2]'), 3);
    await mappedClient.disconnect();
    console.log('PASS: GCC DWARF5 also resolves real C source lines and locals through a sourceMap whose build and checkout prefixes contain spaces');

    // Negative launch tests use the same already-built image and deliberately
    // malformed/stripped ELF files. No extra product templates are generated.
    const { spawnSync } = require('node:child_process');
    const originalElf = await fs.readFile(fixture.elf);
    for (const variant of ['malformed', 'stripped', 'without-debug']) {
      const invalidElf = path.join(fixture.root, 'build', variant + '.elf');
      await fs.writeFile(invalidElf, originalElf);
      if (variant === 'malformed') await fs.writeFile(invalidElf, 'not an ELF32 executable');
      else {
        const result = spawnSync(process.env.STRIP || 'strip', [variant === 'stripped' ? '--strip-all' : '--strip-debug', invalidElf], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
      const invalid = new Client({ ...project, build: { ...project.build, command: process.execPath, args: ['-e', ''], }, debug: { ...project.debug, elf: invalidElf } });
      clients.push(invalid);
      const count = owned.length + gdbs.length;
      await assert.rejects(invalid.launch(), /ELF32|DWARF|调试信息|调试节/i);
      await invalid.event('terminated');
      assert.equal(owned.length + gdbs.length, count, 'Invalid debug files must fail before starting QEMU or GDB');
    }
    console.log('PASS: malformed ELF, stripped ELF and ELF without debug sections fail clearly before any QEMU/GDB process starts');
    for (const run of owned) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null); }
    for (const child of gdbs) assert(child.exitCode !== null || child.signalCode !== null, 'Every private GDB process must exit');
    assert(owned.length >= 3 && gdbs.length >= 3, 'Launch, restart and DWARF5 runs must own and clean both GDB and QEMU');
    console.log('PASS: all actual QEMU/GDB children exit after restart/disconnect');
  } finally {
    for (const client of clients) await client.dispose();
    core.Processes.prototype.start = originalStart;
    MiClient.start = originalMiStart;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

module.exports = { Client, exercise, until, frame, frames, evaluate, scalar, variables, breakpoint, memory, number, ...F };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
