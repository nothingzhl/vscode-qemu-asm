const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

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
  const match = /0x([0-9a-f]+)/i.exec(String(value));
  const result = match ? Number.parseInt(match[1], 16) : Number(value);
  assert(Number.isSafeInteger(result), `Invalid numeric result: ${value}`);
  return result;
}

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  const extensionRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION);
  const testRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_TEST_ROOT);
  assert.equal(path.dirname(__filename), path.join(testRoot, 'external-tests'), 'test module must execute outside the repository and product');
  // This is the only product import. In particular, no repo/dist, helper test,
  // source decoder or development dependency can substitute for VSIX contents.
  const core = require(path.join(extensionRoot, 'dist', 'core.js'));
  const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
  assert(extension, 'installed VSIX must be discovered by the real extension host');
  assert.equal(await fs.realpath(extension.extensionPath), extensionRoot);
  assert.equal(extension.isActive, false, 'package must cold-activate through its contributed command');
  const folder = vscode.workspace.workspaceFolders[0];
  const projectDirectory = 'installed package protected project';
  const projectRoot = path.join(folder.uri.fsPath, projectDirectory);
  await core.createProject(projectRoot, 'protected');
  const stage = path.join(projectRoot, 'stage2.asm');
  const source = await fs.readFile(stage, 'utf8');
  const lines = source.split('\n');
  const label = lines.findIndex(line => line.trim() === 'learning_breakpoint:');
  assert(label >= 0, 'packaged protected template must contain its debug location');
  let nop = label + 1;
  while (!lines[nop].trim() || lines[nop].trim().startsWith(';')) nop++;
  assert.equal(lines[nop].trim(), 'nop');
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({ projectDirectory, nasmPath: process.env.NASM_PATH || 'nasm',
    qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
  })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);

  const qemus = [], records = [], terminated = new Set();
  const start = core.Processes.prototype.start;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const process = start.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(process);
    return process;
  };
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [], failures: [] }; records.push(record);
      return {
        onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body);
          if (message.type === 'response' && !message.success) record.failures.push(message);
        },
        onError(error) { record.failures.push({ message: error.message }); }
      };
    }
  });
  const listener = vscode.debug.onDidTerminateDebugSession(session => terminated.add(session.id));
  let current;
  try {
    await vscode.commands.executeCommand('qemuAsm.showDisassembly');
    assert.equal(extension.isActive, true);
    assert.equal(qemus.length, 0, 'cold inspector activation must not execute the workspace');
    assert.equal(await vscode.debug.startDebugging(folder, {
      type: 'qemu-asm', request: 'launch', name: 'Installed VSIX machine debugger proof', stopOnEntry: true
    }), true);
    current = await until(() => records[0], 'installed-package debug session');
    await until(() => current.stops[0], 'actual boot entry');
    assert.equal(current.stops[0].reason, 'entry');
    const request = (command, args = {}) => current.session.customRequest(command, args);
    const stoppedAfter = async command => {
      const count = current.stops.length;
      await request(command, { threadId: 1 });
      return until(() => current.stops[count], `${command} real QEMU stop`);
    };
    const boot = await request('qemuAsm.disassemble', { address: 0x7c00, count: 3 });
    assert.equal(boot.mode, 'real16');
    assert.match(boot.instructions[0].instruction, /^cli\b/i);
    assert.equal(boot.instructions[0].instructionBytes.replace(/\s/g, '').toLowerCase(), 'fa');
    const iced = Object.keys(require.cache).find(file => file === path.join(extensionRoot, 'node_modules', 'iced-x86', 'iced_x86.js'));
    assert(iced, 'the decoder JavaScript must load from the installed VSIX');
    const wasm = path.join(path.dirname(iced), 'iced_x86_bg.wasm');
    assert((await fs.stat(wasm)).size > 100000, 'the installed package must include the real WASM decoder');
    const breakpoints = await request('setBreakpoints', { source: { path: stage }, breakpoints: [{ line: nop + 1 }] });
    assert.equal(breakpoints.breakpoints[0].verified, true, JSON.stringify(breakpoints));
    assert.equal((await stoppedAfter('continue')).reason, 'breakpoint');
    const frame = (await request('stackTrace', { threadId: 1 })).stackFrames[0];
    assert.equal(path.resolve(frame.source.path), path.resolve(stage));
    assert.equal(frame.line, nop + 1);
    const edi = number((await request('evaluate', { expression: 'edi', frameId: frame.id, context: 'watch' })).result);
    const disassembly = await request('qemuAsm.disassemble', { count: 3 });
    assert.equal(disassembly.mode, 'protected32');
    assert.match(disassembly.instructions[0].instruction, /^nop\b/i);
    assert.match(disassembly.instructions[1].instruction, /^inc\s+dword\b/i);
    const watchpoints = await request('qemuAsm.watchpoints', { action: 'add', address: edi + 8, size: 4, access: 'write' });
    const watch = watchpoints.breakpoints.find(point => point.address === edi + 8);
    assert.equal(watch?.verified, true, JSON.stringify(watchpoints));
    assert.equal((await stoppedAfter('stepIn')).reason, 'step', 'NOP must not hit the data watchpoint');
    const hit = await stoppedAfter('stepIn');
    assert.equal(hit.reason, 'data breakpoint', JSON.stringify(hit));
    assert(hit.hitBreakpointIds.includes(watch.id), 'actual INC must identify the installed watchpoint');
    const memory = await request('readMemory', { memoryReference: `0x${(edi + 8).toString(16)}`, count: 4 });
    assert.equal(Buffer.from(memory.data, 'base64').readUInt32LE(), 1);
    const listed = await request('qemuAsm.watchpoints', { action: 'list' });
    assert.equal(listed.lastHit.address, edi + 8);
    assert.equal(listed.lastHit.access, 'write');
    await request('disconnect', { terminateDebuggee: true });
    await until(() => terminated.has(current.session.id), 'installed-package debug termination');
    await vscode.commands.executeCommand('qemuAsm.stop');
    assert.equal(qemus.length, 1, 'packaged product must own exactly the tested QEMU process');
    for (const process of qemus) {
      await process.done;
      assert(process.child.exitCode !== null || process.child.signalCode !== null, 'every packaged-product QEMU must exit');
    }
    assert.deepEqual(current.failures, []);
    console.log(`PASS: VS Code ${vscode.version} loads installed ${extension.packageJSON.version}; real16/protected32 WASM decode, source NOP/INC stepping, data breakpoint and RAM=1; owned QEMU exited`);
    console.log(`Product=${extensionRoot}; decoder=${iced}; tests=${__filename}`);
  } finally {
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); listener.dispose(); core.Processes.prototype.start = start;
  }
};
