// Real NASM guest: demonstrate CR0.PE, the far jump, native registers and EBP callers.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core.js');
const { InspectorProvider } = require('../../dist/inspector/provider.js');
const { until, serve } = require('./host-utils.cjs');

exports.run = async function run() {
  assert(vscode.workspace.isTrusted);
  const folder = vscode.workspace.workspaceFolders[0];
  const providers = new Set(), records = [], breakpoints = [];
  const originalPost = InspectorProvider.prototype.post;
  InspectorProvider.prototype.post = function(message) { providers.add(this); return originalPost.call(this, message); };
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [], failures: [] }; records.push(record);
      return { onDidSendMessage(message) {
        if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body);
        if (message.type === 'response' && !message.success) record.failures.push(message);
      } };
    }
  });
  let current;
  try {
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    const provider = await until(() => [...providers].find(item => item.ready && item.view?.visible), 'live inspector');
    const projectRoot = path.join(folder.uri.fsPath, 'Protected mode kernel');
    await core.createProject(projectRoot, 'protected');
    const source = path.join(projectRoot, 'stage2.asm');
    const text = await fs.readFile(source, 'utf8'), lines = text.split('\n');
    const line = instruction => {
      const value = lines.findIndex(item => item.trim() === instruction) + 1;
      assert(value > 0); return value;
    };
    const nested = lines.findIndex(item => item === 'learning_breakpoint:') + 2;
    const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
    for (const [key, value] of Object.entries({ projectDirectory: path.relative(folder.uri.fsPath, projectRoot),
      nasmPath: process.env.NASM_PATH || 'nasm', qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
    })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    const uri = vscode.Uri.file(source);
    for (const target of [line('mov cr0, eax'), nested]) {
      const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(target - 1, 0)));
      breakpoints.push(bp);
    }
    vscode.debug.addBreakpoints(breakpoints);
    await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'NASM protected-mode debug', stopOnEntry: true });
    current = await until(() => records[0], 'actual assembly session');
    await until(() => current.stops.length === 1, 'boot entry');
    const request = (command, args = {}) => current.session.customRequest(command, args);
    const frames = async () => (await request('stackTrace', { threadId: 1, levels: 20 })).stackFrames;
    const motion = async kind => {
      const commands = { continue: 'workbench.action.debug.continue', stepIn: 'workbench.action.debug.stepInto',
        next: 'workbench.action.debug.stepOver', stepOut: 'workbench.action.debug.stepOut' };
      assert(commands[kind], `Unknown motion ${kind}`);
      const before = current.stops.length;
      await vscode.commands.executeCommand(commands[kind]);
      await until(() => current.stops.length > before, `native ${kind} stop`);
      return { stop: current.stops.at(-1), stack: await frames() };
    };
    // Initial host setup can precede the renderer's active-thread selection.
    // Continue the actual DAP thread here; recorded motions use native commands.
    const entryStops = current.stops.length;
    await request('continue', { threadId: 1 });
    await until(() => current.stops.length > entryStops, 'initial source breakpoint');
    assert.equal((await frames())[0].line, line('mov cr0, eax'));
    await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line('mov cr0, eax') - 1, 0, line('mov cr0, eax') - 1, 0) });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('qemuAsm.showDisplay');
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    provider.receive({ type: 'configure', form: { tab: 'memory', follow: 'esp', memorySpace: 'virtual', count: 64 } });
    await until(() => !provider.model.snapshot.busy && !provider.model.snapshot.stale && provider.model.snapshot.memory?.follow === 'esp', 'live assembly stack');
    const state = async () => {
      const stack = await frames();
      const scopes = (await request('scopes', { frameId: stack[0].id })).scopes;
      const registerScope = scopes.find(item => /register|寄存器/i.test(item.name));
      const registers = (await request('variables', { variablesReference: registerScope.variablesReference })).variables;
      return { stack, registers, failures: current.failures };
    };
    await serve({ vscodeVersion: vscode.version, source, lines: { writeCR0: line('mov cr0, eax'), farJump: line('jmp 0x08:protected_entry'), nested },
      ...(await state()), runtime: 'Real NASM flat binaries and QEMU TCG, real16 → protected32',
      proof: 'Native source breakpoints, single-step, register values, EBP call chain and VGA screen are live product UI.' }, async (action, args) => {
      if (action === 'motion') {
        const result = await motion(args.kind);
        if (args.expectLine === 'farJump') assert.equal(result.stack[0].line, line('jmp 0x08:protected_entry'));
        if (args.expectLine === 'nested') assert.equal(result.stack[0].line, nested);
        return { ...result, ...(await state()) };
      }
      if (action === 'state') return state();
      throw new Error(`Unknown assembly recording action ${action}`);
    });
  } finally {
    vscode.debug.removeBreakpoints(breakpoints);
    if (current) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); InspectorProvider.prototype.post = originalPost;
  }
};
