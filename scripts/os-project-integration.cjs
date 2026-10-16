const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepare } = require('./os-project/prepare.cjs');
const { DapClient } = require('./os-project/client.cjs');
const { exercise } = require('./os-project/exercise.cjs');
const { resolveProject, Processes } = require('../dist/core');
const { createDebugAdapter } = require('../dist/composition/createAdapter');
const { localHost } = require('../dist/platform/host');
async function main() {
  assert(process.env.DREAMOS_SOURCE, 'Set DREAMOS_SOURCE to the pinned upstream Git checkout (no automatic downloads)');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'real OS project, '));
  const root = path.join(temporary, 'DreamOS checkout, with spaces');
  const runs = [], children = [], clients = [];
  const original = { start: Processes.prototype.start, spawn: localHost.spawn };
  try {
    await prepare(process.env.DREAMOS_SOURCE, root);
    const config = JSON.parse(await fs.readFile(path.join(root, 'qemu-asm.json'), 'utf8'));
    const tools = { qemu: process.env.QEMU_PATH || 'qemu-system-i386', gdb: process.env.GDB_PATH || 'gdb', nasm: '/missing/nasm' };
    await require('./os-project/native.cjs').baseline(root, tools);
    let project = resolveProject(root, '.', config, tools);
    Processes.prototype.start = function(...args) { const run = original.start.apply(this, args); runs.push({ command: args[0], run }); return run; };
    localHost.spawn = function(...args) { const child = original.spawn.apply(this, args); children.push(child); return child; };
    const client = new DapClient(createDebugAdapter(project, { getProject: async () => project, isTrusted: () => true, log: text => process.stdout.write(text) }));
    clients.push(client);
    await client.launch(); await exercise(client, root, true); await client.disconnect();
    const image = await fs.readFile(project.image), elf = await fs.readFile(project.debug.elf);
    const count = children.length;
    project = resolveProject(root, '.', { ...config, build: { command: process.execPath, args: ['-e', 'process.exit(7)'] } }, tools);
    const failed = new DapClient(createDebugAdapter(project, { getProject: async () => project, isTrusted: () => true }));
    clients.push(failed);
    await assert.rejects(failed.launch(), /退出码 7/); await failed.event('terminated');
    assert.equal(children.length, count + 1, 'failed builder must not launch QEMU or GDB');
    assert.deepEqual(await fs.readFile(project.image), image); assert.deepEqual(await fs.readFile(project.debug.elf), elf);
    for (const name of ['missing.iso', 'invalid.iso']) {
      if (name === 'invalid.iso') await fs.writeFile(path.join(root, name), Buffer.alloc(2048));
      const invalidProject = resolveProject(root, '.', { ...config, image: name, build: false }, tools);
      const invalid = new DapClient(createDebugAdapter(invalidProject, { getProject: async () => invalidProject, isTrusted: () => true }));
      clients.push(invalid);
      const before = children.length;
      await assert.rejects(invalid.launch(), /ISO|ENOENT/); await invalid.event('terminated');
      assert.equal(children.length, before, 'invalid artifacts must fail before any QEMU/GDB allocation');
    }
    // Rebuild restored source outside the product, then explicitly reuse the matching artifacts.
    await require('node:util').promisify(require('node:child_process').execFile)('make', config.build.args, { cwd: root, timeout: 120000 });
    project = resolveProject(root, '.', { ...config, build: false }, tools);
    const reused = new DapClient(createDebugAdapter(project, { getProject: async () => project, isTrusted: () => true }));
    clients.push(reused);
    const runsBefore = runs.length;
    await reused.launch(); await reused.disconnect();
    assert.equal(runs.length, runsBefore + 1, 'existing mode must launch only QEMU, no builder or NASM');
    for (const child of children) assert(child.exitCode !== null || child.signalCode !== null, 'all actual builder/QEMU/GDB children must exit');
    console.log('PASS: failed build preserves artifacts and starts no VM; explicit reuse needs no builder/NASM; all owned processes exit');
  } finally {
    for (const client of clients) await client.dispose();
    Processes.prototype.start = original.start; localHost.spawn = original.spawn;
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
