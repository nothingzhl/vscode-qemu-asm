// Drives the real extension host used by the C source recording. All source,
// variables and stops come from GCC DWARF, GDB and an owned QEMU guest.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const F = require('../c-source-fixture.cjs');
const { InspectorProvider } = require('../../dist/inspector/provider.js');
const { until, serve, delay } = require('./host-utils.cjs');

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
    const project = await F.fixture(path.join(folder.uri.fsPath, 'C kernel'));
    const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
    for (const [key, value] of Object.entries({ projectDirectory: path.relative(folder.uri.fsPath, project.root),
      nasmPath: process.env.NASM_PATH || 'nasm', qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
    })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
    const source = vscode.Uri.file(project.source);
    for (const marker of ['CALL_NESTED', 'NESTED_READY']) {
      const bp = new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(project.line(marker) - 1, 0)));
      breakpoints.push(bp);
    }
    vscode.debug.addBreakpoints(breakpoints);
    await vscode.commands.executeCommand('qemuAsm.debug');
    current = await until(() => records[0], 'actual C session');
    await until(() => current.stops.length === 1, 'kernel entry');
    const request = (command, args = {}) => current.session.customRequest(command, args);
    const frames = async () => (await request('stackTrace', { threadId: 1, levels: 20 })).stackFrames;
    const evaluate = async expression => (await request('evaluate', { expression, frameId: (await frames())[0].id, context: 'watch' })).result;
    const motion = async kind => {
      const commands = { continue: 'workbench.action.debug.continue', stepIn: 'workbench.action.debug.stepInto',
        next: 'workbench.action.debug.stepOver', stepOut: 'workbench.action.debug.stepOut' };
      assert(commands[kind], `Unknown motion ${kind}`);
      const before = current.stops.length;
      await vscode.commands.executeCommand(commands[kind]);
      await until(() => current.stops.length > before, `native ${kind} stop`);
      await delay(250);
      return { stop: current.stops.at(-1), stack: await frames() };
    };
    // Recording setup can precede native renderer thread selection. Recorded
    // motions below use the real workbench controls after the scene is ready.
    const entryStops = current.stops.length;
    await request('continue', { threadId: 1 });
    await until(() => current.stops.length > entryStops, 'initial C source breakpoint');
    assert.equal((await frames())[0].line, project.line('CALL_NESTED'));
    vscode.debug.removeBreakpoints([breakpoints[0]]);
    await vscode.window.showTextDocument(source, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('qemuAsm.showDisplay');
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    provider.receive({ type: 'configure', form: { tab: 'memory', follow: 'esp', memorySpace: 'virtual', count: 64 } });
    await until(() => !provider.model.snapshot.busy && !provider.model.snapshot.stale && provider.model.snapshot.memory?.follow === 'esp', 'live C stack');
    await serve({ vscodeVersion: vscode.version, source: project.source, lines: {
      call: project.line('CALL_NESTED'), nested: project.line('NESTED_READY'), after: project.line('AFTER_NESTED')
    }, stack: await frames(), runtime: 'Real ELF32/DWARF4 + GDB + QEMU; protected32 with non-identity paging',
    proof: 'All displayed editor lines, native variables, call stacks, memory and VGA pixels are live product UI.' }, async (action, args) => {
      if (action === 'motion') {
        const result = await motion(args.kind);
        if (args.expectName) assert.match(result.stack[0].name, new RegExp(args.expectName));
        if (args.expectLine) assert.equal(result.stack[0].line, project.line(args.expectLine));
        return result;
      }
      if (action === 'state') return { stack: await frames(), result: await evaluate('global_result'), failures: current.failures };
      if (action === 'removeNestedBreakpoint') { vscode.debug.removeBreakpoints([breakpoints[1]]); return true; }
      throw new Error(`Unknown C recording action ${action}`);
    });
  } finally {
    vscode.debug.removeBreakpoints(breakpoints);
    if (current) await vscode.debug.stopDebugging(current.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); InspectorProvider.prototype.post = originalPost;
  }
};
