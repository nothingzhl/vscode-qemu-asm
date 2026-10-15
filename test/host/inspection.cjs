const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');
const { InspectorProvider } = require('../../dist/inspector/provider');

async function until(predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timeout waiting for ${description}`);
}
function number(value) { return Number(/0x[0-9a-f]+/i.exec(String(value))?.[0] ?? value); }
function afterLabel(source, label) {
  const lines = source.split('\n'); let index = lines.findIndex(line => line.trim() === `${label}:`);
  assert(index >= 0, `Sample must contain ${label}`);
  do { index++; } while (index < lines.length && (!lines[index].trim() || lines[index].trim().startsWith(';') || lines[index].trim().endsWith(':')));
  return index + 1;
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

// Observe messages sent to the actual WebviewView and real child processes.
// Original methods, VS Code APIs, requests and executable paths stay intact.
function observe() {
  const original = { post: InspectorProvider.prototype.post, start: core.Processes.prototype.start };
  const snapshots = [], providers = new Set(), qemus = [];
  InspectorProvider.prototype.post = function(message) {
    providers.add(this);
    if (message.type === 'snapshot' && this.ready && this.view) snapshots.push(JSON.parse(JSON.stringify(message)));
    return original.post.call(this, message);
  };
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = original.start.call(this, command, args, cwd, log);
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  return { snapshots, providers, qemus, restore() { InspectorProvider.prototype.post = original.post; core.Processes.prototype.start = original.start; } };
}

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  const [folder] = vscode.workspace.workspaceFolders;
  const projectDirectory = 'inspection 学习 project with spaces, and commas';
  const projectRoot = path.join(folder.uri.fsPath, projectDirectory);
  await core.createProject(projectRoot, 'protected');
  const boot = path.join(projectRoot, 'boot.asm'), stage = path.join(projectRoot, 'stage2.asm');
  const source = await fs.readFile(stage, 'utf8');
  const nested = afterLabel(source, 'learning_breakpoint');
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({ projectDirectory, nasmPath: process.env.NASM_PATH || 'nasm', qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M'] })) {
    await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  const observed = observe(), sessions = [], terminated = new Set();
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
  let current;
  async function launch() {
    const previous = sessions.length;
    assert.equal(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'Memory + GDT/IDT OS learning', stopOnEntry: true }), true);
    current = await until(() => sessions[previous], 'new inspection debug session');
    await until(() => current.stops[0], 'actual BIOS boot entry stop');
    return current;
  }
  async function stoppedAfter(record, command, args = { threadId: 1 }) {
    const count = record.stops.length; await record.session.customRequest(command, args);
    await until(() => record.stops.length > count, `${command} actual CPU stop`);
  }
  async function snapshot(after = 0, predicate = () => true) {
    return until(() => observed.snapshots.slice(after).find(item => item.status === 'stopped' && !item.stale && !item.busy && item.memory && predicate(item)), 'fresh actual webview memory snapshot');
  }
  async function disconnect(record) {
    await record.session.customRequest('disconnect', { terminateDebuggee: true });
    await until(() => terminated.has(record.session.id), 'VS Code inspection session termination');
  }
  async function registers(record) {
    const trace = await record.session.customRequest('stackTrace', { threadId: 1 });
    const { scopes } = await record.session.customRequest('scopes', { frameId: trace.stackFrames[0].id });
    const scope = scopes.find(item => /寄存器|register/i.test(item.name)); assert(scope);
    const { variables } = await record.session.customRequest('variables', { variablesReference: scope.variablesReference });
    return Object.fromEntries(variables.map(variable => [variable.name.toLowerCase(), number(variable.value)]));
  }
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension);
    assert.equal(extension.isActive, false, 'the inspector command must activate a cold extension');
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    const provider = await until(() => [...observed.providers].find(item => item.ready && item.view?.visible), 'actual contributed inspector webview loads its script');
    assert(extension.isActive);
    assert.equal(provider.view.viewType, 'qemuAsm.inspector');
    await until(() => observed.snapshots.find(item => item.status === 'idle'), 'idle webview snapshot');
    assert.equal(observed.qemus.length, 0, 'opening the passive inspector must not start a guest');
    console.log(`VS Code ${vscode.version}; ${process.platform}/${process.arch}; phase=inspection`);
    console.log('PASS: the contributed bottom WebviewView activates cold, loads the real media script and opens without starting QEMU');

    let after = observed.snapshots.length;
    const record = await launch();
    // The display opens beside source; restore inspector visibility through its
    // public focus command and let its real ready message trigger a CPU read.
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    const first = await snapshot(after, item => item.memory.mode === 'real16');
    assert(record.requests.includes('qemuAsm.inspectMemory'), 'the webview must request bytes from the real debug adapter');
    const actual = await record.session.customRequest('qemuAsm.inspectMemory', { address: 0x7c00, count: 256 });
    assert.equal(first.memory.address, 0x7c00); assert.deepEqual(first.memory.bytes, actual.bytes);
    assert.equal(first.memory.changed.some(Boolean), false, 'first snapshot has no previous RAM values');
    const ivt = await record.session.customRequest('qemuAsm.inspectDescriptors', { table: 'idt', start: 3, count: 1 });
    assert.equal(ivt.format, 'ivt'); assert.equal(ivt.entries[0].index, 3);
    console.log('PASS: the real host tracker sends the first stopped memory snapshot through DAP and exposes the BIOS IVT');

    const bp = await record.session.customRequest('setBreakpoints', { source: { name: path.basename(stage), path: stage }, breakpoints: [{ line: nested }] });
    assert.equal(bp.breakpoints[0].verified, true);
    after = observed.snapshots.length; await stoppedAfter(record, 'continue');
    const continued = observed.snapshots.slice(after).find(item => item.status === 'running' && item.stale);
    assert(continued, 'continued event must visibly mark the last stopped bytes as stale');
    assert.deepEqual(continued.memory.bytes, first.memory.bytes);
    const inside = await snapshot(after, item => item.memory.mode === 'protected32');
    assert.equal(inside.memory.address, 0x7c00);
    const r = await registers(record); assert.equal(r.esp, 0x8ffec); assert.equal(r.ebp, 0x8ffec);
    const stack = await record.session.customRequest('qemuAsm.inspectMemory', { follow: 'esp', count: 16 });
    assert.equal(stack.address, r.esp); assert.equal(Buffer.from(stack.bytes).readUInt32LE(8), 0x11223344);
    const gdt = await record.session.customRequest('qemuAsm.inspectDescriptors', { table: 'gdt' });
    const idt = await record.session.customRequest('qemuAsm.inspectDescriptors', { table: 'idt' });
    assert.equal(gdt.limit, 23); assert.equal(gdt.entries[1].effectiveLimit, 0xffffffff);
    assert(gdt.entries[1].registers.includes('CS')); assert(gdt.entries[2].registers.includes('SS'));
    assert.equal(idt.limit, 31); assert.equal(idt.entries[3].gateBits, 32); assert.equal(idt.entries[3].selector, 8);
    const data = await record.session.customRequest('qemuAsm.inspectMemory', { address: r.edi, count: 12 });
    assert.equal(Buffer.from(data.bytes).toString('hex'), '443322118877665500000000');
    console.log('PASS: continued marks stale bytes, the next protected32 stop refreshes them, and actual GDT/IDT plus SS:ESP requests match CPU state');

    const ready = process.env.QEMU_ASM_INSPECTION_UI_READY;
    if (ready) {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(stage), { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      editor.selection = new vscode.Selection(nested - 1, 0, nested - 1, 0);
      editor.revealRange(new vscode.Range(nested - 1, 0, nested - 1, 0), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('qemuAsm.showDisplay');
      await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
      await vscode.commands.executeCommand('qemuAsm.showInspector');
      await fs.writeFile(ready, JSON.stringify({
        vscodeVersion: vscode.version, platform: process.platform, architecture: process.arch, source: stage, line: nested,
        mode: 'protected32', dataAddress: r.edi, expectedData: Buffer.from(data.bytes).toString('hex'),
        registers: Object.fromEntries(['edi', 'esp', 'ebp', 'eax', 'cr0', 'cs', 'ss'].map(name => [name, r[name]])), gdt, idt,
        sourceOfEvidence: 'Actual VS Code WebviewView, live DAP tracker and QEMU; no debugger or UI mocks.'
      }, null, 2));
      const action = await until(async () => await exists(`${ready}.step`) ? 'step' : await exists(`${ready}.continue`) ? 'continue' : false, 'actual inspector UI address selection', 120000);
      if (action === 'step') {
        assert.equal(provider.model.snapshot.form.address, r.edi, 'the CDP user action must select actual lesson data before stepping');
        assert.equal(provider.model.snapshot.form.tab, 'memory');
        await until(() => provider.model.snapshot.memory?.address === r.edi && !provider.model.snapshot.stale && !provider.model.snapshot.busy, 'UI initial RAM baseline');
        after = observed.snapshots.length;
        await stoppedAfter(record, 'stepIn'); await stoppedAfter(record, 'stepIn');
        const changed = await snapshot(after, item => item.memory.address === r.edi && item.memory.bytes[8] === 1 && item.memory.changed[8] === true);
        assert.equal(changed.memory.changed.filter(Boolean).length, 1, 'exactly the INC target byte must be highlighted');
        const trace = await record.session.customRequest('stackTrace', { threadId: 1 });
        await fs.writeFile(`${ready}.changed`, JSON.stringify({ address: r.edi, bytes: changed.memory.bytes, changed: changed.memory.changed, source: stage, line: trace.stackFrames[0].line, actualGuestWrite: 'INC dword [inspection_data+8]' }, null, 2));
      }
      await until(() => exists(`${ready}.continue`), 'actual inspector screenshot completion', 120000);
    }

    after = observed.snapshots.length; const previousQemus = observed.qemus.length;
    await stoppedAfter(record, 'restart', {});
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    const restarted = await snapshot(after, item => item.memory.mode === 'real16');
    assert.equal(observed.qemus.length, previousQemus + 1);
    assert.equal(restarted.memory.changed.some(Boolean), false, 'restart must clear previous RAM-change history');
    after = observed.snapshots.length; await disconnect(record);
    const cleared = await until(() => observed.snapshots.slice(after).find(item => item.status === 'idle'), 'terminated clears inspector data');
    assert.equal(cleared.memory, undefined); assert.equal(cleared.gdt, undefined); assert.equal(cleared.idt, undefined);
    assert(provider.view?.visible, 'the passive inspector remains available after debug termination');
    after = observed.snapshots.length;
    const again = await launch(); await vscode.commands.executeCommand('qemuAsm.showInspector');
    const newSession = await snapshot(after, item => item.memory.mode === 'real16');
    assert.equal(newSession.memory.changed.some(Boolean), false);
    await disconnect(again);
    for (const run of observed.qemus) { await run.done; assert(run.child.exitCode !== null || run.child.signalCode !== null, 'every owned QEMU must exit'); }
    for (const item of sessions) assert.deepEqual(item.failures, [], 'all actual host inspection DAP requests must succeed');
    console.log('PASS: restart and a fresh active session reset byte history, termination clears snapshots, and all owned QEMU processes exit');
  } finally {
    if (current && !terminated.has(current.session.id)) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop'); tracker.dispose(); terminatedListener.dispose(); observed.restore();
  }
};
