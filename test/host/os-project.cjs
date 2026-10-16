const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { exercise, top } = require('./os-project-exercise.cjs');
async function until(read, description) {
  const end = Date.now() + 45000;
  while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`Timeout: ${description}`);
}
exports.run = async function() {
  assert(vscode.workspace.isTrusted);
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  if (process.env.OS_PROJECT_MAKE) {
    const configPath = path.join(root, 'qemu-asm.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.build.command = process.env.OS_PROJECT_MAKE;
    await fs.writeFile(configPath, JSON.stringify(config));
  }
  const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm'); assert(extension);
  assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(process.env.OS_PROJECT_EXTENSION));
  await extension.activate();
  const settings = vscode.workspace.getConfiguration('qemuAsm', vscode.workspace.workspaceFolders[0].uri);
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
    assert(await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], { type: 'qemu-asm', request: 'launch', name: 'DreamOS actual ISO', stopOnEntry: true }));
    current = await until(() => records.find(record => record.events.some(item => item.event === 'stopped')), 'real host entry');
    const client = {
      request: (command, args = {}) => current.session.customRequest(command, args),
      async stoppedAfter(command, args = { threadId: 1 }) {
        const start = current.events.length; await this.request(command, args);
        return (await until(() => current.events.slice(start).find(item => item.event === 'stopped'), command)).body;
      }
    };
    await exercise(client, root, true);
    await vscode.debug.stopDebugging(current.session);
    await until(() => current.events.some(item => item.event === 'terminated'), 'terminated');
    assert(!current.responses.some(item => !item.success), 'no failed DAP requests');
    const configPath = path.join(root, 'qemu-asm.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await require('node:util').promisify(require('node:child_process').execFile)(config.build.command, config.build.args, { cwd: root, timeout: 120000 });
    await fs.writeFile(configPath, JSON.stringify({ ...config, build: false }));
    const count = records.length;
    assert(await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], { type: 'qemu-asm', request: 'launch', name: 'DreamOS existing ISO', stopOnEntry: true }));
    current = await until(() => records.slice(count).find(record => record.events.some(item => item.event === 'stopped')), 'existing artifact entry');
    assert.match((await top(client)).name, /main_loop/);
    await vscode.debug.stopDebugging(current.session);
    await until(() => current.events.some(item => item.event === 'terminated'), 'existing artifact terminated');
    console.log('PASS: VS Code host uses configured ISO, real C stepping/views/rebuild/restart and existing artifacts');
  } finally { if (current) await vscode.debug.stopDebugging(current.session); tracker.dispose(); }
};
