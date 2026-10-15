const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');
const { QemuScreen } = require('../../dist/display/screen');
const { DisplayPanel } = require('../../dist/display/panel');

// Real guest fixture: VGA text plus BIOS keyboard echo, assembled by NASM and
// executed in QEMU. Its serial marker identifies completed guest initialization.
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
    mov si, ready
    call print
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
title db 'QEMU Assembly Toolkit - OS Learning',13,10
      db 'Live VGA screen / BIOS keyboard echo',13,10,13,10,0
ready db 'QEMU_ASM_BOOT_OK',13,10,13,10
      db 'Enable keyboard input, click screen, and type:',13,10,0
times 510-($-$$) db 0
dw 0xaa55
`;


async function until(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timeout waiting for ${description}`);
}

// Observe the real backend and panel without replacing VS Code, QEMU, transport
// or image rendering. The same objects receive the original calls unchanged.
function observe() {
  const original = {
    emit: QemuScreen.prototype.emit,
    dispose: QemuScreen.prototype.dispose,
    render: DisplayPanel.prototype.render,
    status: DisplayPanel.prototype.setStatus,
    start: core.Processes.prototype.start
  };
  const frames = [], rendered = [], statuses = [], screens = new Set(), disposed = new Set(), qemus = [];
  QemuScreen.prototype.emit = function(event, ...args) {
    if (event === 'frame') { screens.add(this); frames.push({ screen: this, frame: args[0] }); }
    return original.emit.call(this, event, ...args);
  };
  QemuScreen.prototype.dispose = async function(...args) {
    const result = await original.dispose.apply(this, args);
    disposed.add(this);
    return result;
  };
  DisplayPanel.prototype.render = function(frame) {
    rendered.push(frame);
    return original.render.call(this, frame);
  };
  DisplayPanel.prototype.setStatus = function(state, message) {
    statuses.push({ state, message });
    return original.status.call(this, state, message);
  };
  core.Processes.prototype.start = function(command, args, cwd, log) {
    let output = '';
    const run = original.start.call(this, command, args, cwd, text => { output += text; log(text); });
    Object.defineProperty(run, 'observedOutput', { get: () => output });
    if (/^qemu-system-(?:i386|x86_64)(?:\.exe)?$/i.test(path.basename(command))) qemus.push(run);
    return run;
  };
  return {
    frames, rendered, statuses, screens, disposed, qemus,
    restore() {
      QemuScreen.prototype.emit = original.emit;
      QemuScreen.prototype.dispose = original.dispose;
      DisplayPanel.prototype.render = original.render;
      DisplayPanel.prototype.setStatus = original.status;
      core.Processes.prototype.start = original.start;
    }
  };
}

function displayTab() {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ group, tab })))
    .find(({ tab }) => tab.input instanceof vscode.TabInputWebview && /^(?:mainThreadWebview-)?qemuAsm\.display$/.test(tab.input.viewType));
}

function assertPng(frame) {
  assert(frame.width > 0 && frame.height > 0, 'real QEMU image dimensions must be positive');
  const encoded = frame.png ?? frame.data ?? frame.dataUrl;
  const png = Buffer.isBuffer(encoded) ? encoded : Buffer.from(String(encoded).replace(/^data:image\/png;base64,/, ''), 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'panel must receive an actual PNG capture');
  assert.equal(png.readUInt32BE(16), frame.width);
  assert.equal(png.readUInt32BE(20), frame.height);
}

exports.run = async function() {
  assert.equal(vscode.workspace.isTrusted, true);
  const [folder] = vscode.workspace.workspaceFolders;
  const projectDirectory = 'display project with spaces, and commas';
  const projectRoot = path.join(folder.uri.fsPath, projectDirectory);
  const source = path.join(projectRoot, 'boot.asm');
  await core.createProject(projectRoot);
  await fs.writeFile(source, assembly);
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({
    projectDirectory, nasmPath: process.env.NASM_PATH || 'nasm', qemuPath: process.env.QEMU_PATH || 'qemu-system-i386', qemuArgs: ['-m', '32M']
  })) await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.window.showTextDocument(vscode.Uri.file(source), { viewColumn: vscode.ViewColumn.One });
  const observed = observe();
  const sessions = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', {
    createDebugAdapterTracker(session) {
      const record = { session, stops: [] }; sessions.push(record);
      return { onDidSendMessage(message) { if (message.type === 'event' && message.event === 'stopped') record.stops.push(message.body); } };
    }
  });
  let debug;
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
    assert(extension); await extension.activate();
    console.log(`VS Code ${vscode.version}; ${process.platform}/${process.arch}; phase=display`);
    await vscode.commands.executeCommand('qemuAsm.run');
    await until(() => observed.qemus[0]?.observedOutput.includes('Enable keyboard input'), 'real guest VGA initialization serial marker');
    const startupFrames = observed.rendered.length;
    await until(() => observed.rendered.length >= startupFrames + 2, 'real QEMU frames rendered in the webview');
    const opened = await until(displayTab, 'contributed display webview tab');
    assert.equal(opened.group.viewColumn, vscode.ViewColumn.Two, 'QEMU display must open beside the source');
    assertPng(observed.rendered.at(-1));
    assert(observed.statuses.some(status => status.state === 'connected'), 'screen transport must connect to the real QEMU');
    assert.equal(observed.qemus.length, 1);
    assert.equal(observed.qemus[0].child.exitCode, null);
    assert.equal(observed.qemus[0].child.signalCode, null);
    console.log('PASS: run opens a second-column VS Code webview and renders valid real QEMU PNG frames');

    if (process.env.QEMU_ASM_DISPLAY_READY_FILE) {
      // The independent CDP runner inspects this real Electron window and takes
      // a full workbench screenshot while this owned QEMU is still running.
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await vscode.commands.executeCommand('notifications.clearAll');
      await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
      await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
      await fs.writeFile(process.env.QEMU_ASM_DISPLAY_READY_FILE, JSON.stringify({
        vscode: vscode.version, qemuPid: observed.qemus[0].child.pid,
        frames: observed.rendered.length, width: observed.rendered.at(-1).width, height: observed.rendered.at(-1).height
      }));
      await until(() => observed.qemus[0].observedOutput.endsWith('q'), 'actual Chromium key reached the BIOS guest');
      await vscode.commands.executeCommand('notifications.clearAll');
      await fs.writeFile(`${process.env.QEMU_ASM_DISPLAY_READY_FILE}.keyboard`, 'real guest serial echoed q');
      await until(async () => {
        try { await fs.access(`${process.env.QEMU_ASM_DISPLAY_READY_FILE}.captured`); return true; }
        catch { return false; }
      }, 'independent real-workbench screenshot', 120000);
    }

    const originalScreen = [...observed.screens][0];
    await vscode.commands.executeCommand('qemuAsm.stop');
    await observed.qemus[0].done;
    await until(() => observed.disposed.has(originalScreen), 'screen transport disposal');
    assert.equal(observed.statuses.at(-1).state, 'stopped');
    await assert.rejects(fs.stat(originalScreen.directory), { code: 'ENOENT' });
    assert(displayTab(), 'stop must keep the display panel available with its last frame');
    const retained = observed.rendered.at(-1);
    const frameCount = observed.frames.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(observed.frames.length, frameCount, 'stopped backend must not keep polling');
    await vscode.window.tabGroups.close(displayTab().tab);
    await vscode.commands.executeCommand('qemuAsm.showDisplay');
    await until(displayTab, 'reopened display webview');
    assert.equal(observed.rendered.at(-1), retained, 'reopening must preserve the last captured frame');
    console.log('PASS: stop releases the live transport, stops frame polling and preserves the final display');

    const previousFrames = observed.rendered.length;
    assert.equal(await vscode.debug.startDebugging(folder, {
      type: 'qemu-asm', request: 'launch', name: 'Display + OS debugger', stopOnEntry: true
    }), true);
    debug = await until(() => sessions[0], 'debug session');
    await until(() => debug.stops.length, 'debug entry stop');
    await until(() => observed.rendered.length > previousFrames, 'paused debug screen frame');
    assert(displayTab(), 'debugging must automatically show the same real display');
    const count = debug.stops.length;
    await debug.session.customRequest('stepIn', { threadId: 1 });
    await until(() => debug.stops.length > count, 'debug step with screen connected');
    const trace = await debug.session.customRequest('stackTrace', { threadId: 1 });
    assert(trace.stackFrames.length > 0, 'screen transport must not interfere with source stepping');
    assert.equal(path.resolve(trace.stackFrames[0].source.path), path.resolve(source));
    assertPng(observed.rendered.at(-1));
    await vscode.debug.stopDebugging(debug.session); debug = undefined;
    await vscode.commands.executeCommand('qemuAsm.stop');
    for (const run of observed.qemus) {
      await run.done;
      assert(run.child.exitCode !== null || run.child.signalCode !== null, 'run/debug cleanup must stop every owned QEMU');
    }
    for (const screen of observed.screens) assert(observed.disposed.has(screen), 'run/debug cleanup must dispose every screen transport');
    console.log('PASS: real debugger entry and instruction stepping coexist with the screen and release owned processes');
  } finally {
    if (debug) await vscode.debug.stopDebugging(debug.session);
    await vscode.commands.executeCommand('qemuAsm.stop');
    tracker.dispose(); observed.restore();
  }
};
