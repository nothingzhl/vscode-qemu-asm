// External-toolchain proof only. This does not add a C project format or DWARF
// parser to the extension: the test loader embeds the linked .text as raw data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const core = require('../dist/core');
const F = require('./paging-integration.cjs');
const hex = value => `0x${value.toString(16)}`;
const source = `unsigned calculate(unsigned value);
void kernel_main(void) {
  volatile unsigned *output = (volatile unsigned *)0xc0100000;
  *output = calculate(41);
  for (;;) __asm__ volatile("pause");
}
__attribute__((noinline)) unsigned calculate(unsigned value) { return value + 1; }
`;
async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu C machine proof '));
  let client;
  const owned = [], start = core.Processes.prototype.start;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = start.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) owned.push(run);
    return run;
  };
  try {
    const c = path.join(temporary, 'kernel.c'), object = path.join(temporary, 'kernel.o');
    const elf = path.join(temporary, 'kernel.elf'), binary = path.join(temporary, 'kernel.bin');
    await fs.writeFile(c, source);
    await execute(process.env.CC_PATH || 'gcc', ['-m32', '-ffreestanding', '-fno-pie', '-fno-pic', '-fno-stack-protector',
      '-fno-asynchronous-unwind-tables', '-fno-unwind-tables', '-fno-omit-frame-pointer', '-O0', '-g', '-c', c, '-o', object], { timeout: 15000 });
    await execute(process.env.LD_PATH || 'ld', ['-m', 'elf_i386', '-Ttext', hex(F.HIGH_CODE), '-e', 'kernel_main', '--build-id=none', object, '-o', elf], { timeout: 15000 });
    await execute(process.env.OBJCOPY_PATH || 'objcopy', ['-O', 'binary', '-j', '.text', elf, binary], { timeout: 15000 });
    const image = await fs.readFile(elf), bytes = await fs.readFile(binary);
    assert.equal(image.readUInt32LE(0), 0x464c457f);
    assert(image.includes(Buffer.from('.debug_info')), 'external GCC output really contains debug data, which the plugin does not yet consume');
    const entry = image.readUInt32LE(24);
    assert(entry >= F.HIGH_CODE && entry < F.HIGH_CODE + bytes.length);
    const fixture = await F.fixture(path.join(temporary, 'externally compiled C guest'));
    const replacement = `payload:\ndb ${[...bytes].map(byte => hex(byte)).join(',')}\npayload_end:`;
    const firmware = fixture.text.replace(/payload:\n[\s\S]*?\npayload_end:/, replacement)
      .replace('jmp 0x08:0xc0000000', `jmp 0x08:${hex(entry)}`);
    await fs.writeFile(fixture.source, firmware);
    const config = JSON.parse(await fs.readFile(path.join(fixture.root, 'qemu-asm.json'), 'utf8'));
    const project = core.resolveProject(temporary, fixture.root, config, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH, qemuArgs: ['-m', '32M'] });
    client = new F.Client(project);
    await client.launch();
    const cLines = await client.request('setBreakpoints', { source: { path: c }, breakpoints: [{ line: 4 }] });
    assert.equal(cLines.breakpoints[0].verified, false, 'C source lines must not pretend to be implemented');
    const set = address => client.request('setInstructionBreakpoints', { breakpoints: [{ instructionReference: hex(address) }] });
    await set(entry); await client.stoppedAfter('continue');
    let frame = await F.frame(client);
    assert.equal(F.number(frame.instructionPointerReference), entry);
    assert.equal(frame.source, undefined);
    const walk = await client.request('qemuAsm.inspectPaging', { address: entry });
    assert.equal(walk.physicalAddress, F.CODE_PHYSICAL + entry - F.HIGH_CODE);
    const decoded = await client.request('qemuAsm.disassemble', { address: entry, count: 24 });
    const call = decoded.instructions.find(instruction => /^call\b/i.test(instruction.instruction));
    assert(call, 'live decoder must see the actual GCC function call');
    await set(F.number(call.address)); await client.stoppedAfter('continue');
    const sp = F.number((await client.request('evaluate', { expression: 'esp' })).result);
    await client.stoppedAfter('next');
    frame = await F.frame(client);
    assert.equal(F.number(frame.instructionPointerReference), F.number(call.address) + call.size, 'F10 executes GCC CALL and RET');
    assert.equal(F.number((await client.request('evaluate', { expression: 'eax' })).result), 42);
    assert.equal(F.number((await client.request('evaluate', { expression: 'esp' })).result), sp);
    const points = await client.request('qemuAsm.watchpoints', { action: 'add', address: F.HIGH_DATA, size: 4, access: 'write' });
    const point = points.breakpoints[0]; assert(point.verified);
    const stop = await client.stoppedAfter('continue');
    assert.equal(stop.reason, 'data breakpoint'); assert(stop.hitBreakpointIds.includes(point.id));
    assert.equal(await F.word(client, F.HIGH_DATA), 42);
    assert.equal(await F.word(client, F.DATA_PHYSICAL, 'physical'), 42);
    assert.equal((await F.frame(client)).source, undefined);
    await client.disconnect();
    assert.equal(owned.length, 1);
    for (const run of owned) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null); }
    console.log('PASS: actual GCC -m32 freestanding C after nonidentity paging; live disassembly/address breakpoint/F10 CALL-RET/EAX=42/virtual write watchpoint/physical RAM=42; C source line correctly unverified; owned QEMU exited');
  } finally {
    if (client) await client.dispose();
    core.Processes.prototype.start = start;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
