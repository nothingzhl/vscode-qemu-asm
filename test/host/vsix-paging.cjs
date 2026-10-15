const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const F = require('./paging-fixture.cjs');

async function until(predicate, description, timeout = 30000) {
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
const hex = value => `0x${value.toString(16)}`;

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  const extensionRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION);
  const testRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_TEST_ROOT);
  const testDirectory = path.join(testRoot, 'external-tests');
  assert.equal(path.dirname(__filename), testDirectory, 'test module must execute outside the repository and installed product');
  assert.equal(require.resolve('./paging-fixture.cjs'), path.join(testDirectory, 'paging-fixture.cjs'));
  const fixtureText = await fs.readFile(path.join(testDirectory, 'paging-fixture.cjs'), 'utf8');
  assert(!fixtureText.includes("require('../dist/core')"), 'external fixture must not import repository product code');
  // Every product import comes from the installed VSIX; the separate fixture
  // contributes only transient firmware and constants, never debugger code.
  const corePath = path.join(extensionRoot, 'dist', 'core.js');
  const core = require(corePath);
  assert(require.cache[corePath], 'installed core must be the module used to create and execute the fixture');
  const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
  assert(extension, 'installed VSIX must be discovered by the real extension host');
  assert.equal(await fs.realpath(extension.extensionPath), extensionRoot);
  assert.equal(extension.isActive, false, 'paging command must cold-activate the installed product');
  const folder = vscode.workspace.workspaceFolders[0];
  const projectDirectory = 'installed package paging project';
  const project = await F.fixture(path.join(folder.uri.fsPath, projectDirectory));
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
    await vscode.commands.executeCommand('qemuAsm.showPaging');
    assert.equal(extension.isActive, true);
    assert.equal(qemus.length, 0, 'cold paging activation must not execute the workspace');
    assert.equal(await vscode.debug.startDebugging(folder, {
      type: 'qemu-asm', request: 'launch', name: 'Installed VSIX nonidentity paging proof', stopOnEntry: true
    }), true);
    current = await until(() => records[0], 'installed-package paging session');
    await until(() => current.stops[0], 'real boot entry');
    assert.equal(current.stops[0].reason, 'entry');
    const request = (command, args = {}) => current.session.customRequest(command, args);
    const stoppedAfter = async command => {
      const count = current.stops.length;
      await request(command, { threadId: 1 });
      return until(() => current.stops[count], `${command} real QEMU stop`);
    };
    const frame = async () => (await request('stackTrace', { threadId: 1 })).stackFrames[0];
    const evaluate = async expression => number((await request('evaluate', { expression, frameId: 1, context: 'watch' })).result);
    const memory = (address, count, space = 'virtual') => request('qemuAsm.inspectMemory', { address, count, follow: 'address', space });
    const word = async (address, space = 'virtual') => Buffer.from((await memory(address, 4, space)).bytes).readUInt32LE();

    const boot = await request('qemuAsm.disassemble', { address: 0x7c00, count: 3 });
    assert.equal(boot.mode, 'real16');
    assert.match(boot.instructions[0].instruction, /^cli\b/i);
    const iced = path.join(extensionRoot, 'node_modules', 'iced-x86', 'iced_x86.js');
    assert(require.cache[iced], 'decoder JavaScript must load from the installed VSIX');
    const wasm = path.join(path.dirname(iced), 'iced_x86_bg.wasm');
    assert((await fs.stat(wasm)).size > 100000, 'installed package must include the real WASM decoder');
    const native = await request('setInstructionBreakpoints', { breakpoints: [{ instructionReference: hex(F.HIGH_CALL) }] });
    assert.equal(native.breakpoints[0].verified, true, JSON.stringify(native));
    const highStop = await stoppedAfter('continue');
    assert.equal(highStop.reason, 'breakpoint');
    assert(highStop.hitBreakpointIds.includes(native.breakpoints[0].id));
    let currentFrame = await frame();
    assert.equal(number(currentFrame.instructionPointerReference), F.HIGH_CALL);
    assert.equal(currentFrame.source, undefined, 'copied paged code must not invent NASM source');
    assert((await evaluate('cr0')) & 0x80000000, 'guest must actually enable CR0.PG');
    assert.equal(await evaluate('esp'), F.HIGH_STACK);
    assert.equal(await evaluate('eax'), 0x40);
    const disassembly = await request('qemuAsm.disassemble', { address: F.HIGH_CODE, count: 7 });
    assert.equal(disassembly.mode, 'protected32');
    assert.equal(disassembly.bits, 32);
    assert.match(disassembly.instructions[1].instruction, /^call\b/i);
    assert.equal(disassembly.instructions[1].size, 5);
    assert.equal((await stoppedAfter('next')).reason, 'step');
    currentFrame = await frame();
    assert.equal(number(currentFrame.instructionPointerReference), F.HIGH_WRITE);
    assert.equal(await evaluate('eax'), 0x41);
    assert.equal(await evaluate('esp'), F.HIGH_STACK, 'CALL/RET must use and restore the actual nonidentity virtual stack');
    await request('setInstructionBreakpoints', { breakpoints: [] });

    const page = await request('qemuAsm.inspectPaging', { address: F.HIGH_DATA + 3 });
    assert.equal(page.format, 'legacy32');
    assert.equal(page.status, 'mapped');
    assert.equal(page.cr3, F.PD);
    assert.equal(page.directoryBase, F.PD);
    assert.equal(page.directoryIndex, 768);
    assert.equal(page.tableIndex, 256);
    assert.equal(page.pde.address, F.PD + 768 * 4);
    assert.equal(page.pte.address, F.HIGH_PT + 256 * 4);
    assert.equal(page.physicalAddress, F.DATA_PHYSICAL + 3);
    assert.equal(page.pageSize, 4096);
    assert.equal(page.effective.user, true);
    assert.equal(page.effective.writable, true);
    const big = await request('qemuAsm.inspectPaging', { address: F.BIG_VIRTUAL + 0x123 });
    assert.equal(big.status, 'mapped');
    assert.equal(big.pageSize, 4194304);
    assert.equal(big.physicalAddress, F.BIG_PHYSICAL + 0x123);
    const directory = await memory(F.PD, 4, 'physical');
    assert.equal((Buffer.from(directory.bytes).readUInt32LE() & 0xfffff000) >>> 0, F.LOW_PT);
    assert.equal(await word(F.CODE_PHYSICAL), 0xaabbccdd, 'same numeric virtual address must use its independent mapping');
    const code = await memory(F.CODE_PHYSICAL, 5, 'physical');
    assert.deepEqual(code.bytes, [0xb8, 0x40, 0, 0, 0]);
    assert.equal(await word(F.CODE_PHYSICAL), 0xaabbccdd, 'physical inspection must restore virtual mode');
    assert.deepEqual((await memory(F.HIGH_CODE, 5)).bytes, code.bytes);

    const info = await request('dataBreakpointInfo', { name: hex(F.HIGH_DATA), memoryReference: hex(F.HIGH_DATA), bytes: 4 });
    const watched = await request('setDataBreakpoints', { breakpoints: [{ dataId: info.dataId, accessType: 'write' }] });
    assert.equal(watched.breakpoints[0].verified, true, JSON.stringify(watched));
    const writeHit = await stoppedAfter('stepIn');
    assert.equal(writeHit.reason, 'data breakpoint');
    assert(writeHit.hitBreakpointIds.includes(watched.breakpoints[0].id));
    assert.equal(number((await frame()).instructionPointerReference), F.HIGH_READ);
    assert.equal(await word(F.HIGH_DATA), 1);
    assert.equal(await word(F.DATA_PHYSICAL, 'physical'), 1);
    await request('setDataBreakpoints', { breakpoints: [] });
    const custom = await request('qemuAsm.watchpoints', { action: 'add', address: F.HIGH_DATA, size: 4, access: 'read' });
    const readWatch = custom.breakpoints.find(point => point.address === F.HIGH_DATA);
    assert.equal(readWatch?.verified, true, JSON.stringify(custom));
    const readHit = await stoppedAfter('stepIn');
    assert.equal(readHit.reason, 'data breakpoint');
    assert(readHit.hitBreakpointIds.includes(readWatch.id));
    assert.equal(number((await frame()).instructionPointerReference), F.HIGH_AFTER_READ);
    assert.equal(await evaluate('ebx'), 1);
    await request('disconnect', { terminateDebuggee: true });
    await until(() => terminated.has(current.session.id), 'installed-package paging termination');
    await vscode.commands.executeCommand('qemuAsm.stop');
    assert.equal(qemus.length, 1, 'installed product must own exactly the tested QEMU process');
    for (const process of qemus) {
      await process.done;
      assert(process.child.exitCode !== null || process.child.signalCode !== null, 'every installed-product QEMU must exit');
    }
    assert.deepEqual(current.failures, []);
    console.log(`PASS: VS Code ${vscode.version} cold-activates installed ${extension.packageJSON.version} paging command and loads its own JS/WASM`);
    console.log('PASS: installed product debugs actual CR0.PG nonidentity high code/stack, F10 CALL/RET, physical 4KiB/4MiB page walk, distinct VA/PA RAM and native-write/custom-read data breakpoints; owned QEMU exited');
    console.log(`Product=${extensionRoot}; decoder=${iced}; tests=${__filename}; fixture=${project.source}`);
  } finally {
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); listener.dispose(); core.Processes.prototype.start = start;
  }
};
