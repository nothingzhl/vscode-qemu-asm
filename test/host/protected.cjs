const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');

async function until(predicate, description, timeout = 25000) {
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

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  const folder = vscode.workspace.workspaceFolders[0];
  const projectDirectory = 'protected 调试 project with spaces, and commas';
  const projectRoot = path.join(folder.uri.fsPath, projectDirectory);
  await core.createProject(projectRoot, 'protected');
  const boot = path.join(projectRoot, 'boot.asm');
  const stage = path.join(projectRoot, 'stage2.asm');
  const bootText = await fs.readFile(boot, 'utf8');
  const stageText = await fs.readFile(stage, 'utf8');
  const lines = {
    bootEntry: lineOf(bootText, 'cli'), bootJump: lineOf(bootText, 'jmp 0x0000:0x8000'),
    writeCR0: lineOf(stageText, 'mov cr0, eax'), farJump: lineOf(stageText, 'jmp 0x08:protected_entry'),
    protectedEntry: afterLabel(stageText, 'protected_entry'), setESP: lineOf(stageText, 'mov esp, 0x90000'),
    call: lineOf(stageText, 'call learning_entry'), nested: afterLabel(stageText, 'learning_breakpoint'),
    nestedReturn: lineOf(stageText, 'add esp, 4'), callerReturn: afterLabel(stageText, 'idle')
  };
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({
    projectDirectory,
    nasmPath: process.env.NASM_PATH || 'nasm',
    qemuPath: process.env.QEMU_PATH || 'qemu-system-i386',
    qemuArgs: ['-m', '32M']
  })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);

  const originalStart = core.Processes.prototype.start;
  const qemus = [];
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
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
      type: 'qemu-asm', request: 'launch', name: 'Two-stage protected-mode OS', stopOnEntry: true
    }), true);
    current = await until(() => [...sessions.values()].find(item => !previous.has(item.session.id)), 'new protected debug session');
    await until(() => current.stops[0], 'boot entry stop');
    return current;
  }
  async function stoppedAfter(record, request, args = { threadId: 1 }) {
    const count = record.stops.length;
    const response = await record.session.customRequest(request, args);
    await until(() => record.stops.length > count, `${request} stopped event`);
    return response;
  }
  async function state(record, source, stackMemory = false) {
    const trace = await record.session.customRequest('stackTrace', { threadId: 1 });
    assert(trace.stackFrames.length > 0);
    const frame = trace.stackFrames[0];
    assert.equal(await fs.realpath(frame.source.path), await fs.realpath(source));
    const { scopes } = await record.session.customRequest('scopes', { frameId: frame.id });
    const registersScope = scopes.find(scope => /register|寄存器/i.test(scope.name));
    assert(registersScope, 'registers scope must be exposed');
    const registers = (await record.session.customRequest('variables', { variablesReference: registersScope.variablesReference })).variables;
    let memory;
    if (stackMemory) {
      const stackScope = scopes.find(scope => /stack|堆栈|栈/i.test(scope.name));
      assert(stackScope, 'stack memory scope must be exposed');
      memory = (await record.session.customRequest('variables', { variablesReference: stackScope.variablesReference })).variables;
    }
    return { trace, frame, registers, memory };
  }
  async function breakpoints(record, source, requested) {
    const result = await record.session.customRequest('setBreakpoints', {
      source: { name: path.basename(source), path: source }, breakpoints: requested.map(line => ({ line })), sourceModified: false
    });
    assert.equal(result.breakpoints.length, requested.length);
    result.breakpoints.forEach((breakpoint, index) => {
      assert.equal(breakpoint.verified, true, JSON.stringify(breakpoint));
      assert.equal(breakpoint.line, requested[index]);
    });
  }
  async function disconnect(record) {
    await record.session.customRequest('disconnect', { restart: false, terminateDebuggee: true });
    await until(() => terminated.has(record.session.id), 'VS Code debug session termination');
  }
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
    assert(extension, 'development extension must be loaded');
    assert.equal(extension.isActive, false, 'protected launch must activate the cold extension through its manifest');
    console.log(`VS Code ${vscode.version}; ${process.platform}/${process.arch}; phase=protected`);
    const record = await launch();
    assert.equal(extension.isActive, true);
    assert.equal(record.stops[0].reason, 'entry');
    assert.equal((await state(record, boot)).frame.line, lines.bootEntry);
    await breakpoints(record, boot, [lines.bootJump]);
    await breakpoints(record, stage, [lines.writeCR0]);
    await stoppedAfter(record, 'continue');
    assert.equal((await state(record, boot)).frame.line, lines.bootJump);
    await breakpoints(record, boot, []);
    await stoppedAfter(record, 'continue');
    let inside = await state(record, stage);
    assert.equal(inside.frame.line, lines.writeCR0);
    assert.equal(register(inside.registers, 'cr0') & 1, 0);
    await stoppedAfter(record, 'stepIn');
    inside = await state(record, stage);
    assert.equal(inside.frame.line, lines.farJump);
    assert.equal(register(inside.registers, 'cr0') & 1, 1);
    await stoppedAfter(record, 'stepIn');
    inside = await state(record, stage);
    assert.equal(inside.frame.line, lines.protectedEntry);
    assert.equal(register(inside.registers, 'cs'), 8);
    console.log('PASS: real VS Code host preserves boot/stage2 breakpoints and source stepping across CR0.PE plus the 32-bit far jump');

    await breakpoints(record, stage, [lines.setESP]);
    await stoppedAfter(record, 'continue');
    await stoppedAfter(record, 'stepIn');
    inside = await state(record, stage);
    assert.equal(register(inside.registers, 'esp'), 0x90000);
    assert.equal(register(inside.registers, 'ds'), 0x10);
    assert.equal(register(inside.registers, 'ss'), 0x10);
    await breakpoints(record, stage, [lines.nested]);
    await stoppedAfter(record, 'continue');
    inside = await state(record, stage, true);
    assert.equal(inside.frame.line, lines.nested);
    assert.equal(register(inside.registers, 'eax'), 0x11223344);
    assert.equal(register(inside.registers, 'ebx'), 0x11223344);
    assert.equal(register(inside.registers, 'esp'), 0x8ffec);
    assert.equal(register(inside.registers, 'ebp'), 0x8ffec);
    assert(inside.trace.stackFrames.length >= 3, 'real EBP chain must expose both 32-bit callers');
    assert.equal(inside.trace.stackFrames[1].line, lines.nestedReturn);
    assert.equal(inside.trace.stackFrames[2].line, lines.callerReturn);
    assert.equal(number(inside.memory[0].value), 0x8fff8);
    assert.equal(number(inside.memory[2].value), 0x11223344);
    const memory = await record.session.customRequest('readMemory', { memoryReference: '0x8fff4', count: 4 });
    assert.equal(Buffer.from(memory.data, 'base64').toString('hex'), '44332211');
    const stack = await record.session.customRequest('evaluate', { expression: 'ss:esp', frameId: inside.frame.id, context: 'watch' });
    assert.equal(number(stack.result), 0x8ffec);
    console.log('PASS: VS Code exposes actual 32-bit CPU registers, four-byte SS:ESP stack slots and nested EBP callers');

    // The optional UI runner inspects and captures the real Electron workbench
    // while this same tested QEMU is paused inside the 32-bit nested function.
    const ready = process.env.QEMU_ASM_PROTECTED_UI_READY;
    if (ready) {
      const location = new vscode.Location(vscode.Uri.file(stage), new vscode.Position(lines.nested - 1, 0));
      const breakpoint = new vscode.SourceBreakpoint(location);
      vscode.debug.addBreakpoints([breakpoint]);
      try {
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await vscode.commands.executeCommand('notifications.clearAll');
        await vscode.commands.executeCommand('workbench.view.debug');
        const editor = await vscode.window.showTextDocument(vscode.Uri.file(stage), { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
        editor.selection = new vscode.Selection(lines.nested - 1, 0, lines.nested - 1, 0);
        editor.revealRange(new vscode.Range(lines.nested - 1, 0, lines.nested - 1, 0), vscode.TextEditorRevealType.InCenter);
        await vscode.commands.executeCommand('qemuAsm.showDisplay');
        for (const expression of ['eax', 'ebx', 'esp', 'ebp', 'eip', 'cr0', 'cs', 'ss', 'mode']) {
          await vscode.commands.executeCommand('debug.addToWatchExpressions', { variable: { evaluateName: expression } });
        }
        await fs.writeFile(ready, JSON.stringify({
          stage: 'paused', vscodeVersion: vscode.version, platform: process.platform, architecture: process.arch,
          source: stage, line: lines.nested, mode: 'protected32', marker: core.PROTECTED_MARKER,
          registers: Object.fromEntries(['eax', 'ebx', 'esp', 'ebp', 'eip', 'cr0', 'cs', 'ss'].map(name => [name, register(inside.registers, name)])),
          stackFrames: inside.trace.stackFrames,
          sourceOfEvidence: 'Actual VS Code debug session and real QEMU; no UI mock or image compositing.'
        }, null, 2));
        await until(async () => { try { await fs.access(`${ready}.continue`); return true; } catch { return false; } }, 'actual protected-mode UI screenshot completion', 120000);
      } finally { vscode.debug.removeBreakpoints([breakpoint]); }
    }

    await stoppedAfter(record, 'stepOut');
    inside = await state(record, stage);
    assert.equal(inside.frame.line, lines.nestedReturn);
    assert.equal(register(inside.registers, 'esp'), 0x8fff4);
    const beforeRestart = qemus.length;
    await stoppedAfter(record, 'restart', {});
    assert.equal((await state(record, boot)).frame.line, lines.bootEntry);
    assert.equal(qemus.length, beforeRestart + 1);
    await breakpoints(record, stage, [lines.call]);
    await stoppedAfter(record, 'continue');
    assert.equal((await state(record, stage)).frame.line, lines.call);
    await stoppedAfter(record, 'next');
    inside = await state(record, stage);
    assert.equal(inside.frame.line, lines.callerReturn);
    assert.equal(register(inside.registers, 'eax'), 0x11223344);
    assert.equal(register(inside.registers, 'esp'), 0x90000);
    await disconnect(record);
    const again = await launch();
    assert.equal((await state(again, boot)).frame.line, lines.bootEntry);
    await disconnect(again);
    assert(qemus.length >= 3);
    for (const run of qemus) {
      await run.done;
      assert(run.child.exitCode !== null || run.child.signalCode !== null, 'all owned QEMU must exit on restart/disconnect');
    }
    for (const session of sessions.values()) assert.deepEqual(session.failures, [], 'all actual host DAP requests must succeed');
    console.log('PASS: VS Code stepOut/next execute real 32-bit CALL/RET, and restart/disconnect/relaunch clean up every owned QEMU');
  } finally {
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose();
    terminatedListener.dispose();
    core.Processes.prototype.start = originalStart;
  }
};
