// Real command, QuickPick, multi-root and DAP acceptance. Copied outside the
// checkout for the installed-VSIX suite; every product import is package-local.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const extensionRoot = process.env.QEMU_ASM_VSIX_EXTENSION || path.resolve(__dirname, '../..');
const core = require(path.join(extensionRoot, 'dist', 'core.js'));
const F = process.env.QEMU_ASM_VSIX_EXTENSION ? require('./c-source-fixture.cjs') : require('../../scripts/c-source-fixture.cjs');
const profiles = {
  small: { memoryMiB: 16, cpuModel: 'qemu32', display: false },
  normal: { memoryMiB: 64, cpuModel: 'pentium3', display: true }
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(40); }
  throw new Error('Timeout waiting for ' + description);
}
async function configure(folder, values) {
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries(values)) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function captureProfileUI(record, folder, root, args) {
  const ready = process.env.QEMU_ASM_MACHINE_PROFILES_UI_READY; if (!ready) return;
  const source = path.join(root, 'boot.asm');
  const line = (await fs.readFile(source, 'utf8')).split('\n').findIndex(text => text.trim() === 'hlt') + 1;
  await record.session.customRequest('setBreakpoints', { source: { path: source }, breakpoints: [{ line }] });
  const before = record.stops.length;
  await record.session.customRequest('continue', { threadId: 1 });
  await until(() => record.stops[before], 'real printed boot marker breakpoint');
  await vscode.commands.executeCommand('qemuAsm.configureMachineProfiles', { workspaceUri: folder.uri.toString() });
  await vscode.commands.executeCommand('workbench.view.debug');
  await vscode.commands.executeCommand('qemuAsm.showDisplay');
  await vscode.commands.executeCommand('notifications.clearAll');
  const report = await record.session.customRequest('qemuAsm.dependencyReport');
  await fs.writeFile(ready, JSON.stringify({ vscodeVersion: vscode.version, root, source, line, workspaceUri: folder.uri.toString(), args, report }, null, 2));
  const deadline = Date.now() + 60000; let picked = false;
  while (!(await exists(ready + '.continue'))) {
    if (Date.now() > deadline) throw new Error('Machine profile screenshot handshake timed out');
    if (!picked && await exists(ready + '.pick')) {
      picked = true; await fs.writeFile(ready + '.picking', 'ready');
      await vscode.commands.executeCommand('qemuAsm.selectMachineProfile', { workspaceUri: folder.uri.toString() });
    }
    await delay(50);
  }
}
function effective(args, flag) { return args[args.indexOf(flag) + 1]; }
function verifyLaunch(run, name) {
  const profile = profiles[name]; assert(run, 'owned QEMU must launch');
  assert.equal(run.args.filter(value => value === '-m').length, 1);
  assert.equal(Number.parseInt(effective(run.args, '-m')), profile.memoryMiB);
  assert.equal(effective(run.args, '-cpu'), profile.cpuModel);
  assert.equal(run.args.includes('-qmp'), profile.display);
}
exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  const folders = vscode.workspace.workspaceFolders; assert.equal(folders.length, 2);
  const [first, second] = folders;
  const observed = [], sessions = [], terminated = new Set(), currentSessions = new Set();
  const original = core.Processes.prototype.start;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const observation = { command, args, output: '' };
    const run = original.call(this, command, args, cwd, text => { observation.output += text; log(text); });
    Object.assign(observation, { run }); observed.push(observation); return run;
  };
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [], failures: [] }; sessions.push(record); currentSessions.add(session);
      return { onDidSendMessage(message) {
        if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body);
        if (message.type === 'response' && !message.success) record.failures.push(message);
      } };
    }
  });
  const listener = vscode.debug.onDidTerminateDebugSession(session => { terminated.add(session.id); currentSessions.delete(session); });
  const select = (folder, name) => vscode.commands.executeCommand('qemuAsm.selectMachineProfile', { name, workspaceUri: folder.uri.toString() });
  const qemus = () => observed.filter(item => item.args.includes('-drive'));
  async function doctor() {
    const pending = vscode.commands.executeCommand('qemuAsm.checkEnvironment');
    await delay(1000); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const report = await pending;
    if (!report) {
      for (const document of vscode.workspace.textDocuments) console.log('REPORT DIAGNOSTIC', document.uri.toString(), document.getText().slice(-5000));
    }
    assert(report, 'real dependency-report command must complete after workspace selection');
    return report;
  }
  async function launch(folder, machineProfile) {
    const before = sessions.length;
    assert.equal(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'Actual startup profile', stopOnEntry: true,
      ...(machineProfile === undefined ? {} : { machineProfile }) }), true);
    const record = await until(() => sessions[before], 'new profile debug session');
    await until(() => record.stops[0], 'profile guest entry'); return record;
  }
  async function stoppedAfter(record, command, args = {}) {
    const before = record.stops.length; await record.session.customRequest(command, args);
    await until(() => record.stops[before], command + ' guest stop');
  }
  async function disconnect(record) {
    await record.session.customRequest('disconnect', { terminateDebuggee: true });
    await until(() => terminated.has(record.session.id), 'profile session termination');
  }
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension); await extension.activate();
    assert((await vscode.commands.getCommands(true)).includes('qemuAsm.selectMachineProfile'));
    if (process.env.QEMU_ASM_VSIX_EXTENSION) {
      assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(extensionRoot));
      assert.equal(path.dirname(__filename), path.join(process.env.QEMU_ASM_VSIX_TEST_ROOT, 'external-tests'));
    }
    const roots = folders.map(folder => path.join(folder.uri.fsPath, 'project with spaces, and commas'));
    for (let index = 0; index < folders.length; index++) {
      await core.createProject(roots[index]);
      await fs.writeFile(path.join(roots[index], 'qemu-asm.json'), JSON.stringify({ machineProfiles: profiles, defaultMachineProfile: 'small' }, null, 2));
      await configure(folders[index], { projectDirectory: path.relative(folders[index].uri.fsPath, roots[index]),
        nasmPath: process.env.NASM_PATH || 'nasm', qemuPath: process.env.QEMU_PATH || 'qemu-system-i386',
        gdbPath: path.join(roots[index], 'GDB must not run'), qemuArgs: ['-m', '32M', '-cpu', 'qemu32', '-smp', '1'], displayMode: 'auto' });
    }
    const configBefore = await fs.readFile(path.join(roots[0], 'qemu-asm.json'), 'utf8');
    await vscode.commands.executeCommand('qemuAsm.configureMachineProfiles', { workspaceUri: first.uri.toString() });
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(roots[0], 'qemu-asm.json'));
    assert.equal(vscode.window.activeTextEditor.document.getText(), configBefore, 'configuration command must not rewrite user files');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    let record = await launch(first); verifyLaunch(qemus().at(-1), 'small');
    // A stopped DAP event precedes the renderer opening its source editor.
    // Let that actual focus transition finish before opening a workspace picker.
    await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(roots[0], 'boot.asm'), 'native debugger source editor');
    const defaultReport = await doctor();
    assert.deepEqual(defaultReport.launchConfiguration.profile, { name: 'small', source: 'default' });
    assert.equal(defaultReport.launchConfiguration.memory.value, '16M');
    await select(first, 'normal'); assert.equal(qemus().length, 1, 'selection must not restart the active guest');
    const selectedReport = await doctor();
    assert.deepEqual(selectedReport.launchConfiguration.profile, { name: 'normal', source: 'selected' });
    assert.equal(selectedReport.launchConfiguration.display.source, 'profile');
    assert.equal(effective(selectedReport.runtimeReport.scope.machine, '-m'), '16M', 'active-session facts must keep the original guest configuration');
    verifyLaunch(qemus()[0], 'small');
    await stoppedAfter(record, 'restart'); verifyLaunch(qemus().at(-1), 'normal');
    await qemus()[0].run.done;
    await captureProfileUI(record, first, roots[0], qemus().at(-1).args);
    await disconnect(record);
    record = await launch(second); verifyLaunch(qemus().at(-1), 'small'); await disconnect(record);
    record = await launch(first, 'small'); verifyLaunch(qemus().at(-1), 'small');
    await stoppedAfter(record, 'restart'); verifyLaunch(qemus().at(-1), 'small'); await disconnect(record);
    console.log('PASS: real multi-root NASM debug defaults, remembered selection, next-restart application and explicit launch precedence; display allocates QMP only for enabled profiles');

    // Drive the real VS Code QuickPick, including cancellation. No replacement
    // of window.showQuickPick, configuration API, process or debug adapter.
    const cancelled = vscode.commands.executeCommand('qemuAsm.selectMachineProfile', { workspaceUri: first.uri.toString() });
    await delay(300); await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    assert.equal(await cancelled, undefined);
    record = await launch(first); verifyLaunch(qemus().at(-1), 'normal'); await disconnect(record);
    await select(first, null);
    const chosen = vscode.commands.executeCommand('qemuAsm.selectMachineProfile', { workspaceUri: first.uri.toString() });
    await delay(300);
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await delay(150); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    assert.equal(await chosen, 'normal');
    record = await launch(first); verifyLaunch(qemus().at(-1), 'normal'); await disconnect(record);
    console.log('PASS: actual QuickPick cancellation preserves the prior choice; keyboard selection persists the chosen startup profile');

    const alternate = path.join(first.uri.fsPath, 'other project in same workspace'); await core.createProject(alternate);
    await fs.writeFile(path.join(alternate, 'qemu-asm.json'), JSON.stringify({ machineProfiles: profiles, defaultMachineProfile: 'small' }, null, 2));
    await configure(first, { projectDirectory: path.relative(first.uri.fsPath, alternate) });
    record = await launch(first); verifyLaunch(qemus().at(-1), 'small'); await disconnect(record);
    await configure(first, { projectDirectory: path.relative(first.uri.fsPath, roots[0]) });
    record = await launch(first); verifyLaunch(qemus().at(-1), 'normal'); await disconnect(record);
    const beforeInvalid = qemus().length;
    assert.equal(await select(first, 'missing-profile'), undefined, 'public command reports invalid selection');
    assert.equal(qemus().length, beforeInvalid);
    record = await launch(first); verifyLaunch(qemus().at(-1), 'normal'); await disconnect(record);
    console.log('PASS: projectDirectory changes isolate remembered selections within one workspace; invalid choices do not start a process');

    const runCommand = vscode.commands.executeCommand('qemuAsm.run');
    await delay(1000); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await runCommand;
    const running = qemus().at(-1); verifyLaunch(running, 'normal');
    await until(() => running.output.includes(core.MARKER), 'real run-mode serial marker');
    await vscode.commands.executeCommand('qemuAsm.stop'); await running.run.done;
    console.log('PASS: public run command also uses the selected memory/CPU/display profile and boots the actual guest');

    const fixture = await F.fixture(path.join(first.uri.fsPath, 'C profile project'));
    await fs.writeFile(fixture.configPath, JSON.stringify({ ...fixture.configuration, machineProfiles: profiles, defaultMachineProfile: 'small' }));
    await configure(first, { projectDirectory: path.relative(first.uri.fsPath, fixture.root), gdbPath: process.env.GDB_PATH || 'gdb' });
    record = await launch(first); verifyLaunch(qemus().at(-1), 'small');
    const request = (command, args = {}) => record.session.customRequest(command, args);
    await request('setBreakpoints', { source: { path: fixture.source }, breakpoints: [{ line: fixture.line('KERNEL_READY') }] });
    await stoppedAfter(record, 'continue', { threadId: 1 });
    const frame = (await request('stackTrace', { threadId: 1 })).stackFrames[0];
    assert.match(frame.name, /kernel_main/);
    assert.equal(Number((await request('evaluate', { expression: 'sample.left', frameId: frame.id })).result), 17);
    await select(first, 'normal'); await stoppedAfter(record, 'restart'); verifyLaunch(qemus().at(-1), 'normal');
    await assert.rejects(request('evaluate', { expression: 'sample.left', frameId: frame.id }), /帧|frame|过期|invalid/i);
    const report = await request('qemuAsm.dependencyReport');
    assert.equal(report.scope.backend, 'c-gdb-mi');
    await disconnect(record);
    for (const item of observed) await item.run.done;
    console.log(`PASS: VS Code ${vscode.version} C/GDB profiles initialize DWARF variables and apply a new profile on restart; old handles fail; every owned process exits; product=${extensionRoot}`);
  } finally {
    for (const session of currentSessions) await vscode.debug.stopDebugging(session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); listener.dispose(); core.Processes.prototype.start = original;
  }
};
