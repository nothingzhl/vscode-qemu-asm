// Real tool compatibility acceptance. Run after npm ci && npm run compile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../../dist/core');
const { DebugRuntime, instructionAddress } = require('../../dist/debug/runtime');
const source = require('../c-source-integration.cjs');
const { exerciseAssembly } = require('../machine-profiles-integration.cjs');
const { stopped, capability } = require('../dependency-integration.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function version(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return { executable, version: result.stdout.trim().split('\n')[0] };
}

async function main() {
  const output = path.resolve(argument('--output', 'artifacts/compatibility'));
  await fs.mkdir(output, { recursive: true });
  const result = {
    schemaVersion: 1,
    label: argument('--label', 'local'),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    startedAt: new Date().toISOString(),
    status: 'running',
    tools: {},
    checks: [],
    observations: []
  };
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu compatibility, '));
  const processes = new core.Processes();
  let assembly, client;
  const log = text => process.stdout.write(text);
  const observe = (stage, report) => result.observations.push({ stage, report });
  try {
    const tools = {
      nasm: process.env.NASM_PATH || 'nasm',
      qemu: process.env.QEMU_PATH || 'qemu-system-i386',
      gdb: process.env.GDB_PATH || 'gdb',
      gcc: process.env.CC || 'gcc'
    };
    for (const [name, executable] of Object.entries(tools)) result.tools[name] = version(executable);
    console.log(JSON.stringify({ label: result.label, tools: result.tools }, null, 2));

    const root = path.join(temporary, 'NASM without GDB');
    await core.createProject(root);
    const program = 'bits 16\norg 0x7c00\ncli\nxor ax,ax\nmov ds,ax\nmov ss,ax\nmov sp,0x7c00\nmov ax,0x1234\npush ax\nidle: jmp idle\ntimes 510-($-$$) db 0\ndw 0xaa55\n';
    await fs.writeFile(path.join(root, 'boot.asm'), program);
    const project = core.resolveProject(temporary, root, {}, {
      nasm: tools.nasm, qemu: tools.qemu,
      gdb: path.join(temporary, 'GDB must not be used'), qemuArgs: ['-m', '32M']
    });
    await core.build(project, processes, log);
    assembly = new DebugRuntime(project, log);
    observe('nasm.beforeLaunch', assembly.capabilities.snapshot());
    await stopped(assembly, () => assembly.launch());
    const initialized = assembly.capabilities.snapshot();
    observe('nasm.connected', initialized);
    capability(initialized, 'qemu.rspTarget', 'supported', 'protocol');
    capability(initialized, 'qemu.segmentRegisters', 'supported', 'protocol');
    capability(initialized, 'qemu.physicalMemory', 'unknown');
    capability(initialized, 'gdb.mi', 'unknown');
    await assembly.setBreakpoints([0x7c00]);
    await stopped(assembly, () => assembly.resume());
    assert.equal(instructionAddress(await assembly.registers()), 0x7c00);
    assert.deepEqual(await assembly.readPhysicalMemory(0x7c00, 16), (await fs.readFile(project.image)).subarray(0, 16));
    const inspected = assembly.capabilities.snapshot();
    observe('nasm.physicalMemory', inspected);
    capability(inspected, 'qemu.physicalMemory', 'supported', 'protocol');
    await assembly.dispose();
    result.checks.push({ name: 'NASM build, RSP breakpoint, registers and physical memory without GDB', status: 'passed' });

    const startupProfiles = await exerciseAssembly(temporary, { nasm: tools.nasm, qemu: tools.qemu });
    result.checks.push({ name: 'Startup profiles: real 16/64 MiB RAM, qemu32/pentium3 CPU, display/QMP, restart and missing CPU cleanup', status: 'passed', ...startupProfiles });

    const fixture = await source.fixture(path.join(temporary, 'C source with spaces'));
    const cProject = core.resolveProject(temporary, fixture.root, fixture.configuration, {
      nasm: tools.nasm, qemu: tools.qemu, gdb: tools.gdb
    });
    client = new source.Client(cProject);
    const launch = client.launch.bind(client);
    client.launch = async () => {
      await launch();
      const report = await client.request('qemuAsm.dependencyReport');
      observe('c.connected', report);
      capability(report, 'gdb.mi', 'supported', 'protocol');
      capability(report, 'qemu.physicalMemory', 'unknown');
    };
    // The shared scenario checks actual DWARF4 locals, nested frames, F10/F11,
    // source/instruction/data breakpoints, stale handles and nonidentity paging.
    await source.exercise(client, fixture, async () => {
      const inspectedC = await client.request('qemuAsm.dependencyReport');
      observe('c.inspected', inspectedC);
      capability(inspectedC, 'qemu.rspTarget', 'supported', 'protocol');
      capability(inspectedC, 'qemu.segmentRegisters', 'supported', 'protocol');
      capability(inspectedC, 'qemu.physicalMemory', 'supported', 'protocol');
    });
    result.checks.push({ name: 'C DWARF4 source, stepping, variables, frames, breakpoints and paging through GDB MI', status: 'passed' });
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error.stack || String(error);
    throw error;
  } finally {
    const settled = await Promise.allSettled([
      client?.dispose(), assembly?.dispose(), processes.dispose()
    ]);
    const cleanupErrors = settled.filter(item => item.status === 'rejected');
    if (cleanupErrors.length) {
      result.status = 'failed';
      result.cleanupErrors = cleanupErrors.map(item => String(item.reason));
      process.exitCode = 1;
    }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    result.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`Compatibility ${result.label}: ${result.status}; ${path.join(output, 'result.json')}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
