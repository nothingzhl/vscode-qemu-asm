const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timeout waiting for ${description}`);
}
function number(value) {
  const text = String(value).trim();
  const hex = /0x([0-9a-f]+)/i.exec(text);
  return hex ? Number.parseInt(hex[1], 16) : Number(text);
}
function register(variables, name) {
  const item = variables.find(variable => variable.name.toLowerCase() === name);
  assert(item, `Missing ${name} register: ${JSON.stringify(variables)}`);
  const value = number(item.value);
  assert(Number.isSafeInteger(value), `Invalid ${name}: ${item.value}`);
  return value;
}
function lineOf(source, instruction) {
  const line = source.split('\n').findIndex(line => line.trim() === instruction) + 1;
  assert(line > 0, `Sample must contain ${instruction}`);
  return line;
}
function afterLabel(source, label) {
  const lines = source.split('\n');
  let index = lines.findIndex(line => line.trim() === `${label}:`);
  assert(index >= 0, `Sample must contain ${label}`);
  do { index++; } while (index < lines.length && (!lines[index].trim() || lines[index].trim().startsWith(';') || lines[index].trim().endsWith(':')));
  return index + 1;
}

class Client {
  constructor(project) {
    this.seq = 1;
    this.events = [];
    this.pending = new Map();
    this.adapter = new AssemblyDebugAdapter({ getProject: async () => project, isTrusted: () => true, log: text => process.stdout.write(text) });
    this.listener = this.adapter.onDidSendMessage(message => {
      if (message.type === 'event') this.events.push(message);
      if (message.type !== 'response') return;
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timer);
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
    const count = this.events.length;
    await this.request(command, args);
    return (await this.event('stopped', count)).body;
  }
  async launch() {
    await this.request('initialize', { adapterID: 'qemu-asm', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    await this.request('launch', { name: 'Protected-mode OS debug', type: 'qemu-asm', request: 'launch', stopOnEntry: true });
    await this.event('initialized');
    await this.request('configurationDone');
    assert.equal((await this.event('stopped')).body.reason, 'entry');
  }
  async state(stackMemory = false) {
    const trace = await this.request('stackTrace', { threadId: 1 });
    assert(trace.stackFrames.length > 0);
    const frame = trace.stackFrames[0];
    const { scopes } = await this.request('scopes', { frameId: frame.id });
    const registersScope = scopes.find(scope => /register|寄存器/i.test(scope.name));
    assert(registersScope, 'registers scope must be exposed');
    const registers = (await this.request('variables', { variablesReference: registersScope.variablesReference })).variables;
    let memory;
    if (stackMemory) {
      const stackScope = scopes.find(scope => /stack|堆栈|栈/i.test(scope.name));
      assert(stackScope, 'stack memory scope must be exposed');
      memory = (await this.request('variables', { variablesReference: stackScope.variablesReference })).variables;
    }
    return { trace, frame, registers, memory };
  }
  async breakpoints(source, lines) {
    const result = await this.request('setBreakpoints', {
      source: { name: path.basename(source), path: source }, breakpoints: lines.map(line => ({ line })), sourceModified: false
    });
    assert.equal(result.breakpoints.length, lines.length);
    result.breakpoints.forEach((breakpoint, index) => {
      assert.equal(breakpoint.verified, true, JSON.stringify(breakpoint));
      assert.equal(breakpoint.line, lines[index]);
    });
  }
  async disconnect() {
    const count = this.events.length;
    await this.request('disconnect', { restart: false, terminateDebuggee: true });
    await this.event('terminated', count);
  }
  async dispose() {
    await this.adapter.dispose();
    this.listener.dispose();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
  }
}

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu protected 集成, '));
  const projectRoot = path.join(temporary, 'two stages with spaces, and commas');
  const processes = new core.Processes();
  const originalStart = core.Processes.prototype.start;
  const qemus = [], clients = [];
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  try {
    await core.createProject(projectRoot, 'protected');
    const config = JSON.parse(await fs.readFile(path.join(projectRoot, 'qemu-asm.json'), 'utf8'));
    const project = core.resolveProject(temporary, projectRoot, config, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH });
    const stage = path.join(projectRoot, 'stage2.asm');
    const bootText = await fs.readFile(project.source, 'utf8');
    const stageText = await fs.readFile(stage, 'utf8');
    const lines = {
      bootJump: lineOf(bootText, 'jmp 0x0000:0x8000'), stageEntry: lineOf(stageText, 'cli'),
      writeCR0: lineOf(stageText, 'mov cr0, eax'), farJump: lineOf(stageText, 'jmp 0x08:protected_entry'),
      protectedEntry: afterLabel(stageText, 'protected_entry'), setESP: lineOf(stageText, 'mov esp, 0x90000'),
      call: lineOf(stageText, 'call learning_entry'), nested: afterLabel(stageText, 'learning_breakpoint'),
      nestedReturn: lineOf(stageText, 'add esp, 4'), callerReturn: afterLabel(stageText, 'idle')
    };
    const result = await core.build(project, processes, text => process.stdout.write(text));
    const image = await fs.readFile(project.image);
    assert.equal(image.length, 1440 * 1024);
    assert.deepEqual([...image.subarray(510, 512)], [0x55, 0xaa]);
    assert.equal(result.units.length, 2);
    assert.equal(await fs.realpath(result.units[1].source), await fs.realpath(stage));
    assert.equal(result.units[1].lba, 1);
    assert.equal(result.units[1].loadAddress, 0x8000);
    assert(image.subarray(512, 512 + result.units[1].size).includes(Buffer.from(core.PROTECTED_MARKER)));
    console.log('PASS: real NASM assembles boot plus >512-byte stage2 into a signed 1.44MB boot image');

    const client = new Client(project);
    clients.push(client);
    await client.launch();
    assert.equal(await fs.realpath((await client.state()).frame.source.path), await fs.realpath(project.source));
    await client.breakpoints(project.source, [lines.bootJump]);
    await client.breakpoints(stage, [lines.stageEntry]);
    await client.stoppedAfter('continue');
    let state = await client.state();
    assert.equal(await fs.realpath(state.frame.source.path), await fs.realpath(project.source));
    assert.equal(state.frame.line, lines.bootJump, 'a stage2 breakpoint must preserve the boot source breakpoint');
    await client.breakpoints(project.source, []);
    await client.stoppedAfter('continue');
    state = await client.state();
    assert.equal(await fs.realpath(state.frame.source.path), await fs.realpath(stage));
    assert.equal(state.frame.line, lines.stageEntry);
    console.log('PASS: actual BIOS sector loading reaches stage2; breakpoints remain independent for both source files');

    await client.breakpoints(stage, [lines.writeCR0]);
    await client.stoppedAfter('continue');
    state = await client.state();
    assert.equal(state.frame.line, lines.writeCR0);
    assert.equal(register(state.registers, 'cr0') & 1, 0);
    await client.stoppedAfter('stepIn');
    state = await client.state();
    assert.equal(register(state.registers, 'cr0') & 1, 1);
    assert.equal(register(state.registers, 'cs'), 0);
    assert.equal(state.frame.line, lines.farJump, 'CR0.PE must not terminate the still-16-bit transition');
    await client.stoppedAfter('stepIn');
    state = await client.state();
    assert.equal(register(state.registers, 'cs'), 8);
    assert.equal(state.frame.line, lines.protectedEntry, 'far jump must load the 32-bit code segment');
    await client.breakpoints(stage, [lines.setESP]);
    await client.stoppedAfter('continue');
    await client.stoppedAfter('stepIn');
    state = await client.state();
    assert.equal(register(state.registers, 'esp'), 0x90000);
    assert.equal(register(state.registers, 'ds'), 0x10);
    assert.equal(register(state.registers, 'ss'), 0x10);
    console.log('PASS: real CR0.PE transition and far jump keep source stepping alive and expose 32-bit CS/DS/SS/ESP');

    await client.breakpoints(stage, [lines.nested]);
    await client.stoppedAfter('continue');
    state = await client.state(true);
    assert.equal(state.frame.line, lines.nested);
    assert.equal(register(state.registers, 'eax'), 0x11223344);
    assert.equal(register(state.registers, 'ebx'), 0x11223344);
    assert.equal(register(state.registers, 'esp'), 0x8ffec);
    assert.equal(register(state.registers, 'ebp'), 0x8ffec);
    assert(state.trace.stackFrames.length >= 3, '32-bit EBP chain must expose both callers');
    assert.equal(state.trace.stackFrames[1].line, lines.nestedReturn);
    assert.equal(state.trace.stackFrames[2].line, lines.callerReturn);
    assert.equal(number(state.memory[0].value), 0x8fff8, 'SS:ESP must use a 4-byte stack slot');
    assert.equal(number(state.memory[2].value), 0x11223344, 'the pushed EAX must retain all four bytes');
    const memory = await client.request('readMemory', { memoryReference: '0x8fff4', count: 4 });
    assert.equal(Buffer.from(memory.data, 'base64').toString('hex'), '44332211');
    const stackAddress = await client.request('evaluate', { expression: 'ss:esp', frameId: state.frame.id, context: 'watch' });
    assert.equal(number(stackAddress.result), 0x8ffec);
    console.log('PASS: 32-bit registers, four-byte stack slots/readMemory and two real EBP caller frames match CPU memory');

    await client.stoppedAfter('stepOut');
    state = await client.state();
    assert.equal(state.frame.line, lines.nestedReturn);
    assert.equal(register(state.registers, 'esp'), 0x8fff4);
    assert.equal(register(state.registers, 'ebp'), 0x8fff8);
    await client.breakpoints(stage, [lines.callerReturn]);
    await client.stoppedAfter('continue');
    state = await client.state();
    assert.equal(state.frame.line, lines.callerReturn);
    assert.equal(register(state.registers, 'esp'), 0x90000);
    await until(() => client.events.filter(event => event.event === 'output').map(event => event.body.output).join('').includes(core.PROTECTED_MARKER), 'the same live guest serial success marker');
    const beforeRestart = qemus.length;
    await client.stoppedAfter('restart', {});
    state = await client.state();
    assert.equal(await fs.realpath(state.frame.source.path), await fs.realpath(project.source));
    assert.equal(qemus.length, beforeRestart + 1);
    await client.breakpoints(stage, [lines.call]);
    await client.stoppedAfter('continue');
    assert.equal((await client.state()).frame.line, lines.call);
    await client.stoppedAfter('next');
    state = await client.state();
    assert.equal(state.frame.line, lines.callerReturn);
    assert.equal(register(state.registers, 'esp'), 0x90000);
    assert.equal(register(state.registers, 'eax'), 0x11223344);
    await client.disconnect();
    console.log('PASS: stepOut restores a real 32-bit caller; restart and next step over a complete 32-bit CALL');

    // The stock stage lives below 64KiB. Actually execute code above that boundary
    // to prove EIP/source presentation does not silently truncate to 16 bits.
    const highCode = 'mov edi, 0x100000\nmov word [edi], 0xfeeb\njmp 0x08:0x100000';
    assert(stageText.includes('idle:\nhlt\njmp idle'));
    await fs.writeFile(stage, stageText.replace('idle:\nhlt\njmp idle', `idle:\n${highCode}`));
    const high = new Client(project);
    clients.push(high);
    await high.launch();
    await high.request('continue', { threadId: 1 });
    await delay(200);
    await high.stoppedAfter('pause');
    const highState = await high.state();
    assert.equal(register(highState.registers, 'eip'), 0x100000);
    assert.equal(number(highState.frame.instructionPointerReference), 0x100000);
    assert.equal(highState.frame.source, undefined, 'unmapped high memory must not claim a boot source location');
    const evaluated = await high.request('evaluate', { expression: '$eip', frameId: highState.frame.id, context: 'watch' });
    assert.equal(number(evaluated.result), 0x100000);
    await high.disconnect();
    console.log('PASS: a real far jump to 0x100000 preserves full EIP and instruction address without inventing a source line');

    // A custom loader may enter protected mode itself and then load a source
    // unit which starts directly with BITS 32. Exercise that actual boot path.
    const pureStage = `bits 32
org 0x8000
mov ax, 0x10
mov ds, ax
mov es, ax
mov ss, ax
mov esp, 0x90000
xor ebp, ebp
mov eax, 0x55667788
call pure_worker
pure_return:
inc eax
pure_loop:
jmp pure_loop
pure_worker:
push ebp
mov ebp, esp
push eax
mov eax, 0x12345678
pure_breakpoint:
nop
pop ebx
pop ebp
ret
`;
    const loaderTransition = 'lgdt [gdt_descriptor]\nmov eax, cr0\nor eax, 1\nmov cr0, eax\njmp 0x08:0x8000';
    const loaderGDT = 'align 8\ngdt: dq 0\ndq 0x00cf9a000000ffff\ndq 0x00cf92000000ffff\ngdt_end:\ngdt_descriptor: dw gdt_end-gdt-1\ndd gdt\n';
    const pureBoot = bootText.replace('jmp 0x0000:0x8000', loaderTransition).replace('boot_drive db 0', `${loaderGDT}boot_drive db 0`);
    assert.notEqual(pureBoot, bootText);
    await fs.writeFile(project.source, pureBoot);
    await fs.writeFile(stage, pureStage);
    const pure = new Client(project);
    clients.push(pure);
    await pure.launch();
    const pureEntry = lineOf(pureStage, 'mov ax, 0x10');
    const pureBreakpoint = afterLabel(pureStage, 'pure_breakpoint');
    const pureReturn = afterLabel(pureStage, 'pure_return');
    await pure.breakpoints(stage, [pureEntry, pureBreakpoint]);
    await pure.stoppedAfter('continue');
    let pureState = await pure.state();
    assert.equal(await fs.realpath(pureState.frame.source.path), await fs.realpath(stage));
    assert.equal(pureState.frame.line, pureEntry);
    assert.equal(register(pureState.registers, 'cs'), 8);
    await pure.stoppedAfter('stepIn');
    pureState = await pure.state();
    assert.equal(pureState.frame.line, pureEntry + 1);
    assert.equal(register(pureState.registers, 'ax'), 0x10);
    await pure.stoppedAfter('continue');
    pureState = await pure.state(true);
    assert.equal(pureState.frame.line, pureBreakpoint);
    assert.equal(register(pureState.registers, 'eax'), 0x12345678);
    assert.equal(register(pureState.registers, 'esp'), 0x8fff4);
    assert.equal(number(pureState.memory[0].value), 0x55667788);
    assert.equal(pureState.trace.stackFrames[1].line, pureReturn);
    await pure.stoppedAfter('stepOut');
    pureState = await pure.state();
    assert.equal(pureState.frame.line, pureReturn);
    assert.equal(register(pureState.registers, 'ebx'), 0x55667788);
    assert.equal(register(pureState.registers, 'esp'), 0x90000);
    await pure.stoppedAfter('next');
    assert.equal(register((await pure.state()).registers, 'eax'), 0x12345679);
    await pure.stoppedAfter('restart', {});
    await pure.breakpoints(stage, [lineOf(pureStage, 'call pure_worker')]);
    await pure.stoppedAfter('continue');
    await pure.stoppedAfter('next');
    pureState = await pure.state();
    assert.equal(pureState.frame.line, pureReturn);
    assert.equal(register(pureState.registers, 'eax'), 0x12345678);
    assert.equal(register(pureState.registers, 'esp'), 0x90000);
    await pure.disconnect();
    console.log('PASS: a real protected-mode boot loader reaches a pure BITS 32 stage, verifies its source breakpoint and steps its CALL/RET');

    assert(qemus.length >= 5);
    for (const run of qemus) {
      await run.done;
      assert(run.child.exitCode !== null || run.child.signalCode !== null, 'every owned QEMU must exit on restart/disconnect');
    }
    console.log('PASS: all protected-mode QEMU processes exit after restart/disconnect');
  } finally {
    for (const client of clients) await client.dispose();
    await processes.dispose();
    core.Processes.prototype.start = originalStart;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
