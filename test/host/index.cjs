const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const core = require('../../dist/core');

const commands = ['checkEnvironment', 'showDependencyReport', 'createProject', 'createProtectedProject', 'build', 'run', 'stop', 'debug', 'showInspector', 'showDisassembly', 'showDataBreakpoints', 'showPaging'].map(name => `qemuAsm.${name}`);
const root = process.env.QEMU_ASM_HOST_ROOT;

async function until(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout waiting for ${description}`);
}

// Observe real child processes and serial output without replacing VS Code APIs or executables.
function observeProcesses() {
  const original = core.Processes.prototype.start;
  const runs = [];
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const observation = { command, args, output: '' };
    const run = original.call(this, command, args, cwd, text => { observation.output += text; log(text); });
    Object.assign(observation, run);
    runs.push(observation);
    return run;
  };
  return { runs, restore: () => { core.Processes.prototype.start = original; } };
}

async function configure(folder, values) {
  const config = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
  for (const [key, value] of Object.entries(values)) await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
}

async function trusted(observed) {
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  const folder = vscode.workspace.workspaceFolders[0];
  const projectDirectory = 'project with spaces, and commas';
  const projectRoot = path.join(root, projectDirectory);
  // The interactive directory picker is deliberately excluded; use the same real generator.
  await core.createProject(projectRoot);
  await assert.rejects(core.createProject(projectRoot));
  await configure(folder, {
    projectDirectory,
    nasmPath: process.env.NASM_PATH || 'nasm',
    qemuPath: process.env.QEMU_PATH || 'qemu-system-i386',
    qemuArgs: ['-m', '32M']
  });
  await vscode.commands.executeCommand('qemuAsm.checkEnvironment');
  assert.equal(observed.runs.length, 2, 'environment command must run both real tools');
  assert.match(observed.runs[0].output, /NASM version/i);
  assert.match(observed.runs[1].output, /QEMU emulator version/i);

  await vscode.commands.executeCommand('qemuAsm.build');
  const image = path.join(projectRoot, 'build', 'boot.img');
  const bytes = await fs.readFile(image);
  assert.equal(bytes.length, 512);
  assert.equal(bytes.subarray(510).toString('hex'), '55aa');
  console.log('PASS: host command builds a valid boot image in a path containing spaces and commas');

  async function runAndReadMarker() {
    const previous = observed.runs.length;
    await vscode.commands.executeCommand('qemuAsm.run');
    const launched = observed.runs.slice(previous);
    assert.equal(launched.length, 2, 'run must rebuild and launch QEMU');
    const qemu = launched[1];
    await until(() => qemu.output.includes(core.MARKER), 'real QEMU serial marker');
    assert.equal(qemu.child.exitCode, null);
    assert.equal(qemu.child.signalCode, null);
    return qemu;
  }
  const first = await runAndReadMarker();
  const second = await runAndReadMarker();
  await first.done;
  assert(first.child.exitCode !== null || first.child.signalCode !== null, 'repeated run must stop the previous QEMU');
  await vscode.commands.executeCommand('qemuAsm.stop');
  await second.done;
  assert(second.child.exitCode !== null || second.child.signalCode !== null, 'stop must terminate the owned QEMU');
  await vscode.commands.executeCommand('qemuAsm.stop');
  console.log('PASS: real host run emits the serial marker, replaces the prior instance and stops it');

  const source = path.join(projectRoot, 'boot.asm');
  await fs.writeFile(source, 'bits 16\nthis is invalid assembly\n');
  const count = observed.runs.length;
  await vscode.commands.executeCommand('qemuAsm.run');
  assert.equal(observed.runs.length, count + 1, 'failed NASM build must not start QEMU');
  await assert.rejects(fs.stat(image), { code: 'ENOENT' });
  const uri = vscode.Uri.file(source);
  await until(() => vscode.languages.getDiagnostics(uri).length > 0, 'NASM source diagnostics');
  const diagnostic = vscode.languages.getDiagnostics(uri)[0];
  assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(diagnostic.range.start.line, 1);
  console.log('PASS: failed real NASM build exposes an error at the source line and invalidates the old image');
}

async function untrusted(observed) {
  assert.equal(vscode.workspace.isTrusted, false, 'restricted workspace must stay untrusted');
  for (const command of commands) await vscode.commands.executeCommand(command);
  assert.equal(observed.runs.length, 0, 'untrusted commands must not execute external tools');
  assert.deepEqual(await fs.readdir(root), [], 'untrusted commands must not create or build a project');
  console.log('PASS: real restricted-mode host blocks project creation and tool execution');
}

async function resources() {
  assert.equal(vscode.workspace.workspaceFolders.length, 2);
  const [first, second] = vscode.workspace.workspaceFolders;
  await configure(first, { projectDirectory: 'first project', nasmPath: 'first tools/nasm', qemuArgs: ['-m', '32M'] });
  await configure(second, { projectDirectory: 'second project', nasmPath: 'second tools/nasm', qemuArgs: ['-m', '64M'] });
  for (const [folder, expectedDirectory, expectedTool, memory] of [[first, 'first project', 'first tools/nasm', '32M'], [second, 'second project', 'second tools/nasm', '64M']]) {
    const config = vscode.workspace.getConfiguration('qemuAsm', folder.uri);
    assert.equal(config.get('projectDirectory'), expectedDirectory);
    assert.equal(config.get('nasmPath'), expectedTool);
    assert.deepEqual(config.get('qemuArgs'), ['-m', memory]);
    const project = core.resolveProject(folder.uri.fsPath, config.get('projectDirectory'), {}, { nasm: config.get('nasmPath'), qemuArgs: config.get('qemuArgs') });
    assert.equal(project.root, path.join(folder.uri.fsPath, expectedDirectory));
    assert.equal(project.nasm, path.join(folder.uri.fsPath, expectedTool));
  }
  console.log('PASS: real multi-root host keeps resource settings and relative tool paths scoped to each folder');
}

exports.run = async function() {
  if (process.env.QEMU_ASM_HOST_PHASE === 'dependencies') { await require('./dependencies.cjs').run(); return; }
  if (process.env.QEMU_ASM_HOST_PHASE === 'c-source') { await require('./c-source.cjs').run(); return; }
  if (process.env.QEMU_ASM_HOST_PHASE === 'paging') { await require('./paging.cjs').run(); return; }
  if (process.env.QEMU_ASM_HOST_PHASE === 'machine') { await require('./machine.cjs').run(); return; }
  if (process.env.QEMU_ASM_HOST_PHASE === 'inspection') { await require('./inspection.cjs').run(); return; }
  if (process.env.QEMU_ASM_HOST_PHASE === 'protected') { await require('./protected.cjs').run(); return; }
  if (process.env.QEMU_ASM_HOST_PHASE === 'display') { await require('./display.cjs').run(); return; }
  if (process.env.QEMU_ASM_HOST_PHASE === 'debug') { await require('./debug.cjs').run(); return; }
  const observed = observeProcesses();
  try {
    const extension = vscode.extensions.getExtension('nothingzhl.vscode-qemu-asm');
    assert(extension, 'development extension must be loaded');
    await extension.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const command of commands) assert(registered.includes(command), `missing command ${command}`);
    console.log(`VS Code ${vscode.version}; ${process.platform}/${process.arch}; phase=${process.env.QEMU_ASM_HOST_PHASE}`);
    if (process.env.QEMU_ASM_HOST_PHASE === 'trusted') await trusted(observed);
    else if (process.env.QEMU_ASM_HOST_PHASE === 'untrusted') await untrusted(observed);
    else if (process.env.QEMU_ASM_HOST_PHASE === 'resources') await resources();
    else throw new Error('Unknown host test phase');
  } finally {
    // Always use the public stop command while trusted, and retain observation until cleanup finishes.
    if (vscode.workspace.isTrusted) await vscode.commands.executeCommand('qemuAsm.stop');
    observed.restore();
  }
};
