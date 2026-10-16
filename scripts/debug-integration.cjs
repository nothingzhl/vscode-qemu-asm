const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');

const assembly = `bits 16
org 0x7c00
start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7c00
    xor bp, bp
    mov ax, 0x1111
    call routine
after_call:
    inc ax
hang:
    jmp hang
routine:
    push bp
    mov bp, sp
    push ax
    mov ax, 0x1234
    inc ax
    pop bx
    pop bp
    ret
times 510-($-$$) db 0
dw 0xaa55
`;
const lineOf = instruction => assembly.split('\n').indexOf(instruction) + 1;
const entryLine = lineOf('    cli');
const routineLine = lineOf('    mov ax, 0x1234');
const callLine = lineOf('    call routine');
const returnLine = assembly.split('\n').indexOf('after_call:') + 2;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timeout waiting for ${description}`);
}
function number(value) {
  const text = String(value).trim();
  const hex = /0x([0-9a-f]+)/i.exec(text);
  if (hex) return Number.parseInt(hex[1], 16);
  if (/^[0-9]+$/.test(text)) return Number(text);
  if (/^[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  return NaN;
}
function register(variables, name) {
  const item = variables.find(variable => [name, `e${name}`].includes(variable.name.toLowerCase()));
  assert(item, `Missing ${name} register`);
  assert(Number.isFinite(number(item.value)), `Invalid ${name} value: ${item.value}`);
  return number(item.value) & 0xffff;
}

class Client {
  constructor(project) {
    this.seq = 1;
    this.events = [];
    this.pending = new Map();
    this.adapter = new AssemblyDebugAdapter({ getProject: async () => project, isTrusted: () => true, log: text => process.stdout.write(text) });
    this.listener = this.adapter.onDidSendMessage(message => {
      if (message.type === 'event') this.events.push(message);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (!pending) return;
        this.pending.delete(message.request_seq);
        clearTimeout(pending.timer);
        if (message.success) pending.resolve(message.body || {});
        else pending.reject(new Error(`${message.command}: ${message.message || JSON.stringify(message.body)}`));
      }
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
    const response = await this.request(command, args);
    const stopped = await this.event('stopped', count);
    return { response, stopped: stopped.body };
  }
  async launch() {
    await this.request('initialize', { adapterID: 'qemu-asm', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path' });
    await this.request('launch', { name: 'OS debug', type: 'qemu-asm', request: 'launch', stopOnEntry: true });
    // VS Code configures breakpoints after initialized and before configurationDone.
    await this.event('initialized');
    await this.request('configurationDone');
    const stopped = await this.event('stopped');
    assert.equal(stopped.body.reason, 'entry');
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
    const response = await this.request('setBreakpoints', {
      source: { name: 'boot.asm', path: source }, breakpoints: lines.map(line => ({ line })), sourceModified: false
    });
    assert.equal(response.breakpoints.length, lines.length);
    response.breakpoints.forEach((breakpoint, index) => {
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
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu asm debug, '));
  const projectRoot = path.join(temporary, 'project with spaces, and commas');
  const originalStart = core.Processes.prototype.start;
  const qemus = [];
  const clients = [];
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  try {
    await core.createProject(projectRoot);
    await fs.writeFile(path.join(projectRoot, 'boot.asm'), assembly);
    const project = core.resolveProject(temporary, projectRoot, {}, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH });
    const client = new Client(project);
    clients.push(client);
    await client.launch();
    const entry = await client.state();
    assert.equal(await fs.realpath(entry.frame.source.path), await fs.realpath(project.source));
    assert.equal(entry.frame.line, entryLine);
    await client.stoppedAfter('stepIn');
    assert.equal((await client.state()).frame.line, entryLine + 1);
    console.log('PASS: real NASM/QEMU DAP launch stops at boot entry; stepIn advances its source line');

    await client.breakpoints(project.source, [routineLine, returnLine]);
    const { stopped } = await client.stoppedAfter('continue');
    assert.equal(stopped.reason, 'breakpoint');
    const inside = await client.state(true);
    assert.equal(inside.frame.line, routineLine);
    assert.equal(register(inside.registers, 'ax'), 0x1111);
    assert.equal(register(inside.registers, 'sp'), 0x7bfa);
    assert.equal(register(inside.registers, 'bp'), 0x7bfc);
    assert.equal(number(inside.memory[0].value), 0x1111);
    assert(inside.trace.stackFrames.length >= 2, '16-bit BP chain must expose its caller');
    assert.equal(inside.trace.stackFrames[1].line, returnLine);
    const memory = await client.request('readMemory', { memoryReference: '0x7bfa', count: 2 });
    assert.deepEqual([...Buffer.from(memory.data, 'base64')], [0x11, 0x11]);
    const evaluated = await client.request('evaluate', { expression: '$ax', frameId: inside.frame.id, context: 'watch' });
    assert.equal(number(evaluated.result), 0x1111);
    console.log('PASS: source breakpoint, live registers, BP caller, stack variables/readMemory and watch evaluation use real CPU data');

    await client.stoppedAfter('stepIn');
    assert.equal(register((await client.state()).registers, 'ax'), 0x1234);
    await client.stoppedAfter('next');
    assert.equal(register((await client.state()).registers, 'ax'), 0x1235);
    await client.stoppedAfter('stepOut');
    const returned = await client.state();
    assert.equal(returned.frame.line, returnLine);
    assert.equal(register(returned.registers, 'sp'), 0x7c00);
    assert.equal(register(returned.registers, 'bx'), 0x1111);
    await client.breakpoints(project.source, []);
    await client.request('continue', { threadId: 1 });
    await delay(75);
    const pause = await client.stoppedAfter('pause');
    assert.equal(pause.stopped.reason, 'pause');
    assert.equal((await client.state()).frame.line, lineOf('    jmp hang'));
    console.log('PASS: stepIn/next update AX; stepOut restores SP/BX; pause interrupts the real running loop');

    const beforeRestart = qemus.length;
    await client.stoppedAfter('restart', {});
    assert.equal((await client.state()).frame.line, entryLine);
    assert.equal(qemus.length, beforeRestart + 1);
    for (const run of qemus.slice(0, -1)) {
      await run.done;
      assert(run.child.exitCode !== null || run.child.signalCode !== null);
    }
    await client.disconnect();
    const again = new Client(project);
    clients.push(again);
    await again.launch();
    assert.equal((await again.state()).frame.line, entryLine);
    await again.breakpoints(project.source, [callLine]);
    await again.stoppedAfter('continue');
    assert.equal((await again.state()).frame.line, callLine);
    await again.stoppedAfter('next');
    const steppedOver = await again.state();
    assert.equal(steppedOver.frame.line, returnLine);
    assert.equal(register(steppedOver.registers, 'ax'), 0x1235);
    assert.equal(register(steppedOver.registers, 'sp'), 0x7c00);
    console.log('PASS: next completes a real near CALL and stops at the caller instruction');
    await again.disconnect();
    assert(qemus.length >= 3, 'real QEMU launch, restart and relaunch must all execute');
    for (const run of qemus) {
      await run.done;
      assert(run.child.exitCode !== null || run.child.signalCode !== null, 'owned QEMU must exit on disconnect');
    }
    console.log('PASS: restart/disconnect/relaunch clean up all owned real QEMU processes');
  } finally {
    for (const client of clients) await client.dispose();
    core.Processes.prototype.start = originalStart;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
