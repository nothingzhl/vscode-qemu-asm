const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');

// A deliberately small, real-mode BP-frame example. This proves one documented
// unwind convention, rather than claiming arbitrary assembly has a call stack.
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

async function until(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
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
  const aliases = [name, `e${name}`];
  const item = variables.find(variable => aliases.includes(variable.name.toLowerCase()));
  assert(item, `Missing ${name} register: ${JSON.stringify(variables)}`);
  const result = number(item.value);
  assert(Number.isFinite(result), `Invalid ${name} register value: ${item.value}`);
  return result & 0xffff;
}

// Observe real owned subprocesses; do not stub the adapter, network or QEMU.
function observeProcesses() {
  const original = core.Processes.prototype.start;
  const qemus = [];
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = original.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  return { qemus, restore: () => { core.Processes.prototype.start = original; } };
}

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  const folder = vscode.workspace.workspaceFolders[0];
  const projectDirectory = 'debug project with spaces, and commas';
  const projectRoot = path.join(folder.uri.fsPath, projectDirectory);
  const source = path.join(projectRoot, 'boot.asm');
  await core.createProject(projectRoot);
  await fs.writeFile(source, assembly);
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({
    projectDirectory,
    nasmPath: process.env.NASM_PATH || 'nasm',
    qemuPath: process.env.QEMU_PATH || 'qemu-system-i386',
    qemuArgs: ['-m', '32M']
  })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);

  const observed = observeProcesses();
  const sessions = new Map();
  const terminated = new Set();
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [], failures: [] };
      sessions.set(session.id, record);
      return {
        onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body);
          if (message.type === 'response' && !message.success) record.failures.push(message);
        },
        onError(error) { record.failures.push({ message: error.message }); }
      };
    }
  });
  const terminatedListener = vscode.debug.onDidTerminateDebugSession(session => terminated.add(session.id));
  let current;
  async function launch() {
    const previous = new Set(sessions.keys());
    assert.equal(await vscode.debug.startDebugging(folder, {
      type: 'qemu-asm', request: 'launch', name: 'OS debug', stopOnEntry: true
    }), true, 'VS Code must accept the contributed debug configuration');
    const record = await until(() => [...sessions.values()].find(item => !previous.has(item.session.id)), 'new debug adapter session');
    current = record;
    await until(() => record.stops[0], 'boot entry stop');
    return record;
  }
  async function stoppedAfter(record, request, args = { threadId: 1 }) {
    const count = record.stops.length;
    const response = await record.session.customRequest(request, args);
    await until(() => record.stops.length > count, `${request} stopped event`);
    return response;
  }
  async function state(record, stackMemory = false) {
    const trace = await record.session.customRequest('stackTrace', { threadId: 1 });
    assert(trace.stackFrames.length > 0, 'real QEMU stop must expose a stack frame');
    const frame = trace.stackFrames[0];
    assert.equal(path.resolve(frame.source.path), path.resolve(source));
    const { scopes } = await record.session.customRequest('scopes', { frameId: frame.id });
    const registersScope = scopes.find(scope => /register|寄存器/i.test(scope.name));
    assert(registersScope, `Missing registers scope: ${JSON.stringify(scopes)}`);
    const registers = (await record.session.customRequest('variables', { variablesReference: registersScope.variablesReference })).variables;
    let memory;
    if (stackMemory) {
      const stackScope = scopes.find(scope => /stack|堆栈|栈/i.test(scope.name));
      assert(stackScope, `Missing stack memory scope: ${JSON.stringify(scopes)}`);
      memory = (await record.session.customRequest('variables', { variablesReference: stackScope.variablesReference })).variables;
      assert(memory.length > 0, 'stack memory must contain real words');
    }
    return { trace, frame, registers, memory };
  }
  async function breakpoints(record, lines) {
    const result = await record.session.customRequest('setBreakpoints', {
      source: { name: 'boot.asm', path: source }, breakpoints: lines.map(line => ({ line })), sourceModified: false
    });
    assert.equal(result.breakpoints.length, lines.length);
    result.breakpoints.forEach((breakpoint, index) => {
      assert.equal(breakpoint.verified, true, `NASM instruction breakpoint must verify: ${JSON.stringify(breakpoint)}`);
      assert.equal(breakpoint.line, lines[index]);
    });
  }
  async function disconnect(record) {
    await record.session.customRequest('disconnect', { restart: false, terminateDebuggee: true });
    await until(() => terminated.has(record.session.id), 'VS Code debug session termination');
  }

  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
    assert(extension, 'development extension must be loaded');
    assert.equal(extension.isActive, false, 'debug launch must activate the cold extension through its manifest');
    console.log(`VS Code ${vscode.version}; ${process.platform}/${process.arch}; phase=debug`);
    const record = await launch();
    assert.equal(extension.isActive, true, 'startDebugging must activate the debug configuration provider');
    assert.equal(record.stops[0].reason, 'entry');
    assert.equal((await state(record)).frame.line, entryLine, 'entry must stop at the boot sector, rather than inside BIOS');
    await stoppedAfter(record, 'stepIn');
    assert.equal((await state(record)).frame.line, entryLine + 1);
    console.log('PASS: real VS Code debug session stops at 0x7c00 and instruction stepping advances the NASM source line');

    await breakpoints(record, [routineLine, returnLine]);
    await stoppedAfter(record, 'continue');
    assert.equal(record.stops.at(-1).reason, 'breakpoint');
    const inside = await state(record, true);
    assert.equal(inside.frame.line, routineLine);
    assert.equal(register(inside.registers, 'ax'), 0x1111);
    assert.equal(register(inside.registers, 'sp'), 0x7bfa);
    assert.equal(register(inside.registers, 'bp'), 0x7bfc);
    assert.equal(number(inside.memory[0].value), 0x1111, 'SS:SP must contain the real pushed AX word');
    assert(inside.trace.stackFrames.length >= 2, 'the documented 16-bit BP frame must expose its caller');
    assert.equal(inside.trace.stackFrames[1].line, returnLine, 'caller must point to its return instruction');
    console.log('PASS: real NASM breakpoint maps to source, BP frame exposes its caller and SS:SP contains pushed 0x1111');

    await stoppedAfter(record, 'stepIn');
    assert.equal(register((await state(record)).registers, 'ax'), 0x1234);
    await stoppedAfter(record, 'next');
    assert.equal(register((await state(record)).registers, 'ax'), 0x1235);
    await stoppedAfter(record, 'stepOut');
    const returned = await state(record);
    assert.equal(returned.frame.line, returnLine);
    assert.equal(register(returned.registers, 'sp'), 0x7c00);
    assert.equal(register(returned.registers, 'bx'), 0x1111);
    console.log('PASS: stepIn/next refresh live AX and stepOut restores SP/BX from real stack memory');

    await breakpoints(record, []);
    await record.session.customRequest('continue', { threadId: 1 });
    await new Promise(resolve => setTimeout(resolve, 75));
    await stoppedAfter(record, 'pause');
    assert.equal(record.stops.at(-1).reason, 'pause');
    assert.equal((await state(record)).frame.line, lineOf('    jmp hang'));
    console.log('PASS: continue and pause stop a running real QEMU at its NASM loop');

    const beforeRestart = observed.qemus.length;
    await stoppedAfter(record, 'restart', {});
    assert.equal((await state(record)).frame.line, entryLine);
    assert.equal(observed.qemus.length, beforeRestart + 1, 'restart must launch a fresh owned QEMU');
    for (const run of observed.qemus.slice(0, -1)) {
      await run.done;
      assert(run.child.exitCode !== null || run.child.signalCode !== null, 'restart must stop old QEMU');
    }
    await disconnect(record);
    const again = await launch();
    assert.equal((await state(again)).frame.line, entryLine);
    await breakpoints(again, [callLine]);
    await stoppedAfter(again, 'continue');
    assert.equal((await state(again)).frame.line, callLine);
    await stoppedAfter(again, 'next');
    const steppedOver = await state(again);
    assert.equal(steppedOver.frame.line, returnLine, 'next must complete the near CALL before stopping');
    assert.equal(register(steppedOver.registers, 'ax'), 0x1235);
    assert.equal(register(steppedOver.registers, 'sp'), 0x7c00);
    console.log('PASS: next steps over a real near CALL and returns to the caller source line');
    await disconnect(again);
    assert(observed.qemus.length >= 3, 'host coverage must exercise real QEMU launch/restart/relaunch');
    for (const run of observed.qemus) {
      await run.done;
      assert(run.child.exitCode !== null || run.child.signalCode !== null, 'disconnect must stop all adapter-owned QEMU processes');
    }
    for (const record of sessions.values()) assert.deepEqual(record.failures, [], 'debug adapter requests must succeed');
    console.log('PASS: restart, disconnect and relaunch terminate every owned real QEMU process');
  } finally {
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose();
    terminatedListener.dispose();
    observed.restore();
  }
};
