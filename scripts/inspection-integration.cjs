const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');
const { parseListing } = require('../dist/debug/listing');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(20); }
  throw new Error(`Timeout waiting for ${description}`);
}
function lineOf(source, instruction) {
  const line = source.split('\n').findIndex(line => line.trim() === instruction) + 1;
  assert(line > 0, `Sample must contain ${instruction}`); return line;
}
function afterLabel(source, label) {
  const lines = source.split('\n'); let index = lines.findIndex(line => line.trim() === `${label}:`);
  assert(index >= 0, `Sample must contain ${label}`);
  do { index++; } while (index < lines.length && (!lines[index].trim() || lines[index].trim().startsWith(';') || lines[index].trim().endsWith(':')));
  return index + 1;
}
function value(expression) { return Number(/0x[0-9a-f]+/i.exec(expression)?.[0] ?? expression); }

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
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`DAP ${command} response timeout`)); }, 25000);
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
    await this.request('launch', { name: 'OS memory and descriptor inspection', type: 'qemu-asm', request: 'launch', stopOnEntry: true });
    await this.event('initialized'); await this.request('configurationDone');
    assert.equal((await this.event('stopped')).body.reason, 'entry');
  }
  async breakpoint(source, line) {
    const result = await this.request('setBreakpoints', { source: { name: path.basename(source), path: source }, breakpoints: line ? [{ line }] : [] });
    if (line) { assert.equal(result.breakpoints[0].verified, true); assert.equal(result.breakpoints[0].line, line); }
  }
  async evaluate(expression) { return value((await this.request('evaluate', { expression, frameId: 1, context: 'watch' })).result); }
  memory(args) { return this.request('qemuAsm.inspectMemory', args); }
  descriptors(args) { return this.request('qemuAsm.inspectDescriptors', args); }
  async disconnect() { const count = this.events.length; await this.request('disconnect', { terminateDebuggee: true }); await this.event('terminated', count); }
  async dispose() { await this.adapter.dispose(); this.listener.dispose(); for (const pending of this.pending.values()) clearTimeout(pending.timer); }
}

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu inspection 实际集成, '));
  const processes = new core.Processes(), qemus = [], clients = [];
  const originalStart = core.Processes.prototype.start;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  function resolve(root) {
    return fs.readFile(path.join(root, 'qemu-asm.json'), 'utf8').then(text => core.resolveProject(temporary, root, JSON.parse(text), {
      nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, qemuArgs: ['-m', '32M']
    }));
  }
  function client(project) { const result = new Client(project); clients.push(result); return result; }
  try {
    const bootRoot = path.join(temporary, 'real16 memory with spaces, and commas');
    await core.createProject(bootRoot);
    const originalSource = await fs.readFile(path.join(bootRoot, 'boot.asm'));
    await assert.rejects(core.createProject(bootRoot));
    assert.deepEqual(await fs.readFile(path.join(bootRoot, 'boot.asm')), originalSource, 'creating a project again must preserve the existing source');
    const boot = client(await resolve(bootRoot));
    await assert.rejects(boot.memory({ address: 0x7c00, count: 1 }), /暂停|停止|stopped/i);
    await boot.launch();
    const memory = await boot.memory({ address: '0x7c00', count: 512 });
    assert.equal(memory.address, 0x7c00); assert.equal(memory.count, 512); assert.equal(memory.mode, 'real16');
    assert.deepEqual(memory.bytes.slice(510), [0x55, 0xaa]);
    assert.equal((await boot.memory({ count: 1 })).address, 0x7c00, 'default address must be the actual instruction address');
    const realStack = await boot.memory({ follow: 'esp', count: 16 });
    assert.equal(realStack.address, await boot.evaluate('ss:sp'));
    const ivt = await boot.descriptors({ table: 'idt', start: 3, count: 1 });
    assert.equal(ivt.format, 'ivt'); assert.equal(ivt.mode, 'real16'); assert.equal(ivt.entrySize, 4);
    assert.equal(ivt.base, 0); assert.equal(ivt.limit, 1023); assert.equal(ivt.totalEntries, 256);
    assert.equal(ivt.entries[0].index, 3);
    const vector = Buffer.from((await boot.memory({ address: 12, count: 4 })).bytes);
    assert.equal(ivt.entries[0].offset, vector.readUInt16LE(0));
    assert.equal(ivt.entries[0].selector, vector.readUInt16LE(2));
    console.log('PASS: actual real16 boot exposes the signed boot sector, SS:SP and BIOS IVT rather than decoding 16-bit vectors as gates');

    for (const args of [{ address: -1 }, { address: 1.5 }, { address: '0x100000000' }, { count: 0 }, { count: 4097 }, { follow: 'eax' }, { address: 0xfffffff0, count: 32 }]) {
      await assert.rejects(boot.memory(args), `Invalid memory request must fail: ${JSON.stringify(args)}`);
    }
    for (const args of [{ table: 'ldt' }, { table: 'gdt', start: -1 }, { table: 'gdt', start: 1.5 }, { table: 'idt', count: 0 }, { table: 'idt', count: 129 }]) {
      await assert.rejects(boot.descriptors(args), `Invalid descriptor request must fail: ${JSON.stringify(args)}`);
    }
    boot.trusted = false;
    await assert.rejects(boot.memory({ address: 0, count: 1 }), /信任|trust/i);
    await assert.rejects(boot.descriptors({ table: 'idt' }), /信任|trust/i);
    boot.trusted = true;
    await boot.request('continue', { threadId: 1 });
    await assert.rejects(boot.memory({ address: 0, count: 1 }), /暂停|停止|stopped/i);
    await assert.rejects(boot.descriptors({ table: 'idt' }), /暂停|停止|stopped/i);
    await boot.stoppedAfter('pause'); await boot.disconnect();
    await assert.rejects(boot.memory({ address: 0, count: 1 }), /暂停|停止|stopped|结束/i);
    console.log('PASS: invalid ranges/counts/tables, lost Workspace Trust, running CPU and ended sessions cannot read guest state');

    const protectedRoot = path.join(temporary, 'protected32 inspector project');
    await core.createProject(protectedRoot, 'protected');
    const project = await resolve(protectedRoot), stage = path.join(protectedRoot, 'stage2.asm');
    const source = await fs.readFile(stage, 'utf8');
    const listing = path.join(temporary, 'inspection.lst');
    const built = await core.build(project, processes, text => process.stdout.write(text), undefined, listing);
    const unit = built.units[1];
    const map = parseListing(await fs.readFile(unit.listingPath, 'utf8'), stage, source, { loadAddress: unit.loadAddress, maxBytes: unit.size });
    const handler = map.forLine(afterLabel(source, 'inspection_handler'));
    const increment = map.forLine(lineOf(source, 'inc dword [inspection_data+8]'));
    assert(handler && increment, 'the actual NASM listing must contain the inspector lesson instructions');
    const protectedClient = client(project); await protectedClient.launch();
    await protectedClient.breakpoint(stage, afterLabel(source, 'inspection_ready'));
    await protectedClient.stoppedAfter('continue');
    const gdt = await protectedClient.descriptors({ table: 'gdt', count: 64 });
    assert.equal(gdt.format, 'gdt'); assert.equal(gdt.mode, 'protected32'); assert.equal(gdt.limit, 23);
    assert.equal(gdt.entrySize, 8); assert.equal(gdt.totalEntries, 3); assert.equal(gdt.entries.length, 3);
    for (const index of [1, 2]) {
      const segment = gdt.entries[index];
      assert.equal(segment.selector, index * 8); assert.equal(segment.base, 0); assert.equal(segment.effectiveLimit, 0xffffffff);
      assert.equal(segment.defaultBits, 32); assert.equal(segment.present, true); assert.equal(segment.dpl, 0);
    }
    assert(gdt.entries[1].registers.includes('CS'));
    assert(gdt.entries[2].registers.includes('SS'));
    assert.equal(gdt.entries[1].code, true); assert.equal(gdt.entries[2].writable, true);
    const idt = await protectedClient.descriptors({ table: 'idt', count: 64 });
    assert.equal(idt.format, 'idt'); assert.equal(idt.limit, 31); assert.equal(idt.entrySize, 8); assert.equal(idt.totalEntries, 4);
    const gate = idt.entries[3];
    assert.equal(gate.index, 3); assert.equal(gate.present, true); assert.equal(gate.selector, 8);
    assert.equal(gate.offset, handler.address); assert.equal(gate.gateBits, 32); assert.equal(gate.dpl, 0);
    const gateBytes = Buffer.from((await protectedClient.memory({ address: idt.base + 24, count: 8 })).bytes);
    assert.equal(gateBytes[5], 0x8e); assert.equal(gateBytes.readUInt16LE(2), 8);
    assert.equal((gateBytes.readUInt16LE(0) + gateBytes.readUInt16LE(6) * 0x10000) >>> 0, gate.offset);
    assert.deepEqual((await protectedClient.descriptors({ table: 'gdt', start: 3, count: 64 })).entries, []);
    const page = await protectedClient.descriptors({ table: 'gdt', start: 2, count: 64 });
    assert.equal(page.entries.length, 1); assert.equal(page.entries[0].index, 2);
    console.log('PASS: actual LGDT/LIDT registers and guest bytes decode flat 4GB CS/SS descriptors, loaded selectors and vector 3 interrupt gate; pages stop at the table limit');

    await protectedClient.breakpoint(stage, lineOf(source, 'push eax'));
    await protectedClient.stoppedAfter('continue');
    const beforePush = await protectedClient.memory({ follow: 'esp', count: 16 });
    assert.equal(beforePush.address, 0x8fff8);
    await protectedClient.stoppedAfter('stepIn');
    const afterPush = await protectedClient.memory({ follow: 'esp', count: 16 });
    assert.equal(afterPush.address, beforePush.address - 4, 'follow must update its address when PUSH changes ESP');
    assert.equal(Buffer.from(afterPush.bytes).readUInt32LE(0), 0x11223344);
    assert.equal((await protectedClient.memory({ follow: 'ebp', count: 16 })).address, beforePush.address, 'PUSH must not move EBP follow');
    await protectedClient.breakpoint(stage, afterLabel(source, 'learning_breakpoint'));
    await protectedClient.stoppedAfter('continue');
    const stack = await protectedClient.memory({ follow: 'esp', count: 16 });
    assert.equal(stack.address, 0x8ffec); assert.equal(stack.follow, 'esp'); assert.equal(stack.registers.esp, 0x8ffec);
    assert.equal(Buffer.from(stack.bytes).readUInt32LE(8), 0x11223344);
    assert.equal((await protectedClient.memory({ follow: 'ebp', count: 16 })).address, stack.address);
    const instruction = Buffer.from((await protectedClient.memory({ address: increment.address, count: increment.size })).bytes);
    assert.deepEqual([...instruction.subarray(0, 2)], [0xff, 0x05]);
    const changedAddress = instruction.readUInt32LE(2), dataAddress = changedAddress - 8;
    const before = await protectedClient.memory({ address: dataAddress, count: 12 });
    assert.equal(Buffer.from(before.bytes).toString('hex'), '443322118877665500000000');
    await protectedClient.stoppedAfter('stepIn'); // NOP: no guest data changed.
    assert.deepEqual((await protectedClient.memory({ address: dataAddress, count: 12 })).bytes, before.bytes);
    await protectedClient.stoppedAfter('stepIn'); // INC writes actual guest RAM.
    const after = await protectedClient.memory({ address: dataAddress, count: 12 });
    assert.deepEqual(after.bytes.slice(0, 8), before.bytes.slice(0, 8));
    assert.equal(Buffer.from(after.bytes).readUInt32LE(8), 1);
    const changed = after.bytes.flatMap((byte, index) => byte === before.bytes[index] ? [] : [dataAddress + index]);
    assert.deepEqual(changed, [changedAddress]);
    const previous = qemus.length; await protectedClient.stoppedAfter('restart', {});
    assert.equal(qemus.length, previous + 1); assert.equal((await protectedClient.memory({ count: 1 })).address, 0x7c00);
    await protectedClient.breakpoint(stage, afterLabel(source, 'learning_breakpoint'));
    await protectedClient.stoppedAfter('continue');
    assert.equal(Buffer.from((await protectedClient.memory({ address: changedAddress, count: 4 })).bytes).readUInt32LE(0), 0, 'restart must rebuild and load fresh RAM');
    await protectedClient.disconnect();
    console.log('PASS: ESP/EBP follow actual stack RAM, single-stepping INC changes exactly one byte and restart restores the initial lesson data');

    // A separate real guest checks that follow does not truncate ESP/EBP or
    // forget the hidden SS cache. DS stays flat while SS selects a 1MiB base.
    const shifted = source.replace('gdt_end:', 'dq 0x00cf92100000ffff\ngdt_end:')
      .replace('mov ss, ax', 'mov ax, 0x18\nmov ss, ax')
      .replace('mov esp, 0x90000', 'mov esp, 0x180000');
    assert.notEqual(shifted, source); await fs.writeFile(stage, shifted);
    const shiftedClient = client(project); await shiftedClient.launch();
    await shiftedClient.breakpoint(stage, afterLabel(shifted, 'learning_breakpoint'));
    await shiftedClient.stoppedAfter('continue');
    for (const follow of ['esp', 'ebp']) {
      const followed = await shiftedClient.memory({ follow, count: 16 });
      assert.equal(followed.address, 0x27ffec); assert.equal(followed.registers.ss, 0x18);
      assert.equal(followed.registers[follow], 0x17ffec); assert.equal(followed.registers.ss_base, 0x100000);
      assert.equal(Buffer.from(followed.bytes).readUInt32LE(8), 0x11223344);
    }
    const shiftedGDT = await shiftedClient.descriptors({ table: 'gdt' });
    assert.equal(shiftedGDT.entries[3].base, 0x100000); assert(shiftedGDT.entries[3].registers.includes('SS'));
    await shiftedClient.disconnect();
    for (const run of qemus) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null); }
    console.log('PASS: a real nonzero SS.base plus >64KiB ESP/EBP resolves the complete 0x27ffec stack address; all owned QEMU processes exit');
  } finally {
    for (const current of clients) await current.dispose();
    await processes.dispose(); core.Processes.prototype.start = originalStart;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
