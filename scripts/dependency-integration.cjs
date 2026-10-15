// Actual-tool acceptance for the dependency boundary. The temporary builder is
// a project-owned executable, not another plugin dependency or teaching sample.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist/core');
const { DebugRuntime, instructionAddress } = require('../dist/debug/runtime');
const { Client } = require('./c-source-integration.cjs');
const F = require('./c-source-fixture.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(20); }
  throw new Error('Timeout waiting for ' + description);
}
function stopped(runtime, action) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); runtime.off('stopped', onStop); runtime.off('terminated', onEnd); };
    const onStop = event => { cleanup(); resolve(event); };
    const onEnd = event => { cleanup(); reject(new Error(event.error || 'Unexpected QEMU exit')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Actual QEMU stop timeout')); }, 20000);
    runtime.once('stopped', onStop); runtime.once('terminated', onEnd);
    Promise.resolve().then(action).catch(error => { cleanup(); reject(error); });
  });
}
function capability(report, id, state, evidence) {
  assert.equal(report.schemaVersion, 1);
  const item = report.entries.find(entry => entry.id === id);
  assert(item, 'Missing capability ' + id);
  assert.equal(item.state, state, JSON.stringify(item));
  if (evidence) assert.equal(item.evidence, evidence, JSON.stringify(item));
  assert(item.reason && Number.isFinite(Date.parse(item.observedAt)));
  return item;
}
const assembly = 'bits 16\norg 0x7c00\ncli\nxor ax,ax\nmov ds,ax\nmov ss,ax\nmov sp,0x7c00\nmov ax,0x1234\npush ax\nidle: jmp idle\ntimes 510-($-$$) db 0\ndw 0xaa55\n';

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu dependencies actual, '));
  const processes = new core.Processes(), runtimes = [], clients = [], observed = [];
  const originalStart = core.Processes.prototype.start, originalPath = process.env.PATH;
  core.Processes.prototype.start = function(command, args, cwd, log) {
    const run = originalStart.call(this, command, args, cwd, log);
    observed.push({ command: run.child.spawnfile, requested: command, args, run }); return run;
  };
  const log = text => process.stdout.write(text);
  try {
    const root = path.join(temporary, 'NASM project with spaces, and commas');
    await core.createProject(root); await fs.writeFile(path.join(root, 'boot.asm'), assembly);
    const nasm = process.env.NASM_PATH || 'nasm', qemu = process.env.QEMU_PATH || 'qemu-system-i386';
    // Prefer the selected QEMU wrapper directory over the directory containing
    // NASM, which may also contain an unconfigured QEMU with different runtime data.
    const toolDirectories = [qemu, nasm].filter(path.isAbsolute).map(file => path.dirname(file));
    process.env.PATH = [...toolDirectories, originalPath || ''].join(path.delimiter);
    const tools = { nasm: path.basename(nasm), qemu: path.basename(qemu), gdb: path.join(temporary, 'no GDB installed'), qemuArgs: ['-m', '32M'] };
    const project = core.resolveProject(temporary, root, {}, tools);
    await core.build(project, processes, log);
    const first = new DebugRuntime(project, log); runtimes.push(first);
    await stopped(first, () => first.launch());
    let report = first.capabilities.snapshot();
    capability(report, 'qemu.rspTarget', 'supported', 'protocol');
    capability(report, 'qemu.segmentRegisters', 'supported', 'protocol');
    capability(report, 'qemu.physicalMemory', 'unknown');
    capability(report, 'gdb.mi', 'unknown');
    assert.equal(report.scope.host.platform, process.platform); assert.equal(report.scope.host.arch, process.arch);
    await first.setBreakpoints([0x7c00]); await stopped(first, () => first.resume());
    assert.equal(instructionAddress(await first.registers()), 0x7c00);
    assert.deepEqual(await first.readPhysicalMemory(0x7c00, 16), (await fs.readFile(project.image)).subarray(0, 16));
    report = first.capabilities.snapshot(); capability(report, 'qemu.physicalMemory', 'supported', 'protocol');
    const firstQemu = observed.find(item => item.args.includes('-gdb'));
    const firstNasm = observed.find(item => item.args.includes('-f'));
    assert(firstQemu && firstNasm); assert(path.isAbsolute(firstQemu.command)); assert(path.isAbsolute(firstNasm.command));
    assert.equal(report.scope.tools.qemu, firstQemu.command, 'the runtime report must identify the executable actually launched');
    assert(!observed.some(item => /gdb(?:\.exe)?$/i.test(path.basename(item.command))), 'NASM must not start a GDB process');
    await first.dispose();
    console.log('PASS: PATH tools resolve to absolute executables, actual NASM debug needs no GDB, RSP/segments/physical-memory evidence comes from actual protocol use');

    const explicit = core.resolveProject(temporary, root, {}, { ...tools, nasm: firstNasm.command, qemu: firstQemu.command });
    await core.build(explicit, processes, log);
    const second = new DebugRuntime(explicit, log); runtimes.push(second);
    await stopped(second, () => second.launch());
    const fresh = second.capabilities.snapshot();
    assert.notEqual(fresh.scope.sessionId, report.scope.sessionId, 'a relaunch must not reuse capability identity');
    capability(fresh, 'qemu.physicalMemory', 'unknown');
    assert.equal(fresh.scope.tools.qemu, firstQemu.command, 'explicit and PATH selection of the same executable must agree');
    await second.dispose();
    console.log('PASS: explicit tool selection agrees with PATH execution and a new target starts with fresh unprobed optional capabilities');

    const externalRoot = path.join(temporary, 'external build without NASM'); await fs.mkdir(externalRoot);
    const builder = path.join(externalRoot, 'builder.cjs');
    await fs.writeFile(builder, "const fs=require('node:fs');const b=Buffer.alloc(512);b.set([0xfa,0xeb,0xfe]);b[510]=0x55;b[511]=0xaa;fs.writeFileSync(process.argv[2],b);\n");
    const external = core.resolveProject(temporary, externalRoot, { build: { command: process.execPath, args: ['builder.cjs', path.join(externalRoot, 'build', 'boot.img')] } }, { nasm: path.join(temporary, 'NASM does not exist'), qemu: firstQemu.command });
    const before = observed.length; const built = await core.build(external, processes, log);
    assert.equal(built.imageBytes, 512); assert.equal(observed.length, before + 1);
    assert.equal(observed[before].command, process.execPath); assert(!observed[before].args.includes('--version'));
    const externalRuntime = new DebugRuntime(external, log); runtimes.push(externalRuntime);
    await stopped(externalRuntime, () => externalRuntime.launch());
    await externalRuntime.setBreakpoints([0x7c00]); await stopped(externalRuntime, () => externalRuntime.resume());
    assert.equal(instructionAddress(await externalRuntime.registers()), 0x7c00); await externalRuntime.dispose();
    console.log('PASS: a real project-owned external builder and bootable QEMU guest work with no NASM executable configured');

    // Compile the disposable C fixture before the product run. During the actual
    // adapter launch the configured builder only copies its prebuilt disk, and
    // the plugin NASM setting points to a nonexistent executable.
    const fixture = await F.fixture(path.join(temporary, 'C external artifacts'));
    await fixture.build(); const cachedImage = path.join(fixture.root, 'prebuilt.img'); await fs.copyFile(fixture.image, cachedImage);
    await fs.writeFile(path.join(fixture.root, 'copy-image.cjs'), "require('node:fs').copyFileSync('prebuilt.img','build/os.img');\n");
    const configured = { ...fixture.configuration, build: { command: process.execPath, args: ['copy-image.cjs'] } };
    const cProject = core.resolveProject(temporary, fixture.root, configured, { nasm: path.join(temporary, 'no NASM for C'), qemu: firstQemu.command });
    const cClient = new Client(cProject); clients.push(cClient); const cStart = observed.length; await cClient.launch();
    const cReport = await cClient.request('qemuAsm.dependencyReport');
    capability(cReport, 'gdb.mi', 'supported', 'protocol'); capability(cReport, 'qemu.rspTarget', 'supported', 'protocol');
    capability(cReport, 'qemu.segmentRegisters', 'supported', 'protocol'); capability(cReport, 'qemu.physicalMemory', 'unknown');
    const cFrame = (await cClient.request('stackTrace', { threadId: 1 })).stackFrames[0];
    assert.match(cFrame.name, /kernel_main/); assert.equal(cFrame.source.path, fixture.source);
    const cMemory = await cClient.request('qemuAsm.inspectMemory', { address: F.CODE_PHYSICAL, count: 8, space: 'physical', follow: 'address' });
    assert.equal(cMemory.bytes.length, 8); capability(await cClient.request('qemuAsm.dependencyReport'), 'qemu.physicalMemory', 'supported', 'protocol');
    assert(!observed.slice(cStart).some(item => item.args.includes('-f')), 'external C adapter must not invoke NASM');
    await cClient.disconnect();
    console.log('PASS: C adapter uses its actual GDB MI channel for capability evidence and physical memory, without product-managed NASM');

    for (const item of observed) { await item.run.done; assert(item.run.child.exitCode !== null || item.run.child.signalCode !== null, item.command + ' must exit'); }
    console.log('PASS: all observed owned build/QEMU processes exit after dependency integration');
  } finally {
    for (const client of clients) await client.dispose();
    for (const runtime of runtimes) await runtime.dispose();
    await processes.dispose(); core.Processes.prototype.start = originalStart;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

module.exports = { capability, stopped, until };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
