// Public-command/native-host dependency acceptance. Installed VSIX tests copy
// this file and the compiler fixture outside the repository before loading it.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const extensionRoot = process.env.QEMU_ASM_VSIX_EXTENSION || path.resolve(__dirname, '../..');
const core = require(path.join(extensionRoot, 'dist', 'core.js'));
const { QemuScreen } = require(path.join(extensionRoot, 'dist', 'display', 'screen.js'));
const F = process.env.QEMU_ASM_VSIX_EXTENSION ? require('./c-source-fixture.cjs') : require('../../scripts/c-source-fixture.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(50); }
  throw new Error('Timeout waiting for ' + description);
}
function capability(report, id, state, evidence) {
  const entry = report.entries.find(item => item.id === id); assert(entry, 'Missing ' + id);
  assert.equal(entry.state, state, JSON.stringify(entry));
  if (evidence) assert.equal(entry.evidence, evidence, JSON.stringify(entry));
  return entry;
}
async function configure(folder, values) {
  const configuration = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries(values)) await configuration.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
}
function tool(report, id, status = 'passed') {
  const check = report.tools.find(item => item.id === id); assert(check, 'Missing tool ' + id);
  assert.equal(check.status, status, JSON.stringify(check)); return check;
}

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  const folder = vscode.workspace.workspaceFolders[0]; assert(folder);
  const observed = [], sessions = [], terminated = new Set();
  const originalStart = core.Processes.prototype.start;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log); observed.push({ command: run.child.spawnfile, requested: command, args, run }); return run;
  };
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [], failures: [] }; sessions.push(record);
      return { onDidSendMessage(message) {
        if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body);
        if (message.type === 'response' && !message.success) record.failures.push(message);
      } };
    }
  });
  const listener = vscode.debug.onDidTerminateDebugSession(session => terminated.add(session.id));
  let current, originalScreenCreate;
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension); await extension.activate();
    if (process.env.QEMU_ASM_VSIX_EXTENSION) {
      assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(extensionRoot));
      assert.equal(path.dirname(__filename), path.join(process.env.QEMU_ASM_VSIX_TEST_ROOT, 'external-tests'));
      assert.equal(core, require(path.join(extension.extensionPath, 'dist', 'core.js')), 'test must observe installed product code');
    }
    const root = path.join(folder.uri.fsPath, 'NASM dependency project with spaces, and commas'); await core.createProject(root);
    const nasm = process.env.NASM_PATH || 'nasm', qemu = process.env.QEMU_PATH || 'qemu-system-i386';
    await configure(folder, {
      projectDirectory: path.relative(folder.uri.fsPath, root),
      nasmPath: path.isAbsolute(nasm) ? path.relative(folder.uri.fsPath, nasm) : nasm,
      qemuPath: path.isAbsolute(qemu) ? path.relative(folder.uri.fsPath, qemu) : qemu,
      gdbPath: path.join(root, 'no GDB installed'), qemuArgs: ['-m', '32M'], displayMode: 'off',
    });
    const first = observed.length;
    let report = await vscode.commands.executeCommand('qemuAsm.checkEnvironment');
    assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'passed');
    assert.equal(report.host.platform, process.platform); assert.equal(report.host.arch, process.arch);
    assert.deepEqual(report.tools.map(item => item.id), ['nasm', 'qemu']);
    const nasmCheck = tool(report, 'nasm'), qemuCheck = tool(report, 'qemu');
    assert(nasmCheck.version && qemuCheck.version); assert.equal(nasmCheck.evidence, 'executable');
    assert.equal(observed.length, first + 2, 'basic checks must run only NASM/QEMU version commands');
    assert.equal(observed[first].command, nasmCheck.resolution.executable);
    assert.equal(observed[first + 1].command, qemuCheck.resolution.executable);
    for (const entry of report.capabilities.entries) assert.equal(entry.state, 'unknown', 'versions cannot prove debug protocol capabilities');
    await assert.rejects(fs.stat(path.join(root, 'build', 'boot.img')), { code: 'ENOENT' });
    report = await vscode.commands.executeCommand('qemuAsm.showDependencyReport');
    await until(() => vscode.window.activeTextEditor?.document.languageId === 'json', 'JSON dependency report');
    const document = vscode.window.activeTextEditor.document;
    assert.equal(document.uri.scheme, 'qemu-asm-report');
    assert.equal(document.isDirty, false, 'reading a report must not cause a later debug launch to prompt Save As');
    assert.equal(document.isUntitled, false, 'a dependency report must be a read-only virtual document');
    assert.deepEqual(JSON.parse(document.getText()), report);
    console.log(`PASS: VS Code ${vscode.version} dependency commands use actual resolved executables, require no GDB for NASM, leave guest unbuilt and expose a truthful JSON report`);

    await vscode.commands.executeCommand('qemuAsm.build');
    const image = await fs.readFile(path.join(root, 'build', 'boot.img')); assert.equal(image.length, 512); assert.equal(image.subarray(510).toString('hex'), '55aa');
    await vscode.commands.executeCommand('qemuAsm.debug'); current = await until(() => sessions[0], 'NASM debug session');
    await until(() => current.stops.length > 0, 'actual NASM entry');
    const request = (command, args = {}) => current.session.customRequest(command, args);
    const runtime = await request('qemuAsm.dependencyReport');
    capability(runtime, 'qemu.rspTarget', 'supported', 'protocol'); capability(runtime, 'qemu.segmentRegisters', 'supported', 'protocol');
    capability(runtime, 'gdb.mi', 'unknown');
    const qemuRun = observed.find(item => item.args.includes('-gdb')); assert(qemuRun);
    assert.equal(runtime.scope.tools.qemu, qemuRun.command);
    assert(!qemuRun.args.includes('-qmp'), 'disabled display must not allocate QMP display resources');
    const stack = (await request('stackTrace', { threadId: 1 })).stackFrames;
    assert.equal(path.resolve(stack[0].source.path), path.join(root, 'boot.asm'));
    const memory = await request('qemuAsm.inspectMemory', { address: 0x7c00, count: 16, follow: 'address', space: 'physical' });
    assert.deepEqual(Buffer.from(memory.bytes), image.subarray(0, 16));
    capability(await request('qemuAsm.dependencyReport'), 'qemu.physicalMemory', 'supported', 'protocol');
    report = await vscode.commands.executeCommand('qemuAsm.showDependencyReport');
    assert.equal(report.runtimeReport.scope.sessionId, runtime.scope.sessionId);
    capability(report.runtimeReport, 'qemu.physicalMemory', 'supported', 'protocol');
    for (const entry of report.capabilities.entries) assert.equal(entry.state, 'unknown', 'basic doctor facts must remain separate from runtime evidence');
    await request('disconnect', { terminateDebuggee: true }); await until(() => terminated.has(current.session.id), 'NASM shutdown');
    console.log('PASS: actual native NASM debugging works with display disabled, and dependency report links separately scoped runtime/physical-memory evidence');

    // Inject only the optional resource allocation failure. VS Code, the DAP
    // adapter, executable resolver, NASM and QEMU remain the real production path.
    await configure(folder, { displayMode: 'auto' });
    originalScreenCreate = QemuScreen.create;
    let allocations = 0;
    QemuScreen.create = async function() { allocations++; throw new Error('injected display allocation failure'); };
    const fallbackStart = sessions.length, fallbackProcesses = observed.length;
    try {
      await vscode.commands.executeCommand('qemuAsm.debug'); current = await until(() => sessions[fallbackStart], 'display-fallback NASM session');
      await until(() => current.stops.length > 0, 'display-fallback real guest entry');
      assert.equal(allocations, 1, 'auto mode must actually attempt optional display allocation');
      const qemuFallback = observed.slice(fallbackProcesses).find(item => item.args.includes('-gdb'));
      assert(qemuFallback); assert(!qemuFallback.args.includes('-qmp'), 'failed allocation must leave no QMP launch resource');
      const beforeFrame = (await request('stackTrace', { threadId: 1 })).stackFrames[0];
      const stopsBefore = current.stops.length;
      await request('stepIn', { threadId: 1 }); await until(() => current.stops[stopsBefore], 'real step after display allocation failure');
      const afterFrame = (await request('stackTrace', { threadId: 1 })).stackFrames[0];
      assert.notEqual(afterFrame.instructionPointerReference, beforeFrame.instructionPointerReference);
      capability(await request('qemuAsm.dependencyReport'), 'qemu.rspTarget', 'supported', 'protocol');
      await request('disconnect', { terminateDebuggee: true }); await until(() => terminated.has(current.session.id), 'display-fallback shutdown');
    } finally { QemuScreen.create = originalScreenCreate; originalScreenCreate = undefined; }
    await configure(folder, { displayMode: 'off' });
    console.log('PASS (fault injection, not a native allocation-failure reproduction): optional display allocation failure preserves actual NASM/QEMU source frames and stepping');

    const externalRoot = path.join(folder.uri.fsPath, 'external builder without NASM'); await fs.mkdir(externalRoot);
    const marker = path.join(externalRoot, 'builder-was-run');
    await fs.writeFile(path.join(externalRoot, 'builder.cjs'), "const fs=require('node:fs');fs.writeFileSync('builder-was-run','yes');const b=Buffer.alloc(512);b.set([0xfa,0xeb,0xfe]);b[510]=0x55;b[511]=0xaa;fs.writeFileSync('build/boot.img',b);\n");
    await fs.writeFile(path.join(externalRoot, 'qemu-asm.json'), JSON.stringify({ build: { command: process.execPath, args: ['builder.cjs'] } }));
    await configure(folder, { projectDirectory: path.relative(folder.uri.fsPath, externalRoot), nasmPath: path.join(externalRoot, 'no NASM installed') });
    const before = observed.length; report = await vscode.commands.executeCommand('qemuAsm.checkEnvironment');
    assert.equal(report.status, 'passed'); assert.deepEqual(report.tools.map(item => item.id), ['builder', 'qemu']);
    tool(report, 'builder', 'not-run'); tool(report, 'qemu'); assert.equal(observed.length, before + 1);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    await vscode.commands.executeCommand('qemuAsm.build'); assert.equal(await fs.readFile(marker, 'utf8'), 'yes');
    assert.equal((await fs.readFile(path.join(externalRoot, 'build', 'boot.img'))).subarray(510).toString('hex'), '55aa');
    console.log('PASS: actual external build works without NASM; dependency check only resolves the builder, never runs it or appends --version');

    const fixture = await F.fixture(path.join(folder.uri.fsPath, 'C prebuilt dependency project')); await fixture.build();
    await fs.copyFile(fixture.image, path.join(fixture.root, 'prebuilt.img'));
    await fs.writeFile(path.join(fixture.root, 'copy-image.cjs'), "require('node:fs').copyFileSync('prebuilt.img','build/os.img');\n");
    await fs.writeFile(fixture.configPath, JSON.stringify({ ...fixture.configuration, build: { command: process.execPath, args: ['copy-image.cjs'] } }));
    await configure(folder, { projectDirectory: path.relative(folder.uri.fsPath, fixture.root), nasmPath: path.join(fixture.root, 'no NASM installed') });
    report = await vscode.commands.executeCommand('qemuAsm.checkEnvironment');
    assert.equal(report.status, 'passed'); assert.deepEqual(report.tools.map(item => item.id), ['builder', 'qemu', 'gdb']);
    tool(report, 'builder', 'not-run'); tool(report, 'qemu'); const gdb = tool(report, 'gdb');
    assert(path.isAbsolute(gdb.resolution.executable));
    const cSession = sessions.length;
    await vscode.commands.executeCommand('qemuAsm.debug'); current = await until(() => sessions[cSession], 'C debug session');
    await until(() => current.stops.length > 0, 'actual C kernel_main entry');
    const cReport = await request('qemuAsm.dependencyReport'); capability(cReport, 'gdb.mi', 'supported', 'protocol'); capability(cReport, 'qemu.rspTarget', 'supported', 'protocol');
    const cStack = (await request('stackTrace', { threadId: 1 })).stackFrames; assert.match(cStack[0].name, /kernel_main/); assert.equal(cStack[0].source.path, fixture.source);
    assert.notEqual(cReport.scope.sessionId, runtime.scope.sessionId, 'C target must have a new capability scope');
    await request('disconnect', { terminateDebuggee: true }); await until(() => terminated.has(current.session.id), 'C shutdown');
    console.log('PASS: actual native C debug uses the project-owned prebuilt artifacts without NASM, resolves GDB consistently and reports real MI/RSP evidence');
    for (const item of observed) { await item.run.done; assert(item.run.child.exitCode !== null || item.run.child.signalCode !== null, item.command + ' must exit'); }
    console.log(`PASS: dependency host cleanup completed; product=${extensionRoot}`);
  } finally {
    if (originalScreenCreate) QemuScreen.create = originalScreenCreate;
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); listener.dispose(); core.Processes.prototype.start = originalStart;
  }
};
