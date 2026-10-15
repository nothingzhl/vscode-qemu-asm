const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');
const { InspectorProvider } = require('../../dist/inspector/provider');
const { fixture, exerciseReal, exerciseProtected, until, HIGH_CODE, HIGH_DATA } = require('../../scripts/machine-debug-integration.cjs');

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  const folder = vscode.workspace.workspaceFolders[0];
  const qemus = [], providers = new Set(), snapshots = [], sessions = [], terminated = new Set();
  const original = { start: core.Processes.prototype.start, post: InspectorProvider.prototype.post };
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = original.start.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  InspectorProvider.prototype.post = function(message) {
    providers.add(this);
    if (message.type === 'snapshot' && this.ready && this.view) snapshots.push(JSON.parse(JSON.stringify(message)));
    return original.post.call(this, message);
  };
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [], failures: [], requests: [] }; sessions.push(record);
      return {
        onWillReceiveMessage(message) { if (message.type === 'request') record.requests.push(message.command); },
        onDidSendMessage(message) {
          if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body);
          if (message.type === 'response' && !message.success) record.failures.push(message);
        },
        onError(error) { record.failures.push({ message: error.message }); }
      };
    }
  });
  const terminatedListener = vscode.debug.onDidTerminateDebugSession(session => terminated.add(session.id));
  let current, provider;
  async function configure(project) {
    const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
    for (const [key, value] of Object.entries({
      projectDirectory: path.relative(folder.uri.fsPath, project.root), nasmPath: process.env.NASM_PATH || 'nasm',
      qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
    })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  function client() {
    let record;
    return {
      async launch() {
        const previous = sessions.length;
        assert.equal(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'Machine instructions and data watchpoints', stopOnEntry: true }), true);
        record = current = await until(() => sessions[previous], 'new real machine debug session');
        await until(() => record.stops[0], 'actual BIOS boot entry');
        assert.equal(record.stops[0].reason, 'entry');
        await vscode.commands.executeCommand('qemuAsm.showInspector');
        provider.receive({ type: 'configure', form: { tab: 'disassembly', disassemblyFollow: true } });
        await until(() => provider.model.snapshot.disassembly && !provider.model.snapshot.stale && !provider.model.snapshot.busy, 'actual paused disassembly model');
      },
      request(command, args = {}) { return record.session.customRequest(command, args); },
      async stoppedAfter(command, args = { threadId: 1 }) {
        const count = record.stops.length;
        await record.session.customRequest(command, args);
        return until(() => record.stops[count], `${command} actual QEMU stop`);
      },
      async disconnect() {
        await record.session.customRequest('disconnect', { terminateDebuggee: true });
        await until(() => terminated.has(record.session.id), 'VS Code machine session termination');
      }
    };
  }
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension);
    assert.equal(extension.isActive, false, 'the contributed inspector command must cold-activate the extension');
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    provider = await until(() => [...providers].find(item => item.ready && item.view?.visible), 'actual contributed WebviewView loads');
    for (const [command, tab] of [['qemuAsm.showDisassembly', 'disassembly'], ['qemuAsm.showDataBreakpoints', 'watchpoints']]) {
      await vscode.commands.executeCommand(command);
      await until(() => provider.view?.visible && provider.model.snapshot.form.tab === tab, `${command} selects its actual contributed inspector tab`);
    }
    await vscode.commands.executeCommand('qemuAsm.showDisassembly');
    assert.equal(provider.model.snapshot.form.tab, 'disassembly');
    assert.equal(qemus.length, 0, 'opening the inspector must not start QEMU');
    console.log(`VS Code ${vscode.version}; ${process.platform}/${process.arch}; phase=machine`);
    console.log('PASS: public disassembly/data-breakpoint commands cold-activate and select their actual WebviewView tabs without starting QEMU');
    const real = await fixture(path.join(folder.uri.fsPath, 'real16 machine test with spaces, and commas'), 'real16');
    await configure(real); await exerciseReal(client(), real);
    const protectedProject = await fixture(path.join(folder.uri.fsPath, 'protected32 machine test with spaces, and commas'), 'protected32');
    await configure(protectedProject);
    await exerciseProtected(client(), protectedProject, async evidence => {
      await vscode.commands.executeCommand('qemuAsm.showInspector');
      provider.receive({ type: 'configure', form: { tab: 'disassembly', disassemblyAddress: HIGH_CODE, disassemblyFollow: false } });
      await until(() => {
        const state = provider.model.snapshot;
        return !state.busy && !state.stale && state.disassembly?.address === HIGH_CODE && state.disassembly?.mode === 'protected32';
      }, 'real high-memory disassembly reaches the WebviewView');
      assert.equal(provider.model.snapshot.disassembly.instructions[0].instructionBytes.replace(/\s/g, '').toLowerCase(), '66b83412');
      provider.receive({ type: 'configure', form: { tab: 'watchpoints' } });
      await until(() => !provider.model.snapshot.busy && !provider.model.snapshot.stale && provider.model.snapshot.watchpoints?.lastHit?.address === HIGH_DATA, 'actual watchpoint hit reaches the WebviewView');
      assert.equal(provider.model.snapshot.watchpoints.lastHit.access, 'readWrite', 'QEMU reports an access watchpoint without distinguishing the operation');
      assert(provider.model.snapshot.watchpoints.breakpoints.some(item => item.address === HIGH_DATA && item.verified));
      assert(current.requests.includes('qemuAsm.disassemble')); assert(current.requests.includes('qemuAsm.watchpoints'));
      console.log('PASS: the actual contributed WebviewView receives live protected32 disassembly and read/write watchpoint hit state through DAP');

      const ready = process.env.QEMU_ASM_MACHINE_UI_READY;
      if (!ready) return;
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(protectedProject.source), { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      const line = protectedProject.line('jmp 0x08:0x100000') - 1;
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('qemuAsm.showDisplay');
      await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
      await vscode.commands.executeCommand('qemuAsm.showInspector');
      provider.receive({ type: 'configure', form: { tab: 'disassembly', disassemblyAddress: HIGH_CODE, disassemblyFollow: false } });
      await until(() => !provider.model.snapshot.busy && !provider.model.snapshot.stale && provider.model.snapshot.disassembly?.address === HIGH_CODE, 'live disassembly ready for UI interaction');
      await fs.writeFile(ready, JSON.stringify({
        vscodeVersion: vscode.version, platform: process.platform, architecture: process.arch,
        source: protectedProject.source, mode: 'protected32', codeAddress: HIGH_CODE, dataAddress: HIGH_DATA,
        pc: Number(evidence.frame.instructionPointerReference), disassembly: evidence.disassembly, watchpoints: evidence.watchpoints,
        sourceOfEvidence: 'Actual VS Code WebviewView, native DAP and real QEMU executing source-independent code at 0x100000; no UI or debugger mocks.'
      }, null, 2));
      let probeSerial;
      await until(async () => {
        if (await exists(`${ready}.continue`)) return true;
        let probe;
        try { probe = JSON.parse(await fs.readFile(`${ready}.probe`, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
        if (Number.isSafeInteger(probe.serial) && probe.serial !== probeSerial) {
          const [instructionBreakpoints, watchpoints] = await Promise.all([
            current.session.customRequest('qemuAsm.instructionBreakpoints', { action: 'list' }),
            current.session.customRequest('qemuAsm.watchpoints', { action: 'list' })
          ]);
          await fs.writeFile(`${ready}.probe-result`, JSON.stringify({ serial: probe.serial, instructionBreakpoints, watchpoints }, null, 2));
          probeSerial = probe.serial;
        }
        return false;
      }, 'actual machine-debug screenshot completion', 180000);
    });
    const fresh = client(); await fresh.launch();
    assert.deepEqual((await fresh.request('qemuAsm.watchpoints', { action: 'list' })).breakpoints, []);
    await fresh.disconnect();
    for (const run of qemus) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null, 'every owned QEMU must exit'); }
    assert(qemus.length >= 4);
    const failures = sessions.flatMap(session => session.failures);
    assert.equal(failures.length, 1, JSON.stringify(failures));
    assert.equal(failures[0].command, 'qemuAsm.disassemble', 'only the deliberate running-CPU inspection rejection is expected');
    assert(snapshots.some(item => item.disassembly?.mode === 'real16'));
    assert(snapshots.some(item => item.disassembly?.mode === 'protected32'));
    console.log('PASS: the real host rejects inspection while running, isolates new sessions and cleans every owned QEMU on restart/disconnect');
  } finally {
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); terminatedListener.dispose();
    core.Processes.prototype.start = original.start; InspectorProvider.prototype.post = original.post;
  }
};
