// Disposable firmware and actual VS Code/QEMU sessions for the feature recordings.
// The high-memory payload deliberately has no source-map entry in the adapter.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { fixture, until, HIGH_CODE, HIGH_DATA } = require('../machine-debug-integration.cjs');
const { serve } = require('./host-utils.cjs');

exports.run = async function () {
  assert(vscode.workspace.isTrusted);
  const folder = vscode.workspace.workspaceFolders[0];
  const id = process.env.QEMU_ASM_DEMO_ID || '04-disassembly';
  const isCall = id === '04-disassembly';
  const project = await fixture(path.join(folder.uri.fsPath, 'machine-debug'), 'protected32');
  let source = project.text;
  // This is guest code, so the right-hand display shows actual VGA RAM output.
  source = source.replace('source_before_high:', `mov dword [0xb8000], 0x1f491f4c
mov dword [0xb8004], 0x1f451f56
mov dword [0xb8008], 0x1f511f20
mov dword [0xb800c], 0x1f4d1f45
mov dword [0xb8010], 0x1f201f55
mov dword [0xb8014], 0x1f321f33
mov dword [0xb8018], 0x1f421f2d
mov dword [0xb801c], 0x1f541f49
source_before_high:`);
  if (isCall) source = source.replace(/payload:\n[\s\S]*?\npayload_end:/, `payload:
db 0xb8,0x40,0,0,0
db 0xe8,0x07,0,0,0
db 0xff,0x07
db 0x8b,0x1f
db 0x90
db 0xeb,0xfe
db 0x40,0xc3
payload_end:`);
  await fs.writeFile(project.source, source);
  const payloadSource = path.join(project.root, 'live-payload.asm');
  await fs.writeFile(payloadSource, isCall ? `; Copied to 0x00100000 at runtime; machine debugging needs no source map.
bits 32
org 0x00100000
mov eax, 64
call increment_eax
inc dword [edi]
mov ebx, [edi]
nop
halt: jmp halt
increment_eax:
inc eax
ret
` : `; Copied to 0x00100000; observed data lives at 0x00110000.
bits 32
org 0x00100000
mov ax, 0x1234
mov eax, 0x11223344
again:
inc dword [edi]       ; write + read-modify-write
mov eax, [edi]        ; read
nop
jmp again
`);
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({ projectDirectory: path.relative(folder.uri.fsPath, project.root),
    nasmPath: process.env.NASM_PATH || 'nasm', qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M'] })) {
    await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
  await extension.activate();
  const stops = [];
  let session;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(candidate) {
      session = candidate;
      return { onDidSendMessage(message) {
        if (message.type === 'event' && message.event === 'stopped') stops.push(message.body);
      } };
    }
  });
  async function stopped(action, args = {}) {
    const before = stops.length;
    if (action.startsWith('workbench.')) await vscode.commands.executeCommand(action);
    else await session.customRequest(action, { threadId: 1, ...args });
    return until(() => stops[before], `real ${action} stop`, 30000);
  }
  async function evidence() {
    const frames = await session.customRequest('stackTrace', { threadId: 1 });
    const memory = await session.customRequest('readMemory', { memoryReference: '0x110000', count: 4 });
    const eax = await session.customRequest('evaluate', { expression: 'eax', frameId: 1, context: 'watch' });
    const watches = await session.customRequest('qemuAsm.watchpoints', { action: 'list' });
    const instructions = await session.customRequest('qemuAsm.instructionBreakpoints', { action: 'list' });
    return { frame: frames.stackFrames[0], value: Buffer.from(memory.data, 'base64').readUInt32LE(0), eax: eax.result,
      watches, instructions, stop: stops.at(-1) };
  }
  try {
    assert(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: isCall ? 'Live machine disassembly' : 'Live memory watchpoints', stopOnEntry: true }));
    await until(() => stops.length, 'boot entry', 30000);
    const initialPc = isCall ? HIGH_CODE : HIGH_CODE + 9;
    const breakpoints = await session.customRequest('setInstructionBreakpoints', { breakpoints: [{ instructionReference: `0x${initialPc.toString(16)}` }] });
    assert(breakpoints.breakpoints[0].verified);
    await stopped('continue');
    await session.customRequest('setInstructionBreakpoints', { breakpoints: [] });
    const first = await evidence();
    assert.equal(Number(first.frame.instructionPointerReference), initialPc);
    assert.equal(first.value, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(payloadSource), { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('qemuAsm.showDisplay');
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand(isCall ? 'qemuAsm.showDisassembly' : 'qemuAsm.showDataBreakpoints');
    await serve({ id, vscodeVersion: vscode.version, codeAddress: HIGH_CODE, dataAddress: HIGH_DATA,
      pc: initialPc, mode: 'protected32', source: payloadSource, initial: first,
      sourceOfEvidence: 'Actual native VS Code, inline DAP, real QEMU TCG and VGA memory; no substituted DOM, debugger or guest data.' }, async (action, args) => {
      if (action === 'state') return evidence();
      if (action === 'step') { await stopped('workbench.action.debug.stepInto'); return evidence(); }
      if (action === 'next') { await stopped('workbench.action.debug.stepOver'); return evidence(); }
      if (action === 'continue') { await stopped('workbench.action.debug.continue'); return evidence(); }
      if (action === 'command') { await vscode.commands.executeCommand(args.command); return true; }
      throw new Error(`Unknown machine demo action: ${action}`);
    });
  } finally {
    if (session) await vscode.debug.stopDebugging(session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose();
  }
};
