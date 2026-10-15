// Disposable nonidentity-page-table fixture; recording uses the live product UI.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const F = require('../paging-fixture.cjs');
const { serve } = require('./host-utils.cjs');
async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout waiting for ${description}`);
}
exports.run = async function() {
  assert(vscode.workspace.isTrusted);
  const folder = vscode.workspace.workspaceFolders[0];
  const project = await F.fixture(path.join(folder.uri.fsPath, 'nonidentity paging'));
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({
    projectDirectory: path.relative(folder.uri.fsPath, project.root), nasmPath: process.env.NASM_PATH || 'nasm',
    qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
  })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  const stops = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', { createDebugAdapterTracker() {
    return { onDidSendMessage(message) { if (message.type === 'event' && message.event === 'stopped') stops.push(message.body); } };
  } });
  let session;
  try {
    assert(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: '32-bit virtual and physical paging', stopOnEntry: true }));
    session = await until(() => vscode.debug.activeDebugSession, 'actual paging session');
    await until(() => stops.length, 'entry stop');
    const breakpoints = await session.customRequest('setInstructionBreakpoints', { breakpoints: [{ instructionReference: '0xc000000c' }] });
    assert(breakpoints.breakpoints[0].verified);
    const count = stops.length;
    await session.customRequest('continue', { threadId: 1 });
    await until(() => stops[count], 'actual paged instruction breakpoint');
    const page = await session.customRequest('qemuAsm.inspectPaging', { address: F.HIGH_DATA });
    assert.equal(page.status, 'mapped'); assert.equal(page.physicalAddress, F.DATA_PHYSICAL);
    const memory = await session.customRequest('qemuAsm.inspectMemory', { address: F.HIGH_DATA, count: 16, space: 'virtual' });
    assert.equal(memory.bytes[0], 1);
    const sourceLine = project.line('mov cr3, eax');
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(project.source), { viewColumn: vscode.ViewColumn.One });
    editor.selection = new vscode.Selection(sourceLine - 1, 0, sourceLine - 1, 0);
    editor.revealRange(new vscode.Range(sourceLine - 1, 0, sourceLine - 1, 0), vscode.TextEditorRevealType.InCenter);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('qemuAsm.showDisplay');
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('qemuAsm.showPaging');
    await serve({ source: project.source, line: sourceLine, pc: F.HIGH_READ, linearAddress: F.HIGH_DATA,
      physicalAddress: F.DATA_PHYSICAL, codeAddress: F.HIGH_CODE, codePhysicalAddress: F.CODE_PHYSICAL,
      readonlyAddress: F.HIGH_READONLY, unmappedAddress: F.HIGH_MISSING, bigAddress: F.BIG_VIRTUAL + 0x123,
      bigPhysicalAddress: F.BIG_PHYSICAL + 0x123, cr3: F.PD, page, memory, vscodeVersion: vscode.version,
      sourceOfEvidence: 'Actual QEMU CR0.PG=1; nonidentity physical page tables and real guest RAM. No data mocks.'
    }, async (action, args = {}) => {
      if (action === 'paging') return session.customRequest('qemuAsm.inspectPaging', args);
      if (action === 'memory') return session.customRequest('qemuAsm.inspectMemory', args);
      if (action === 'command') return vscode.commands.executeCommand(args.command);
      throw new Error(`Unknown paging recording action ${action}`);
    });
  } finally {
    if (session) await vscode.debug.stopDebugging(session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose();
  }
};
