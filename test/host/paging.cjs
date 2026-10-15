const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');
const { InspectorProvider } = require('../../dist/inspector/provider');
const P = require('../../scripts/paging-integration.cjs');

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
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
  const uiTransitionFailures = new Set();
  function client() {
    let record;
    return {
      async launch() {
        const previous = sessions.length;
        assert.equal(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'Nonidentity virtual paging debug', stopOnEntry: true }), true);
        record = current = await P.until(() => sessions[previous], 'new real paging debug session');
        await P.until(() => record.stops[0], 'actual BIOS entry');
        assert.equal(record.stops[0].reason, 'entry');
      },
      request(command, args = {}) { return record.session.customRequest(command, args); },
      async stoppedAfter(command, args = { threadId: 1 }) {
        const count = record.stops.length;
        await record.session.customRequest(command, args);
        return P.until(() => record.stops[count], `${command} actual paging guest stop`);
      },
      async disconnect() {
        await record.session.customRequest('disconnect', { terminateDebuggee: true });
        await P.until(() => terminated.has(record.session.id), 'actual paging session termination');
      }
    };
  }
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension);
    assert.equal(extension.isActive, false, 'showPaging must cold-activate the extension');
    await vscode.commands.executeCommand('qemuAsm.showPaging');
    provider = await P.until(() => [...providers].find(item => item.ready && item.view?.visible), 'actual paging WebviewView loads');
    await P.until(() => provider.model.snapshot.form.tab === 'paging', 'public command selects paging tab');
    assert.equal(qemus.length, 0);
    console.log(`VS Code ${vscode.version}; ${process.platform}/${process.arch}; phase=paging`);
    console.log('PASS: public showPaging command cold-activates and selects the real paging inspector without starting a guest');
    const project = await P.fixture(path.join(folder.uri.fsPath, 'nonidentity paging with spaces, and commas'));
    const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
    for (const [key, value] of Object.entries({
      projectDirectory: path.relative(folder.uri.fsPath, project.root), nasmPath: process.env.NASM_PATH || 'nasm',
      qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
    })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    await P.exercisePaging(client(), project, async evidence => {
      await vscode.commands.executeCommand('qemuAsm.showPaging');
      provider.receive({ type: 'configure', form: { tab: 'paging', pagingAddress: P.HIGH_DATA } });
      await P.until(() => {
        const state = provider.model.snapshot;
        return !state.busy && !state.stale && state.paging?.address === P.HIGH_DATA && state.paging?.status === 'mapped';
      }, 'actual paging snapshot in contributed WebviewView');
      assert.equal(provider.model.snapshot.paging.physicalAddress, P.DATA_PHYSICAL);
      provider.receive({ type: 'configure', form: { tab: 'memory', address: P.DATA_PHYSICAL, follow: 'address', memorySpace: 'physical', count: 32 } });
      await P.until(() => {
        const state = provider.model.snapshot;
        return !state.busy && !state.stale && state.memory?.address === P.DATA_PHYSICAL && state.memory?.space === 'physical';
      }, 'actual physical memory snapshot in contributed WebviewView');
      assert.equal(Buffer.from(provider.model.snapshot.memory.bytes).readUInt32LE(), 2);
      provider.receive({ type: 'configure', form: { tab: 'paging', pagingAddress: P.HIGH_DATA } });
      await P.until(() => !provider.model.snapshot.busy && !provider.model.snapshot.stale && provider.model.snapshot.paging?.address === P.HIGH_DATA, 'paging UI restored');
      assert(current.requests.includes('qemuAsm.inspectPaging'));
      assert(current.requests.includes('qemuAsm.inspectMemory'));
      console.log('PASS: actual contributed WebviewView receives real CR3/PDE/PTE translation and physical RAM through the active DAP session');

      const ready = process.env.QEMU_ASM_PAGING_UI_READY;
      if (!ready) return;
      const failureStart = current.failures.length;
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(project.source), { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      const line = project.line('jmp 0x08:0xc0000000') - 1;
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('qemuAsm.showDisplay');
      await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
      await vscode.commands.executeCommand('qemuAsm.showPaging');
      await fs.writeFile(ready, JSON.stringify({
        vscodeVersion: vscode.version, platform: process.platform, architecture: process.arch,
        source: project.source, mode: 'protected32', linearAddress: P.HIGH_DATA, physicalAddress: P.DATA_PHYSICAL,
        pdeAddress: P.PD + 768 * 4, pteAddress: P.HIGH_PT + 256 * 4, unmappedAddress: P.HIGH_MISSING,
        pc: Number(evidence.frame.instructionPointerReference), cr3: P.PD, dataValue: 2,
        page: evidence.page, disassembly: evidence.disassembly, watchpoints: evidence.watchpoints,
        sourceOfEvidence: 'Actual VS Code WebviewView and native DAP, with real QEMU executing nonidentity legacy32 paging; no UI or debugger mocks.'
      }, null, 2));
      let probeSerial;
      await P.until(async () => {
        if (await exists(`${ready}.continue`)) return true;
        let probe;
        try { probe = JSON.parse(await fs.readFile(`${ready}.probe`, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
        if (Number.isSafeInteger(probe.serial) && probe.serial !== probeSerial) {
          const [paging, virtualMemory, physicalMemory] = await Promise.all([
            current.session.customRequest('qemuAsm.inspectPaging', { address: P.HIGH_DATA }),
            current.session.customRequest('qemuAsm.inspectMemory', { address: P.HIGH_DATA, count: 32, follow: 'address', space: 'virtual' }),
            current.session.customRequest('qemuAsm.inspectMemory', { address: P.DATA_PHYSICAL, count: 32, follow: 'address', space: 'physical' })
          ]);
          await fs.writeFile(`${ready}.probe-result`, JSON.stringify({ serial: probe.serial, paging, virtualMemory, physicalMemory }, null, 2));
          probeSerial = probe.serial;
        }
        return false;
      }, 'actual paging screenshot completion', 180000);
      // Switching a live selector starts a physical read before the following
      // address submission. The old high virtual address is outside RAM as a
      // physical address. Only that exact, observed E14 transition is allowed;
      // any other debugger failure remains a host test failure.
      for (const failure of current.failures.slice(failureStart)) {
        assert.equal(failure.command, 'qemuAsm.inspectMemory', JSON.stringify(failure));
        assert.match(failure.message, /\bE14\b/, JSON.stringify(failure));
        uiTransitionFailures.add(failure);
      }
    });
    const fresh = client(); await fresh.launch();
    assert.deepEqual((await fresh.request('qemuAsm.watchpoints', { action: 'list' })).breakpoints, []);
    await fresh.disconnect();
    for (const run of qemus) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null, 'every owned QEMU exits'); }
    assert(qemus.length >= 3);
    const failures = sessions.flatMap(session => session.failures).filter(failure => !uiTransitionFailures.has(failure));
    assert.equal(failures.length, 3, JSON.stringify(failures));
    assert.equal(failures.filter(item => item.command === 'qemuAsm.inspectPaging').length, 1);
    assert.equal(failures.filter(item => item.command === 'qemuAsm.inspectMemory').length, 2);
    assert(snapshots.some(item => item.paging?.status === 'mapped' && item.paging?.pagingEnabled));
    assert(snapshots.some(item => item.memory?.space === 'physical'));
    console.log('PASS: real VS Code host enforces running read guards, isolates a fresh session and cleans every owned QEMU');
  } finally {
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); terminatedListener.dispose();
    core.Processes.prototype.start = original.start; InspectorProvider.prototype.post = original.post;
  }
};
