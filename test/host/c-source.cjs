// Real VS Code host acceptance. Product imports may resolve only from the
// independently installed package when this file is copied for the VSIX proof.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const extensionRoot = process.env.QEMU_ASM_VSIX_EXTENSION || path.resolve(__dirname, '../..');
const core = require(path.join(extensionRoot, 'dist', 'core.js'));
const { localHost } = require(path.join(extensionRoot, 'dist', 'platform', 'host.js'));
const { InspectorProvider } = require(path.join(extensionRoot, 'dist', 'inspector', 'provider.js'));
const F = process.env.QEMU_ASM_VSIX_EXTENSION ? require('./c-source-fixture.cjs') : require('../../scripts/c-source-fixture.cjs');

async function until(predicate, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout waiting for ${description}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function number(value) {
  const match = /0x([\da-f]+)/i.exec(String(value));
  const result = match ? Number.parseInt(match[1], 16) : Number.parseInt(String(value), 10);
  assert(Number.isSafeInteger(result), `Invalid numeric debugger result: ${value}`);
  return result;
}

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  const folder = vscode.workspace.workspaceFolders[0];
  const gdbChildren = [];
  const originalSpawn = localHost.spawn;
  localHost.spawn = function(command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (/^gdb(?:\.exe)?$/i.test(path.basename(command))) gdbChildren.push(child);
    return child;
  };
  const observed = [], providers = new Set(), sessions = [], terminated = new Set(), breakpoints = [];
  const original = { start: core.Processes.prototype.start, post: InspectorProvider.prototype.post };
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = original.start.call(this, command, args, cwd, log);
    observed.push({ command, args, run });
    return run;
  };
  InspectorProvider.prototype.post = function(message) {
    providers.add(this);
    return original.post.call(this, message);
  };
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [], requests: [], responses: [], failures: [] }; sessions.push(record);
      return {
        onWillReceiveMessage(message) { if (message.type === 'request') record.requests.push(message); },
        onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body);
          if (message.type === 'response') { record.responses.push(message); if (!message.success) record.failures.push(message); }
        },
        onError(error) { record.failures.push({ message: error.message }); }
      };
    }
  });
  const listener = vscode.debug.onDidTerminateDebugSession(session => terminated.add(session.id));
  let current, provider;
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension);
    if (process.env.QEMU_ASM_VSIX_EXTENSION) {
      assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(extensionRoot));
      assert.equal(await fs.realpath(path.dirname(__filename)), await fs.realpath(path.join(process.env.QEMU_ASM_VSIX_TEST_ROOT, 'external-tests')));
    }
    assert.equal(extension.isActive, false);
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    provider = await until(() => [...providers].find(item => item.ready && item.view?.visible), 'real contributed inspector view');
    assert.equal(observed.length, 0, 'opening the inspector must not execute the workspace');
    const project = await F.fixture(path.join(folder.uri.fsPath, 'C source project with spaces, and commas'));
    const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
    for (const [key, value] of Object.entries({ projectDirectory: path.relative(folder.uri.fsPath, project.root), nasmPath: process.env.NASM_PATH || 'nasm',
      qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
    })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    const source = vscode.Uri.file(project.source);
    const callLine = project.line('CALL_NESTED'), nestedLine = project.line('NESTED_READY');
    const callBreakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(callLine - 1, 0)));
    breakpoints.push(callBreakpoint); vscode.debug.addBreakpoints([callBreakpoint]);
    console.log('C source host: launching through public debug command');
    await vscode.commands.executeCommand('qemuAsm.debug');
    current = await until(() => sessions[0], 'public debug command selects the C source adapter');
    await until(() => current.stops[0], 'actual kernel_main entry');
    assert.equal(current.stops[0].reason, 'entry');
    console.log('C source host: kernel_main entry stopped');
    const request = (command, args = {}) => current.session.customRequest(command, args);
    const stoppedAfter = async (command, args = { threadId: 1 }) => {
      const before = current.stops.length;
      await request(command, args);
      return until(() => current.stops[before], `${command} actual C guest stop`);
    };
    const frames = async () => (await request('stackTrace', { threadId: 1, startFrame: 0, levels: 20 })).stackFrames;
    const evaluate = async (expression, frameId) => request('evaluate', { expression, frameId, context: 'watch' });
    const variables = async reference => (await request('variables', { variablesReference: reference })).variables;
    const locals = async frameId => {
      const scopes = (await request('scopes', { frameId })).scopes;
      const scope = scopes.find(item => /locals|局部/i.test(item.name)); assert(scope, JSON.stringify(scopes));
      return variables(scope.variablesReference);
    };
    let stack = await frames();
    assert.match(stack[0].name, /kernel_main/); assert.equal(await fs.realpath(stack[0].source.path), await fs.realpath(project.source));
    assert(current.responses.some(response => response.command === 'setBreakpoints' && response.body?.breakpoints.some(item => item.verified)), JSON.stringify(current.responses.filter(response => response.command === 'setBreakpoints')));
    await stoppedAfter('continue'); stack = await frames(); assert.equal(stack[0].line, callLine);
    console.log('C source host: actual native CALL_NESTED breakpoint stopped');
    assert(current.responses.some(response => response.command === 'setBreakpoints' && response.body?.breakpoints.some(item => item.verified)), 'native source breakpoint must be verified by the real adapter');
    vscode.debug.removeBreakpoints([callBreakpoint]);
    await stoppedAfter('stepIn'); stack = await frames(); assert.match(stack[0].name, /compute/);
    const nestedBreakpoint = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(nestedLine - 1, 0)));
    breakpoints.push(nestedBreakpoint); vscode.debug.addBreakpoints([nestedBreakpoint]);
    await until(() => current.responses.filter(response => response.command === 'setBreakpoints').some(response => response.body?.breakpoints.some(item => item.line === nestedLine && item.verified)), 'native nested source breakpoint');
    await stoppedAfter('continue'); stack = await frames();
    assert.match(stack[0].name, /compute/); assert.equal(stack[0].line, nestedLine); assert(stack.length >= 2);
    const top = stack[0], caller = stack.find(frame => /kernel_main/.test(frame.name)); assert(caller);
    const topLocals = await locals(top.id), callerLocals = await locals(caller.id);
    assert.equal(number((await evaluate('delta', top.id)).result), 5);
    assert.equal(number((await evaluate('total', top.id)).result), 42);
    assert.equal(number((await evaluate('sample.left', caller.id)).result), 17);
    assert.equal(number((await evaluate('sample.right', caller.id)).result), 20);
    assert.equal(number((await evaluate('values[2]', caller.id)).result), 3);
    const sample = callerLocals.find(value => value.name === 'sample'); assert(sample?.variablesReference > 0, JSON.stringify(callerLocals));
    const fields = await variables(sample.variablesReference);
    assert.equal(number(fields.find(value => value.name === 'left')?.value), 17);
    assert.equal(number(fields.find(value => value.name === 'right')?.value), 20);
    const values = callerLocals.find(value => value.name === 'values'); assert(values?.variablesReference > 0, JSON.stringify(callerLocals));
    const elements = await variables(values.variablesReference);
    assert.deepEqual(elements.map(value => number(value.value)), [1, 2, 3]);
    const registers = await request('scopes', { frameId: top.id });
    assert(registers.scopes.some(scope => /register|寄存器/i.test(scope.name)));
    const pc = number(top.instructionPointerReference);
    const disassembly = await request('qemuAsm.disassemble', { address: pc, count: 5 }); assert.equal(disassembly.bits, 32);
    if (process.env.QEMU_ASM_VSIX_EXTENSION) {
      const decoder = path.join(extensionRoot, 'node_modules', 'iced-x86', 'iced_x86.js');
      assert(require.cache[decoder], 'live disassembly must use the decoder JavaScript inside the installed package');
      assert((await fs.stat(path.join(path.dirname(decoder), 'iced_x86_bg.wasm'))).size > 100000, 'the installed package must include the real WASM decoder');
    }
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    provider.receive({ type: 'configure', form: { tab: 'memory', follow: 'esp', memorySpace: 'virtual', count: 64 } });
    await until(() => !provider.model.snapshot.stale && !provider.model.snapshot.busy && provider.model.snapshot.memory?.follow === 'esp', 'C guest live stack reaches the existing inspector');
    const memory = provider.model.snapshot.memory;
    console.log(`PASS: VS Code ${vscode.version} public debug command selects ELF/GDB, native C source breakpoint and F11 enter compute; nested locals, expandable struct/array and caller-frame expressions use actual DWARF; existing inspector reads real 32-bit stack`);
    const ready = process.env.QEMU_ASM_C_SOURCE_UI_READY;
    if (ready) {
      await vscode.window.showTextDocument(source, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      // Keep the actual selected native caller frame and source line under UI
      // control; the CDP driver clicks the real call-stack row for the image.
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('qemuAsm.showDisplay');
      await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
      await vscode.commands.executeCommand('qemuAsm.showInspector');
      const evidence = { vscodeVersion: vscode.version, platform: process.platform, architecture: process.arch, source: project.source,
        line: nestedLine, callLine, pc, stack, topLocals, callerLocals, fields, elements, memory,
        sourceOfEvidence: 'Real GCC DWARF ELF, owned GDB and QEMU in protected32; native VS Code source breakpoints, caller-frame variables and existing memory inspector. No debugger or UI mocks.' };
      await fs.writeFile(ready, JSON.stringify(evidence, null, 2));
      await until(() => exists(`${ready}.continue`), 'actual C source UI screenshot completion', 180000);
    }
    vscode.debug.removeBreakpoints([nestedBreakpoint]);
    await stoppedAfter('stepOut'); stack = await frames(); assert.match(stack[0].name, /kernel_main/);
    if (stack[0].line === callLine) { await stoppedAfter('next'); stack = await frames(); }
    assert.equal(stack[0].line, project.line('AFTER_NESTED'));
    assert.equal(number((await evaluate('result', stack[0].id)).result), 42);
    await stoppedAfter('next');
    assert.equal(number((await evaluate('global_result', (await frames())[0].id)).result), 42);
    console.log('PASS: actual C Shift-F11 return and F10 execute the caller statement with global_result=42');
    await request('disconnect', { terminateDebuggee: true });
    await until(() => terminated.has(current.session.id), 'C debug termination');
    await vscode.commands.executeCommand('qemuAsm.stop');
    const qemus = observed.filter(item => /^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(item.command)));
    assert.equal(qemus.length, 1);
    for (const item of observed) { await item.run.done; assert(item.run.child.exitCode !== null || item.run.child.signalCode !== null, `owned process exits: ${item.command}`); }
    assert.equal(gdbChildren.length, 1, 'the C adapter must own one actual GDB process');
    for (const child of gdbChildren) await until(() => child.exitCode !== null || child.signalCode !== null, 'owned GDB process exit');
    console.log(`PASS: every observed owned build/QEMU/GDB process exits after real host disconnect; product=${extensionRoot}`);
  } finally {
    vscode.debug.removeBreakpoints(breakpoints);
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); listener.dispose(); localHost.spawn = originalSpawn; core.Processes.prototype.start = original.start; InspectorProvider.prototype.post = original.post;
  }
};
