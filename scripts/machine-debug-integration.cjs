const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');

const HIGH_CODE = 0x100000;
const HIGH_WRITE = HIGH_CODE + 9;
const HIGH_READ = HIGH_CODE + 11;
const HIGH_AFTER_READ = HIGH_CODE + 13;
const HIGH_DATA = 0x110000;
const HEX = value => `0x${value.toString(16)}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(20); }
  throw new Error(`Timeout waiting for ${description}`);
}
function number(value) { return Number(/0x[0-9a-f]+/i.exec(String(value))?.[0] ?? value); }
function lineOf(source, instruction) {
  const line = source.split('\n').findIndex(line => line.trim() === instruction) + 1;
  assert(line > 0, `Missing fixture instruction ${instruction}`); return line;
}

// These programs exist only in disposable integration workspaces. In particular,
// the copied DB payload has no NASM instruction/source mapping at 0x100000.
const realSource = `bits 16
org 0x7c00
cli
xor ax, ax
mov ds, ax
mov ss, ax
mov sp, 0x7c00
mov bx, 0x7000
mov word [bx], 0
real_ready:
nop
mov eax, 0x11223344
real_write:
inc word [bx]
real_read:
mov ax, [bx]
jmp real_write
times 510-($-$$) db 0
dw 0xaa55
`;
const protectedSource = `bits 16
org 0x8000
cli
xor ax, ax
mov ds, ax
lgdt [gdt_pointer]
mov eax, cr0
or eax, 1
mov cr0, eax
jmp 0x08:protected_entry
align 8
gdt: dq 0
dq 0x00cf9a000000ffff
dq 0x00cf92000000ffff
gdt_end:
gdt_pointer: dw gdt_end-gdt-1
dd gdt
bits 32
protected_entry:
mov ax, 0x10
mov ds, ax
mov es, ax
mov ss, ax
mov esp, 0x90000
xor ebp, ebp
cld
mov esi, payload
mov edi, 0x100000
mov ecx, payload_end-payload
rep movsb
mov edi, 0x110000
mov dword [edi], 0
source_before_high:
nop
jmp 0x08:0x100000
payload:
db 0x66,0xb8,0x34,0x12
db 0xb8,0x44,0x33,0x22,0x11
db 0xff,0x07
db 0x8b,0x07
db 0x90
db 0xeb,0xf9
payload_end:
times 1024-($-$$) db 0
`;

async function fixture(root, mode) {
  await core.createProject(root, mode === 'real16' ? 'boot' : 'protected');
  const source = path.join(root, mode === 'real16' ? 'boot.asm' : 'stage2.asm');
  const text = mode === 'real16' ? realSource : protectedSource;
  await fs.writeFile(source, text);
  return { root, source, text, line: instruction => lineOf(text, instruction) };
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
    const capabilities = await this.request('initialize', { adapterID: 'qemu-asm', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    for (const name of ['supportsDisassembleRequest', 'supportsInstructionBreakpoints', 'supportsDataBreakpoints']) assert.equal(capabilities[name], true, name);
    await this.request('launch', { name: 'Machine debugging actual QEMU integration', type: 'qemu-asm', request: 'launch', stopOnEntry: true });
    await this.event('initialized'); await this.request('configurationDone');
    assert.equal((await this.event('stopped')).body.reason, 'entry');
  }
  async disconnect() { const count = this.events.length; await this.request('disconnect', { terminateDebuggee: true }); await this.event('terminated', count); }
  async dispose() { await this.adapter.dispose(); this.listener.dispose(); for (const pending of this.pending.values()) clearTimeout(pending.timer); }
}

async function frame(client) { return (await client.request('stackTrace', { threadId: 1 })).stackFrames[0]; }
async function evaluate(client, expression) { return number((await client.request('evaluate', { expression, frameId: 1, context: 'watch' })).result); }
async function word(client, address, size) {
  const memory = await client.request('readMemory', { memoryReference: HEX(address), count: size });
  const bytes = Buffer.from(memory.data, 'base64');
  return size === 2 ? bytes.readUInt16LE(0) : bytes.readUInt32LE(0);
}
async function sourceBreakpoints(client, source, lines) {
  const result = await client.request('setBreakpoints', { source: { path: source, name: path.basename(source) }, breakpoints: lines.map(line => ({ line })) });
  result.breakpoints.forEach((breakpoint, index) => { assert.equal(breakpoint.verified, true, JSON.stringify(breakpoint)); assert.equal(breakpoint.line, lines[index]); });
  return result.breakpoints;
}
async function instructionBreakpoints(client, addresses) {
  const result = await client.request('setInstructionBreakpoints', { breakpoints: addresses.map(address => ({ instructionReference: HEX(address) })) });
  assert.equal(result.breakpoints.length, addresses.length);
  result.breakpoints.forEach(breakpoint => assert.equal(breakpoint.verified, true, JSON.stringify(breakpoint)));
  return result.breakpoints;
}
async function watch(client, args) { return client.request('qemuAsm.watchpoints', args); }
function hit(stop, id) {
  assert.equal(stop.reason, 'data breakpoint', JSON.stringify(stop));
  assert(stop.hitBreakpointIds?.includes(id), `Data stop must identify watchpoint ${id}: ${JSON.stringify(stop)}`);
}
function instruction(result, address) {
  const item = result.instructions.find(item => number(item.address) === address);
  assert(item, `Missing instruction at ${HEX(address)}: ${JSON.stringify(result)}`); return item;
}

async function exerciseReal(client, project) {
  await client.launch();
  const disassembled = await client.request('qemuAsm.disassemble', { address: 0x7c00, count: 32 });
  assert.equal(disassembled.mode, 'real16'); assert.equal(disassembled.bits, 16);
  assert.match(disassembled.instructions[0].instruction, /cli/i);
  const prefixed = disassembled.instructions.find(item => /mov\s+eax\b/i.test(item.instruction));
  assert(prefixed, 'real16 decoding must honor the operand-size override');
  assert.equal(prefixed.instructionBytes.replace(/\s/g, '').toLowerCase(), '66b844332211');
  const writeLine = project.line('inc word [bx]');
  await sourceBreakpoints(client, project.source, [writeLine]);
  const custom = await watch(client, { action: 'add', address: 0x7000, size: 2, access: 'write' });
  const breakpoint = custom.breakpoints.find(item => item.address === 0x7000);
  assert.equal(breakpoint?.verified, true, JSON.stringify(custom));
  // Its initialization is a real write too, so install after reaching the source BP.
  await watch(client, { action: 'remove', id: breakpoint.id });
  await client.stoppedAfter('continue');
  assert.equal((await frame(client)).line, writeLine);
  const installed = await watch(client, { action: 'add', address: 0x7000, size: 2, access: 'write' });
  const active = installed.breakpoints.find(item => item.address === 0x7000);
  hit(await client.stoppedAfter('stepIn'), active.id);
  assert.equal(await word(client, 0x7000, 2), 1);
  assert.equal((await frame(client)).line, project.line('mov ax, [bx]'));
  const last = await watch(client, { action: 'list' });
  assert.equal(last.lastHit.address, 0x7000); assert.equal(last.lastHit.access, 'write');
  await watch(client, { action: 'clear' }); await sourceBreakpoints(client, project.source, []);
  await client.request('continue', { threadId: 1 });
  await assert.rejects(client.request('qemuAsm.disassemble', { count: 1 }), /暂停|停止|stopped/i);
  await client.stoppedAfter('pause');
  await client.disconnect();
  console.log('PASS: actual real16 instruction decoding honors 66; stepping INC at a source breakpoint reports the matching write watchpoint and real RAM value');
}

async function exerciseProtected(client, project, ui) {
  await client.launch();
  const sourceLine = project.line('nop');
  await sourceBreakpoints(client, project.source, [sourceLine]);
  const native = await instructionBreakpoints(client, [HIGH_WRITE, HIGH_READ]);
  await client.stoppedAfter('continue');
  assert.equal((await frame(client)).line, sourceLine, 'source breakpoints must survive native instruction breakpoint installation');
  const addressStop = await client.stoppedAfter('continue');
  let current = await frame(client);
  assert.equal(number(current.instructionPointerReference), HIGH_WRITE);
  assert(addressStop.hitBreakpointIds?.includes(native[0].id), 'native instruction stop must identify its configured breakpoint');
  assert.equal(current.source, undefined, 'unmapped high memory must not invent a NASM source location');
  assert.equal(await evaluate(client, 'eax'), 0x11223344);
  const custom = await client.request('qemuAsm.disassemble', { address: HIGH_CODE, count: 7 });
  assert.equal(custom.mode, 'protected32'); assert.equal(custom.bits, 32); assert.equal(custom.pc, HIGH_WRITE);
  assert.match(instruction(custom, HIGH_CODE).instruction, /mov\s+ax\b/i);
  assert.equal(instruction(custom, HIGH_CODE).instructionBytes.replace(/\s/g, '').toLowerCase(), '66b83412');
  assert.match(instruction(custom, HIGH_CODE + 4).instruction, /mov\s+eax\b/i);
  assert.match(instruction(custom, HIGH_WRITE).instruction, /inc.*\[edi\]/i);
  const dap = await client.request('disassemble', { memoryReference: HEX(HIGH_CODE), offset: 4, instructionOffset: 1, instructionCount: 3 });
  assert.equal(dap.instructions.length, 3);
  assert.equal(number(dap.instructions[0].address), HIGH_WRITE);
  assert.equal(dap.instructions[0].instructionBytes.replace(/\s/g, '').toLowerCase(), 'ff07');
  const stop = await client.stoppedAfter('continue');
  assert.equal(number((await frame(client)).instructionPointerReference), HIGH_READ);
  assert.equal(await word(client, HIGH_DATA, 4), 1);
  assert(stop.hitBreakpointIds?.includes(native[1].id), 'second native instruction stop must identify its configured breakpoint');
  let owned = await client.request('qemuAsm.instructionBreakpoints', { action: 'add', address: HIGH_WRITE });
  assert.equal(owned.breakpoints.find(item => item.address === HIGH_WRITE)?.origin, 'both');
  await instructionBreakpoints(client, []);
  owned = await client.request('qemuAsm.instructionBreakpoints', { action: 'list' });
  assert.equal(owned.breakpoints.find(item => item.address === HIGH_WRITE)?.origin, 'custom');
  await client.stoppedAfter('continue');
  assert.equal(number((await frame(client)).instructionPointerReference), HIGH_WRITE, 'removing native breakpoints must retain the same custom-owned address breakpoint');
  assert.equal(await word(client, HIGH_DATA, 4), 1);
  await client.request('qemuAsm.instructionBreakpoints', { action: 'clear' });
  console.log('PASS: actual copied code at 0x100000 has no source mapping; native address breakpoints coexist with source breakpoints and 32-bit disassembly decodes live bytes plus DAP offsets');

  const info = await client.request('dataBreakpointInfo', { name: HEX(HIGH_DATA), memoryReference: HEX(HIGH_DATA), bytes: 4 });
  assert.equal(typeof info.dataId, 'string'); assert(info.dataId.length > 0); assert.equal(info.canPersist, true);
  assert.deepEqual(new Set(info.accessTypes), new Set(['read', 'write', 'readWrite']));
  const configured = await client.request('setDataBreakpoints', { breakpoints: [{ dataId: info.dataId, accessType: 'write' }] });
  assert.equal(configured.breakpoints[0].verified, true, JSON.stringify(configured));
  hit(await client.stoppedAfter('continue'), configured.breakpoints[0].id);
  assert.equal(await word(client, HIGH_DATA, 4), 2);
  assert.equal(number((await frame(client)).instructionPointerReference), HIGH_READ);
  const shared = await watch(client, { action: 'add', address: HIGH_DATA, size: 4, access: 'write' });
  assert.equal(shared.breakpoints.find(item => item.address === HIGH_DATA)?.origin, 'both');
  await client.request('setDataBreakpoints', { breakpoints: [] });
  const retained = await watch(client, { action: 'list' });
  assert.equal(retained.breakpoints.find(item => item.address === HIGH_DATA)?.origin, 'custom');
  await watch(client, { action: 'clear' });
  assert.deepEqual((await watch(client, { action: 'list' })).breakpoints, []);

  let installed = await watch(client, { action: 'add', address: HIGH_DATA, size: 4, access: 'read' });
  let active = installed.breakpoints.find(item => item.address === HIGH_DATA);
  assert.equal(active.verified, true, JSON.stringify(installed));
  hit(await client.stoppedAfter('continue'), active.id);
  assert.equal(number((await frame(client)).instructionPointerReference), HIGH_AFTER_READ);
  assert.equal(await evaluate(client, 'eax'), 2);
  let listed = await watch(client, { action: 'list' });
  assert.equal(listed.lastHit.address, HIGH_DATA); assert.equal(listed.lastHit.access, 'read');
  hit(await client.stoppedAfter('continue'), active.id);
  assert.equal(number((await frame(client)).instructionPointerReference), HIGH_READ, 'a read watchpoint must also catch INC read-modify-write');
  assert.equal(await word(client, HIGH_DATA, 4), 3);
  hit(await client.stoppedAfter('continue'), active.id);
  assert.equal(await evaluate(client, 'eax'), 3, 'resuming a watchpoint must execute through its next iteration');
  await watch(client, { action: 'clear' });
  installed = await watch(client, { action: 'add', address: HIGH_DATA, size: 4, access: 'readWrite' });
  active = installed.breakpoints.find(item => item.address === HIGH_DATA);
  hit(await client.stoppedAfter('continue'), active.id);
  assert.equal(await word(client, HIGH_DATA, 4), 4);
  assert.equal((await watch(client, { action: 'list' })).lastHit.access, 'readWrite', 'QEMU awatch reports either access without claiming a specific operation');
  hit(await client.stoppedAfter('stepIn'), active.id);
  assert.equal(number((await frame(client)).instructionPointerReference), HIGH_AFTER_READ);
  listed = await watch(client, { action: 'list' });
  assert.equal(listed.lastHit.access, 'readWrite'); assert.equal(await evaluate(client, 'eax'), 4);
  console.log('PASS: actual native write, custom read and access watchpoints stop on INC/MOV memory operations, report matching IDs/access, and retrigger after continue or step');

  if (ui) await ui({ project, frame: await frame(client), disassembly: await client.request('qemuAsm.disassemble', { address: HIGH_CODE, count: 7 }), watchpoints: listed });

  await instructionBreakpoints(client, [HIGH_WRITE]);
  await client.stoppedAfter('restart', {});
  listed = await watch(client, { action: 'list' });
  assert(listed.breakpoints.some(item => item.id === active.id), 'restart must preserve configured data breakpoints');
  assert.equal(listed.lastHit, undefined, 'restart must clear the previous CPU hit');
  await watch(client, { action: 'clear' });
  await client.stoppedAfter('continue');
  assert.equal((await frame(client)).line, sourceLine, 'restart must preserve source breakpoints');
  await sourceBreakpoints(client, project.source, []);
  await client.stoppedAfter('continue');
  assert.equal(number((await frame(client)).instructionPointerReference), HIGH_WRITE, 'restart must preserve instruction breakpoints');
  await instructionBreakpoints(client, []);
  await client.disconnect();
  console.log('PASS: restart preserves source/address/data breakpoint configurations, clears stale watchpoint-hit state and rebuilds the real guest');
}

async function exerciseUnmappedCall(client) {
  await client.launch();
  await instructionBreakpoints(client, [HIGH_CODE + 5]);
  await client.stoppedAfter('continue');
  let current = await frame(client);
  assert.equal(number(current.instructionPointerReference), HIGH_CODE + 5);
  assert.equal(current.source, undefined, 'the copied CALL must have no source listing entry');
  assert.equal(await evaluate(client, 'eax'), 0x40);
  assert.equal(await evaluate(client, 'esp'), 0x90000);
  const decoded = await client.request('qemuAsm.disassemble', { address: HIGH_CODE + 5, count: 1 });
  assert.match(decoded.instructions[0].instruction, /^call\b/i);
  assert.equal(decoded.instructions[0].size, 5);
  const stop = await client.stoppedAfter('next');
  assert.equal(stop.reason, 'step');
  current = await frame(client);
  assert.equal(number(current.instructionPointerReference), HIGH_CODE + 10, 'F10 must stop after the copied CALL instead of entering its handler');
  assert.equal(current.source, undefined);
  assert.equal(await evaluate(client, 'eax'), 0x41, 'F10 must execute the actual INC inside the handler');
  assert.equal(await evaluate(client, 'esp'), 0x90000, 'the actual RET must restore the original stack pointer');
  await client.disconnect();
  console.log('PASS: F10 disassembles a source-independent E8 CALL at 0x100005, executes its real INC/RET and stops at 0x10000a with ESP restored');
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu machine debug 实际集成, '));
  const clients = [], qemus = [];
  const originalStart = core.Processes.prototype.start;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  async function client(project) {
    const config = JSON.parse(await fs.readFile(path.join(project.root, 'qemu-asm.json'), 'utf8'));
    const result = new Client(core.resolveProject(temporary, project.root, config, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, qemuArgs: ['-m', '32M'] }));
    clients.push(result); return result;
  }
  try {
    const real = await fixture(path.join(temporary, 'real16 with spaces, and commas'), 'real16');
    const realClient = await client(real);
    await assert.rejects(realClient.request('qemuAsm.disassemble', { count: 1 }), /暂停|停止|stopped/i);
    await exerciseReal(realClient, real);
    const protectedProject = await fixture(path.join(temporary, 'protected32 with spaces, and commas'), 'protected32');
    const protectedClient = await client(protectedProject);
    await exerciseProtected(protectedClient, protectedProject);
    const callProject = await fixture(path.join(temporary, 'unmapped CALL step-over with spaces'), 'protected32');
    const callPayload = `payload:
db 0xb8,0x40,0,0,0
db 0xe8,0x03,0,0,0
db 0x90
db 0xeb,0xfe
db 0x40,0xc3
payload_end:`;
    const callSource = callProject.text.replace(/payload:\n[\s\S]*?\npayload_end:/, callPayload);
    assert.notEqual(callSource, callProject.text);
    await fs.writeFile(callProject.source, callSource);
    await exerciseUnmappedCall(await client(callProject));
    const fresh = await client(protectedProject); await fresh.launch();
    assert.deepEqual((await watch(fresh, { action: 'list' })).breakpoints, [], 'a fresh session must not inherit a prior adapter configuration');
    for (const args of [{ count: 0 }, { address: -1 }, { address: '0x100000000' }]) await assert.rejects(fresh.request('qemuAsm.disassemble', args));
    fresh.trusted = false;
    await assert.rejects(fresh.request('qemuAsm.disassemble', { count: 1 }), /信任|trust/i);
    await assert.rejects(watch(fresh, { action: 'add', address: HIGH_DATA, size: 4, access: 'write' }), /信任|trust/i);
    fresh.trusted = true; await fresh.disconnect();
    for (const run of qemus) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null, 'all owned QEMU processes must exit'); }
    assert(qemus.length >= 5);
    console.log('PASS: fresh sessions are isolated, invalid/untrusted/running inspection requests are rejected, and every real QEMU exits after restart/disconnect');
  } finally {
    for (const client of clients) await client.dispose();
    core.Processes.prototype.start = originalStart;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

module.exports = { fixture, exerciseReal, exerciseProtected, until, HIGH_CODE, HIGH_WRITE, HIGH_READ, HIGH_DATA, frame };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
