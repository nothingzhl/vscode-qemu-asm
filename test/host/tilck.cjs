const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { exercise, top } = require('./exercise.cjs');
async function until(read, description) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timeout: ${description}`);
}
exports.run = async function() {
  assert(vscode.workspace.isTrusted);
  const folder = vscode.workspace.workspaceFolders[0];
  const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension);
  assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(process.env.OS_PROJECT_EXTENSION));
  await extension.activate();
  const settings = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries({ qemuPath: process.env.QEMU_PATH || 'qemu-system-i386',
    gdbPath: process.env.GDB_PATH || 'gdb', nasmPath: '/missing/nasm', displayMode: 'off' }))
    await settings.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  const records = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('qemu-asm', { createDebugAdapterTracker(session) {
    const record = { session, events: [], responses: [] }; records.push(record);
    return { onDidSendMessage(message) {
      if (message.type === 'event') { record.events.push(message); if (message.event === 'output') process.stdout.write(message.body.output); }
      if (message.type === 'response') record.responses.push(message);
    } };
  } });
  let current;
  try {
    assert(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'Tilck ISO', stopOnEntry: true }));
    current = await until(() => records.find(r => r.events.some(e => e.event === 'stopped')), 'Tilck entry');
    const client = {
      request: (command, args = {}) => current.session.customRequest(command, args),
      async stoppedAfter(command, args = { threadId: 1 }) {
        const start = current.events.length; await this.request(command, args);
        return (await until(() => current.events.slice(start).find(e => e.event === 'stopped'), command)).body;
      }
    };
    await exercise(client, folder.uri.fsPath);
    await vscode.debug.stopDebugging(current.session);
    await until(() => current.events.some(e => e.event === 'terminated'), 'Tilck terminated');
    assert(!current.responses.some(r => !r.success));
    const configPath = path.join(folder.uri.fsPath, 'qemu-asm.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(configPath, JSON.stringify({ ...config, build: false }));
    const count = records.length;
    assert(await vscode.debug.startDebugging(folder, { type: 'qemu-asm', request: 'launch', name: 'Tilck existing ISO', stopOnEntry: true }));
    current = await until(() => records.slice(count).find(r => r.events.some(e => e.event === 'stopped')), 'Tilck existing entry');
    assert.match((await top(client)).name, /kmain/);
    await vscode.debug.stopDebugging(current.session);
    await until(() => current.events.some(e => e.event === 'terminated'), 'Tilck existing terminated');
  } finally { if (current) await vscode.debug.stopDebugging(current.session); tracker.dispose(); }
};
