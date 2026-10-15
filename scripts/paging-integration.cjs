const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');
const F = require('./paging-fixture.cjs');

const HEX = value => `0x${value.toString(16)}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(20); }
  throw new Error(`Timeout waiting for ${description}`);
}
function number(value) { return Number(/0x[0-9a-f]+/i.exec(String(value))?.[0] ?? value); }
async function frame(client) { return (await client.request('stackTrace', { threadId: 1 })).stackFrames[0]; }
async function evaluate(client, expression) { return number((await client.request('evaluate', { expression, frameId: 1, context: 'watch' })).result); }
async function memory(client, address, count, space = 'virtual') {
  return client.request('qemuAsm.inspectMemory', { address, count, follow: 'address', space });
}
async function word(client, address, space = 'virtual') { return Buffer.from((await memory(client, address, 4, space)).bytes).readUInt32LE(); }
async function instructions(client, addresses) {
  const result = await client.request('setInstructionBreakpoints', { breakpoints: addresses.map(address => ({ instructionReference: HEX(address) })) });
  result.breakpoints.forEach(item => assert.equal(item.verified, true, JSON.stringify(item)));
  return result.breakpoints;
}
async function sourceBreakpoints(client, project, lines) {
  const result = await client.request('setBreakpoints', { source: { path: project.source }, breakpoints: lines.map(line => ({ line })) });
  result.breakpoints.forEach(item => assert.equal(item.verified, true, JSON.stringify(item)));
  return result.breakpoints;
}
function hit(stop, id) {
  assert.equal(stop.reason, 'data breakpoint', JSON.stringify(stop));
  assert(stop.hitBreakpointIds?.includes(id), `Watchpoint ${id} must be identified: ${JSON.stringify(stop)}`);
}

class Client {
  constructor(project) {
    this.seq = 1; this.events = []; this.pending = new Map(); this.trusted = true;
    this.adapter = new AssemblyDebugAdapter({ getProject: async () => project, isTrusted: () => this.trusted, log: text => process.stdout.write(text) });
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
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`DAP ${command} response timeout`)); }, 30000);
      this.pending.set(seq, { resolve, reject, timer });
      Promise.resolve(this.adapter.handleMessage({ seq, type: 'request', command, arguments: args })).catch(error => {
        clearTimeout(timer); this.pending.delete(seq); reject(error);
      });
    });
  }
  event(name, after = 0) { return until(() => this.events.slice(after).find(event => event.event === name), `DAP ${name}`); }
  async stoppedAfter(command, args = { threadId: 1 }) {
    const count = this.events.length; await this.request(command, args); return (await this.event('stopped', count)).body;
  }
  async launch() {
    await this.request('initialize', { adapterID: 'qemu-asm', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    await this.request('launch', { name: 'Actual non-PAE paging integration', type: 'qemu-asm', request: 'launch', stopOnEntry: true });
    await this.event('initialized'); await this.request('configurationDone');
    assert.equal((await this.event('stopped')).body.reason, 'entry');
  }
  async disconnect() { const count = this.events.length; await this.request('disconnect', { terminateDebuggee: true }); await this.event('terminated', count); }
  async dispose() { await this.adapter.dispose(); this.listener.dispose(); for (const pending of this.pending.values()) clearTimeout(pending.timer); }
}

async function exercisePaging(client, project, ui) {
  await client.launch();
  const disabled = await client.request('qemuAsm.inspectPaging', { address: 0x7c00 });
  assert.equal(disabled.status, 'identity'); assert.equal(disabled.pagingEnabled, false);
  const beforeLine = project.line('nop');
  await sourceBreakpoints(client, project, [beforeLine]);
  const native = await instructions(client, [F.HIGH_CALL]);
  await client.stoppedAfter('continue');
  assert.equal((await frame(client)).line, beforeLine, 'ordinary source breakpoint before PG must coexist with a high virtual address breakpoint');
  const stop = await client.stoppedAfter('continue');
  assert(stop.hitBreakpointIds?.includes(native[0].id));
  let current = await frame(client);
  assert.equal(number(current.instructionPointerReference), F.HIGH_CALL);
  assert.equal(current.source, undefined, 'copied high virtual code must not invent a source location');
  assert.equal(await evaluate(client, 'esp'), F.HIGH_STACK);
  assert.equal(await evaluate(client, 'eax'), 0x40);
  assert((await evaluate(client, 'cr0')) & 0x80000000, 'actual guest must have CR0.PG set');
  const decoded = await client.request('qemuAsm.disassemble', { address: F.HIGH_CODE, count: 7 });
  assert.equal(decoded.mode, 'protected32'); assert.equal(decoded.bits, 32);
  assert.match(decoded.instructions[1].instruction, /^call\b/i);
  assert.equal(decoded.instructions[1].size, 5);
  assert.equal((await client.stoppedAfter('next')).reason, 'step');
  current = await frame(client);
  assert.equal(number(current.instructionPointerReference), F.HIGH_WRITE, 'F10 must execute actual CALL/RET across nonidentity paging');
  assert.equal(current.source, undefined);
  assert.equal(await evaluate(client, 'eax'), 0x41);
  assert.equal(await evaluate(client, 'esp'), F.HIGH_STACK, 'actual RET must restore nonidentity virtual stack');
  await instructions(client, []);
  console.log('PASS: actual CR0.PG guest stops at a high virtual address breakpoint; live 32-bit decoding and F10 CALL/RET use virtual code and a nonidentity virtual stack');

  const page = await client.request('qemuAsm.inspectPaging', { address: F.HIGH_DATA + 3 });
  assert.equal(page.format, 'legacy32'); assert.equal(page.status, 'mapped');
  assert.equal(page.cr3, F.PD); assert.equal(page.directoryBase, F.PD);
  assert.equal(page.directoryIndex, 768); assert.equal(page.tableIndex, 256);
  assert.equal(page.pde.address, F.PD + 768 * 4); assert.equal(page.pte.address, F.HIGH_PT + 256 * 4);
  assert.equal(page.physicalAddress, F.DATA_PHYSICAL + 3); assert.equal(page.pageSize, 4096);
  assert.equal(page.effective.user, true); assert.equal(page.effective.writable, true);
  const readonly = await client.request('qemuAsm.inspectPaging', { address: F.HIGH_READONLY });
  assert.equal(readonly.status, 'mapped'); assert.equal(readonly.effective.user, true);
  assert.equal(readonly.effective.writable, false); assert.equal(readonly.effective.userWrite, false);
  assert.equal(readonly.effective.supervisorWrite, false, 'CR0.WP must forbid supervisor writes to a read-only mapping');
  const codePage = await client.request('qemuAsm.inspectPaging', { address: F.HIGH_CODE });
  assert.equal(codePage.effective.user, false, 'effective US permission is PDE.US AND PTE.US');
  const absentTable = await client.request('qemuAsm.inspectPaging', { address: F.HIGH_MISSING });
  assert.equal(absentTable.status, 'not-present'); assert.equal(absentTable.faultLevel, 'table');
  assert.equal(absentTable.physicalAddress, undefined);
  const absentDirectory = await client.request('qemuAsm.inspectPaging', { address: 0x40000000 });
  assert.equal(absentDirectory.status, 'not-present'); assert.equal(absentDirectory.faultLevel, 'directory');
  const big = await client.request('qemuAsm.inspectPaging', { address: F.BIG_VIRTUAL + 0x123 });
  assert.equal(big.status, 'mapped'); assert.equal(big.pageSize, 4194304);
  assert.equal(big.physicalAddress, F.BIG_PHYSICAL + 0x123); assert.equal(big.pte, undefined);
  assert.equal(big.pde.address, F.PD + 512 * 4);
  console.log('PASS: actual physical PDE/PTE walk resolves 4KiB and PSE 4MiB mappings, CR0.WP/effective US/RW, and missing directory/table entries without claiming a physical address');

  await assert.rejects(memory(client, F.PD, 4), /读取|内存|memory|E[0-9a-f]{2}/i);
  const physicalDirectory = await memory(client, F.PD, 4, 'physical');
  assert.equal(Buffer.from(physicalDirectory.bytes).readUInt32LE(), F.LOW_PT | 3 | 0x20);
  assert.equal(await word(client, F.CODE_PHYSICAL), 0xaabbccdd, 'virtual 0x200000 aliases an independent page');
  const physicalCode = await memory(client, F.CODE_PHYSICAL, 5, 'physical');
  assert.deepEqual(physicalCode.bytes, [0xb8, 0x40, 0, 0, 0]);
  assert.equal(await word(client, F.CODE_PHYSICAL), 0xaabbccdd, 'physical inspection must restore virtual mode before the next read');
  assert.deepEqual((await memory(client, F.HIGH_CODE, 5)).bytes, physicalCode.bytes);
  assert.deepEqual((await memory(client, F.HIGH_DATA + 4092, 8)).bytes, [0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55], 'virtual memory reads must cross an actual 4KiB page boundary');
  assert.match((await client.request('qemuAsm.disassemble', { address: F.HIGH_CALL, count: 1 })).instructions[0].instruction, /^call\b/i);
  const descriptors = await client.request('qemuAsm.inspectDescriptors', { table: 'gdt', start: 0, count: 3 });
  assert.equal(descriptors.base, F.HIGH_GDT, 'GDTR base is linear, so descriptor reads must remain virtual');
  assert.equal(descriptors.entries[1].defaultBits, 32); assert.equal(descriptors.entries[2].writable, true);
  console.log('PASS: page tables are not virtually mapped; physical reads work, same numeric virtual/physical addresses return different actual bytes, virtual mode is restored and a nonidentity GDT remains readable');

  const info = await client.request('dataBreakpointInfo', { name: HEX(F.HIGH_DATA), memoryReference: HEX(F.HIGH_DATA), bytes: 4 });
  const configured = await client.request('setDataBreakpoints', { breakpoints: [{ dataId: info.dataId, accessType: 'write' }] });
  assert.equal(configured.breakpoints[0].verified, true);
  hit(await client.stoppedAfter('stepIn'), configured.breakpoints[0].id);
  assert.equal(number((await frame(client)).instructionPointerReference), F.HIGH_READ);
  assert.equal(await word(client, F.HIGH_DATA), 1); assert.equal(await word(client, F.DATA_PHYSICAL, 'physical'), 1);
  await client.request('setDataBreakpoints', { breakpoints: [] });
  let watched = await client.request('qemuAsm.watchpoints', { action: 'add', address: F.HIGH_DATA, size: 4, access: 'read' });
  let active = watched.breakpoints.find(item => item.address === F.HIGH_DATA);
  hit(await client.stoppedAfter('stepIn'), active.id);
  assert.equal(number((await frame(client)).instructionPointerReference), F.HIGH_AFTER_READ);
  assert.equal(await evaluate(client, 'ebx'), 1);
  await client.request('qemuAsm.watchpoints', { action: 'clear' });
  watched = await client.request('qemuAsm.watchpoints', { action: 'add', address: F.HIGH_DATA, size: 4, access: 'readWrite' });
  active = watched.breakpoints.find(item => item.address === F.HIGH_DATA);
  hit(await client.stoppedAfter('continue'), active.id);
  assert.equal(number((await frame(client)).instructionPointerReference), F.HIGH_READ);
  assert.equal(await word(client, F.HIGH_DATA), 2);
  const listed = await client.request('qemuAsm.watchpoints', { action: 'list' });
  assert.equal(listed.lastHit.address, F.HIGH_DATA); assert.equal(listed.lastHit.access, 'readWrite');
  console.log('PASS: actual native write and custom read/access data breakpoints use virtual addresses, stop at real memory operations and identify matching breakpoint IDs after paging');

  if (ui) await ui({ project, page, readonly, big, frame: await frame(client), disassembly: decoded, watchpoints: listed });

  await instructions(client, [F.HIGH_WRITE]);
  await client.stoppedAfter('restart', {});
  assert.equal((await client.request('qemuAsm.watchpoints', { action: 'list' })).lastHit, undefined);
  assert((await client.request('qemuAsm.watchpoints', { action: 'list' })).breakpoints.some(item => item.id === active.id));
  await client.request('qemuAsm.watchpoints', { action: 'clear' });
  await client.stoppedAfter('continue');
  assert.equal((await frame(client)).line, beforeLine, 'restart retains source breakpoints');
  await sourceBreakpoints(client, project, []);
  await client.stoppedAfter('continue');
  assert.equal(number((await frame(client)).instructionPointerReference), F.HIGH_WRITE, 'restart retains virtual instruction breakpoints');
  await instructions(client, []);
  await client.request('continue', { threadId: 1 });
  await assert.rejects(client.request('qemuAsm.inspectPaging', { address: F.HIGH_DATA }), /暂停|停止|stopped/i);
  await assert.rejects(memory(client, F.PD, 4, 'physical'), /暂停|停止|stopped/i);
  await client.stoppedAfter('pause');
  await client.disconnect();
  console.log('PASS: restart retains address/data/source breakpoint configurations and clears prior hits; running CPU paging/physical reads are rejected; real QEMU disconnects cleanly');
}

async function exerciseRemappedSource(client, project) {
  await client.launch();
  const probeLine = project.text.split('\n').findIndex(line => line === 'remap_probe:') + 2;
  await sourceBreakpoints(client, project, [probeLine]);
  await client.stoppedAfter('continue');
  const before = await frame(client);
  const address = number(before.instructionPointerReference);
  assert.equal(before.source, undefined, 'a remapped listing address must not acquire its original NASM source');
  assert.equal(await evaluate(client, 'eax'), 0x40);
  const mapping = await client.request('qemuAsm.inspectPaging', { address });
  assert.equal(mapping.physicalAddress, 0x250000 + address - 0x8000);
  const decoded = await client.request('qemuAsm.disassemble', { address, count: 1 });
  assert.match(decoded.instructions[0].instruction, /^call\b/i);
  assert.equal(decoded.instructions[0].size, 5, 'live mapped instruction is five bytes; original listing has a one-byte NOP');
  const stack = await evaluate(client, 'esp');
  await client.stoppedAfter('next');
  assert.equal(number((await frame(client)).instructionPointerReference), address + 5, 'F10 must use the actual remapped CALL length');
  assert.equal((await frame(client)).source, undefined);
  assert.equal(await evaluate(client, 'eax'), 0x41, 'actual high virtual helper must execute its INC/RET');
  assert.equal(await evaluate(client, 'esp'), stack);
  await client.disconnect();
  console.log('PASS: an actual listing address remapped to different physical code hides its NASM source; a one-byte listing NOP replaced by a live five-byte CALL steps over using actual memory and RET');
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu paging 实际集成, '));
  const clients = [], qemus = [];
  const originalStart = core.Processes.prototype.start;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  try {
    const project = await F.fixture(path.join(temporary, 'nonidentity paging with spaces, and commas'));
    const config = JSON.parse(await fs.readFile(path.join(project.root, 'qemu-asm.json'), 'utf8'));
    const resolved = core.resolveProject(temporary, project.root, config, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, qemuArgs: ['-m', '32M'] });
    const client = new Client(resolved); clients.push(client);
    await exercisePaging(client, project);
    const fresh = new Client(resolved); clients.push(fresh); await fresh.launch();
    assert.deepEqual((await fresh.request('qemuAsm.watchpoints', { action: 'list' })).breakpoints, []);
    fresh.trusted = false;
    await assert.rejects(fresh.request('qemuAsm.inspectPaging', { address: F.HIGH_DATA }), /信任|trust/i);
    await assert.rejects(memory(fresh, F.PD, 4, 'physical'), /信任|trust/i);
    fresh.trusted = true; await fresh.disconnect();
    const remapped = await F.fixture(path.join(temporary, 'source address remapped after paging'), { remapSource: true });
    const remappedConfig = JSON.parse(await fs.readFile(path.join(remapped.root, 'qemu-asm.json'), 'utf8'));
    const remappedClient = new Client(core.resolveProject(temporary, remapped.root, remappedConfig, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, qemuArgs: ['-m', '32M'] }));
    clients.push(remappedClient); await exerciseRemappedSource(remappedClient, remapped);
    for (const run of qemus) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null, 'every owned QEMU exits'); }
    assert(qemus.length >= 4);
    console.log('PASS: untrusted reads are rejected, new sessions are isolated and all owned real QEMU processes exit after restart/disconnect');
  } finally {
    for (const client of clients) await client.dispose();
    core.Processes.prototype.start = originalStart;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

module.exports = { Client, exercisePaging, exerciseRemappedSource, until, frame, memory, word, number, ...F };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
