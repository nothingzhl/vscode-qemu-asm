const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepare, lock } = require('./tilck/prepare.cjs');
const { exercise } = require('./tilck/exercise.cjs');
const { DapClient } = require('./os-project/client.cjs');
const { resolveProject } = require('../dist/core');
const { createDebugAdapter } = require('../dist/composition/createAdapter');
const { localHost } = require('../dist/platform/host');
async function main() {
  assert(process.env.TILCK_SOURCE, 'Set TILCK_SOURCE to the pinned built checkout');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'Tilck ISO, '));
  let release;
  const clients = [], children = [];
  const spawn = localHost.spawn;
  try {
    release = await lock(process.env.TILCK_SOURCE);
    localHost.spawn = function(...args) { const child = spawn.apply(this, args); children.push(child); return child; };
    const root = await prepare(process.env.TILCK_SOURCE, path.join(temp, 'workspace with spaces'));
    const config = JSON.parse(await fs.readFile(path.join(root, 'qemu-asm.json'), 'utf8'));
    const tools = { qemu: process.env.QEMU_PATH || 'qemu-system-i386', gdb: process.env.GDB_PATH || 'gdb', nasm: '/missing/nasm' };
    const create = configuration => {
      const project = resolveProject(root, '.', configuration, tools);
      const client = new DapClient(createDebugAdapter(project, { getProject: async () => project, isTrusted: () => true, log: text => process.stdout.write(text) }));
      clients.push(client); return client;
    };
    const client = create(config);
    await client.launch(); await exercise(client, root); await client.disconnect();
    const files = ['iso', 'elf'].map(ext => path.join(root, `build/tilck-toolkit.${ext}`));
    const previous = await Promise.all(files.map(file => fs.readFile(file)));
    const count = children.length;
    const failed = create({ ...config, build: { command: process.execPath, args: ['-e', 'process.exit(7)'] } });
    await assert.rejects(failed.launch(), /退出码 7/); await failed.event('terminated');
    assert.equal(children.length, count + 1, 'failed build starts only its builder, no QEMU or GDB');
    for (let i = 0; i < files.length; i++) assert.deepEqual(await fs.readFile(files[i]), previous[i]);
    const reused = create({ ...config, build: false });
    const beforeReuse = children.length;
    await reused.launch(); await reused.disconnect();
    assert.equal(children.length, beforeReuse + 2, 'existing mode needs QEMU and GDB, no compiler or NASM');
    for (const child of children) assert(child.exitCode !== null || child.signalCode !== null, 'all owned processes must exit');
    console.log('PASS: Tilck failed build blocks VM launch and preserves artifacts; existing ISO reuse and process cleanup');
  } finally {
    try { for (const client of clients) await client.dispose(); }
    finally { localHost.spawn = spawn; if (release) await release(); await fs.rm(temp, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
