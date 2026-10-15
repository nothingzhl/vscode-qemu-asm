// Disposable BIOS guest recorded in the actual VS Code workbench and real QEMU.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');
const { QemuScreen } = require('../../dist/display/screen');
const { DisplayPanel } = require('../../dist/display/panel');
const { until, serve } = require('./host-utils.cjs');

const assembly = `bits 16
org 0x7c00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7c00
    sti
    mov ax, 0x0003
    int 0x10
    mov si, title
    call print

; Keyboard events travel from the VS Code monitor into this real guest.
keyboard:
    xor ah, ah
    int 0x16
    mov dx, 0x3f8
    out dx, al
    mov ah, 0x0e
    int 0x10
    jmp keyboard

print:
    lodsb
    test al, al
    jz .done
    mov dx, 0x3f8
    out dx, al
    mov ah, 0x0e
    int 0x10
    jmp print
.done:
    ret

title db 'QEMU Assembly Toolkit',13,10
      db 'Live VGA monitor + BIOS keyboard',13,10,13,10
      db 'BOOT READY',13,10,13,10
      db 'Enable keyboard input, click screen, and type:',13,10,0

times 510-($-$$) db 0
dw 0xaa55
`;

exports.run = async function () {
  assert(vscode.workspace.isTrusted);
  const folder = vscode.workspace.workspaceFolders[0];
  const projectRoot = path.join(folder.uri.fsPath, 'boot project');
  await core.createProject(projectRoot);
  const source = path.join(projectRoot, 'boot.asm');
  await fs.writeFile(source, assembly);
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({
    projectDirectory: 'boot project', nasmPath: process.env.NASM_PATH || 'nasm',
    qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
  })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
  assert(extension); await extension.activate();
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(projectRoot, 'qemu-asm.json')));
  await vscode.window.showTextDocument(vscode.Uri.file(source), { viewColumn: vscode.ViewColumn.One });
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const originals = { start: core.Processes.prototype.start, render: DisplayPanel.prototype.render, status: DisplayPanel.prototype.setStatus, emit: QemuScreen.prototype.emit };
  const processes = [], frames = [], statuses = [], events = [];
  core.Processes.prototype.start = function (command, args, cwd, log) {
    let output = '';
    const run = originals.start.call(this, command, args, cwd, text => { output += text; log(text); });
    Object.defineProperty(run, 'demoOutput', { get: () => output });
    processes.push({ command, args, run });
    return run;
  };
  DisplayPanel.prototype.render = function (frame) { frames.push(frame); return originals.render.call(this, frame); };
  DisplayPanel.prototype.setStatus = function (state, message) { statuses.push({ state, message }); return originals.status.call(this, state, message); };
  QemuScreen.prototype.emit = function (event, ...args) { if (event === 'frame') events.push(args[0]); return originals.emit.call(this, event, ...args); };
  const guest = () => processes.find(item => /^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(item.command)) && !item.args.includes('--version'))?.run;
  const evidence = { vscode: vscode.version, platform: process.platform, architecture: process.arch, source: 'Actual VS Code workbench + public extension commands + real NASM/QEMU/BIOS guest.', verifications: [] };
  try {
    await serve(evidence, async (action, args = {}) => {
      if (action === 'check') {
        if (!args.external) await vscode.commands.executeCommand('qemuAsm.checkEnvironment');
        await until(() => processes.filter(item => item.args.includes('-v') || item.args.includes('--version')).length >= 2, 'real environment checks');
        const checks = processes.filter(item => item.args.includes('-v') || item.args.includes('--version'));
        assert.equal(checks.length, 2);
        for (const item of checks) await item.run.done;
        assert(checks.some(item => /NASM version/.test(item.run.demoOutput)));
        assert(checks.some(item => /QEMU emulator version/.test(item.run.demoOutput)));
        evidence.verifications.push('Public checkEnvironment command ran real NASM and QEMU version checks.');
        await vscode.commands.executeCommand('notifications.clearAll');
        return { checks: checks.map(item => ({ command: path.basename(item.command), output: item.run.demoOutput.trim().split('\n')[0] })) };
      }
      if (action === 'build') {
        if (!args.external) await vscode.commands.executeCommand('qemuAsm.build');
        const image = path.join(projectRoot, 'build', 'boot.img');
        const bytes = await until(async () => { try { return await fs.readFile(image); } catch { return false; } }, 'assembled boot image');
        assert.equal(bytes.length, 512); assert.equal(bytes.readUInt16LE(510), 0xaa55);
        evidence.verifications.push('Public build command assembled a valid 512-byte BIOS boot image with signature 0xAA55.');
        return { bytes: bytes.length, bootSignature: '0xAA55' };
      }
      if (action === 'run') {
        if (!args.external) await vscode.commands.executeCommand('qemuAsm.run');
        await until(() => guest()?.demoOutput.includes('Enable keyboard input'), 'real guest initialization');
        await until(() => frames.length >= 2, 'two real QEMU screen frames');
        assert(statuses.some(item => item.state === 'connected'));
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ group, tab })));
        const display = tabs.find(item => item.tab.input instanceof vscode.TabInputWebview && /qemuAsm\.display$/.test(item.tab.input.viewType));
        assert.equal(display?.group.viewColumn, vscode.ViewColumn.Two);
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await vscode.commands.executeCommand('notifications.clearAll');
        evidence.verifications.push('Public run command booted the image in QEMU and rendered live VGA frames in the second editor column.');
        return { qemuPid: guest().child.pid, frames: frames.length, width: frames.at(-1).width, height: frames.at(-1).height };
      }
      if (action === 'keyboard') {
        await until(() => guest()?.demoOutput.endsWith('q'), 'real BIOS serial q echo');
        evidence.verifications.push('Actual Chromium key q passed through the display UI and QMP into the BIOS guest, confirmed by serial output.');
        return { serialEcho: 'q', frames: frames.length };
      }
      if (action === 'stop') {
        assert(guest()); if (!args.external) await vscode.commands.executeCommand('qemuAsm.stop'); await guest().done;
        assert(guest().child.exitCode !== null || guest().child.signalCode !== null);
        await until(() => statuses.at(-1)?.state === 'stopped', 'display stopped status');
        const count = events.length;
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(events.length, count);
        await vscode.commands.executeCommand('workbench.action.closePanel');
        evidence.verifications.push('Public stop command terminated the owned QEMU and stopped screen polling, retaining the final frame.');
        return { stopped: true, finalFrameRetained: true, livePollingStopped: true };
      }
      throw new Error(`Unknown demo action: ${action}`);
    });
  } finally {
    await vscode.commands.executeCommand('qemuAsm.stop');
    core.Processes.prototype.start = originals.start;
    DisplayPanel.prototype.render = originals.render;
    DisplayPanel.prototype.setStatus = originals.status;
    QemuScreen.prototype.emit = originals.emit;
  }
};
