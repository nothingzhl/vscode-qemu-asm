// Real VS Code + QEMU host used by the memory and descriptor recordings.
// All displayed memory and table entries are read through the actual adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');
const { serve } = require('./host-utils.cjs');

async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout waiting for ${description}`);
}
const numeric = value => Number(/0x[0-9a-f]+/i.exec(String(value))?.[0] ?? value);

exports.run = async function() {
  assert(vscode.workspace.isTrusted, 'Recording executes only in a trusted disposable workspace');
  const folder = vscode.workspace.workspaceFolders[0];
  const projectRoot = path.join(folder.uri.fsPath, 'protected debug');
  await core.createProject(projectRoot, 'protected');
  const source = path.join(projectRoot, 'stage2.asm');
  const text = await fs.readFile(source, 'utf8');
  const lines = text.split('\n');
  const line = lines.findIndex(item => item.trim() === 'learning_breakpoint:') + 2;
  assert(line > 1);
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({
    projectDirectory: path.relative(folder.uri.fsPath, projectRoot),
    nasmPath: process.env.NASM_PATH || 'nasm', qemuPath: process.env.QEMU_PATH || 'qemu-system-i386',
    qemuArgs: ['-m', '32M']
  })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  const stops = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker() {
      return { onDidSendMessage(message) {
        if (message.type === 'event' && message.event === 'stopped') stops.push(message.body);
      } };
    }
  });
  let session;
  async function stoppedAfter(command, args = { threadId: 1 }) {
    const count = stops.length;
    await session.customRequest(command, args);
    return until(() => stops[count], `actual ${command} stop`);
  }
  async function registers() {
    const trace = await session.customRequest('stackTrace', { threadId: 1 });
    const { scopes } = await session.customRequest('scopes', { frameId: trace.stackFrames[0].id });
    const registerScope = scopes.find(item => /寄存器|register/i.test(item.name));
    assert(registerScope);
    const { variables } = await session.customRequest('variables', { variablesReference: registerScope.variablesReference });
    return Object.fromEntries(variables.map(item => [item.name.toLowerCase(), numeric(item.value)]));
  }
  async function evidence() {
    const r = await registers();
    const memory = await session.customRequest('qemuAsm.inspectMemory', { address: r.edi, count: 16 });
    return { registers: r, pc: r.eip, dataAddress: r.edi, memory };
  }
  try {
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(source), new vscode.Position(line - 1, 0)))]);
    assert(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'Protected-mode memory and CPU tables', stopOnEntry: true }));
    session = await until(() => vscode.debug.activeDebugSession, 'actual debug session');
    await until(() => stops.length, 'BIOS entry stop');
    await stoppedAfter('continue');
    const first = await evidence();
    assert.equal(first.registers.cs, 8);
    assert.equal(first.registers.ss, 16);
    assert.equal(first.registers.esp, 0x8ffec);
    assert.equal(first.memory.bytes[8], 0);
    const gdt = await session.customRequest('qemuAsm.inspectDescriptors', { table: 'gdt' });
    const idt = await session.customRequest('qemuAsm.inspectDescriptors', { table: 'idt' });
    assert(gdt.entries[1].registers.includes('CS'));
    assert(gdt.entries[2].registers.includes('SS'));
    assert.equal(idt.entries[3].gateBits, 32);
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(source), { viewColumn: vscode.ViewColumn.One });
    editor.selection = new vscode.Selection(line - 1, 0, line - 1, 0);
    editor.revealRange(new vscode.Range(line - 1, 0, line - 1, 0), vscode.TextEditorRevealType.InCenter);
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('qemuAsm.showDisplay');
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('qemuAsm.showInspector');
    await serve({ ...first, source, line, gdt, idt, vscodeVersion: vscode.version,
      sourceOfEvidence: 'Actual protected-mode QEMU, VS Code native debugger, memory and descriptors. No mocked data.'
    }, async (action, args = {}) => {
      if (action === 'step') {
        const count = args.count ?? 1;
        for (let index = 0; index < count; index++) await stoppedAfter('stepIn');
        const result = await evidence();
        if (args.expectChanged) assert.equal(result.memory.bytes[8], 1, 'actual INC must update the guest dword');
        return result;
      }
      if (action === 'restart') { await stoppedAfter('restart', {}); return { registers: await registers() }; }
      if (action === 'continue') { await stoppedAfter('continue'); return evidence(); }
      if (action === 'memory') return session.customRequest('qemuAsm.inspectMemory', args);
      if (action === 'descriptors') return session.customRequest('qemuAsm.inspectDescriptors', args);
      if (action === 'registers') return registers();
      if (action === 'command') return vscode.commands.executeCommand(args.command);
      throw new Error(`Unknown recording action ${action}`);
    });
  } finally {
    if (session) await vscode.debug.stopDebugging(session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose();
  }
};
