const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveProject, build, Processes } = require('../dist/core');
const { qemuArguments } = require('../dist/backends/qemu/arguments');
const { checkEnvironment } = require('../dist/dependencies/doctor');

// ISO protocol fixture, not an executable guest. Real firmware boot is tested separately.
function iso() {
  const b = Buffer.alloc(2048 * 1024);
  function descriptor(index, type) { const d = b.subarray(index * 2048, (index + 1) * 2048); d[0] = type; d.write('CD001', 1); d[6] = 1; return d; }
  descriptor(16, 1);
  const boot = descriptor(17, 0); boot.write('EL TORITO SPECIFICATION', 7); boot.writeUInt32LE(20, 71);
  descriptor(18, 255);
  const entry = b.subarray(20 * 2048); entry[0] = 1; entry[30] = 0x55; entry[31] = 0xaa;
  entry.writeUInt16LE(0x55aa, 28); entry[32] = 0x88;
  return b;
}
async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'OS artifacts, '));
  const processes = new Processes();
  t.after(async () => { await processes.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const project = resolveProject(root, '.', { image: 'kernel, boot.iso', boot: { type: 'iso' }, build: false, ...config });
  return { root, project, processes };
}

test('ISO and artifact mode are explicit; old projects retain NASM/floppy defaults', () => {
  const old = resolveProject('/os', '.', {});
  assert.equal(old.boot, undefined); assert.equal(old.buildMode, undefined);
  assert(qemuArguments(old).includes('a'));
  for (const config of [{ boot: { type: 'iso' } }, { boot: null }, { boot: { type: 'uefi' }, build: false },
    { boot: { type: ['iso'] }, build: false }, { boot: { type: 'iso', args: [] }, build: false },
    { build: false, stages: [{ source: 'stage.asm', loadAddress: 0x8000, lba: 1 }] }])
    assert.throws(() => resolveProject('/os', '.', config));
});

test('existing ISO validates without invoking tools or modifying project artifacts', async t => {
  const { project, processes } = await fixture(t);
  await fs.writeFile(project.image, iso());
  const before = await fs.stat(project.image);
  processes.start = () => { throw new Error('existing artifacts must not execute tools'); };
  assert.deepEqual(await build(project, processes, () => {}), { units: [], imageBytes: 2097152 });
  const after = await fs.stat(project.image);
  assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(before.ino, after.ino);
  assert.deepEqual(await fs.readFile(project.image), iso());
  const args = qemuArguments(project);
  assert(args.includes('d'));
  assert(args.some(arg => arg.includes('kernel,, boot.iso,format=raw,media=cdrom,readonly=on')));
  assert(!args.some(arg => arg.includes('if=floppy')));
});

test('invalid, UEFI-only and out-of-bounds ISO catalogs reject without deleting outputs', async t => {
  const { project, processes } = await fixture(t);
  const variants = [Buffer.alloc(2048), iso(), iso(), iso(), iso()];
  variants[1][16 * 2048 + 1] = 0;
  variants[2][20 * 2048 + 1] = 0xef;
  variants[3].writeUInt32LE(0xffffffff, 17 * 2048 + 71);
  variants[4][20 * 2048 + 32] = 0;
  for (const bytes of variants) {
    await fs.writeFile(project.image, bytes);
    await assert.rejects(build(project, processes, () => {}), /ISO/);
    assert.deepEqual(await fs.readFile(project.image), bytes);
  }
});

test('an incremental external build can read its existing output; a failed build preserves it', async t => {
  const { root, project, processes } = await fixture(t, { build: { command: process.execPath, args: ['builder.cjs'] } });
  await fs.writeFile(project.image, iso());
  await fs.writeFile(path.join(root, 'builder.cjs'), `const fs=require('fs');if(fs.statSync(${JSON.stringify(project.image)}).size!==2097152)process.exit(9);`);
  assert.equal((await build(project, processes, () => {})).imageBytes, 2097152);
  project.build.args = ['-e', 'process.exit(7)'];
  await assert.rejects(build(project, processes, () => {}), /退出码 7/);
  assert.deepEqual(await fs.readFile(project.image), iso());
});

test('existing artifact cancellation and missing outputs do not start builders or create directories', async t => {
  const { project, processes } = await fixture(t);
  await assert.rejects(build(project, processes, () => {}, () => true), /已停止/);
  await assert.rejects(build(project, processes, () => {}), /ENOENT/);
  const nested = { ...project, image: path.join(project.root, 'absent', 'boot.iso') };
  await assert.rejects(build(nested, processes, () => {}), /ENOENT/);
  await assert.rejects(fs.stat(path.dirname(nested.image)), /ENOENT/);
});

test('existing artifacts do not require NASM or an external builder in the environment report', async t => {
  const { project, processes } = await fixture(t);
  const report = await checkEnvironment(project, processes);
  assert.deepEqual(report.tools.map(tool => tool.id), ['qemu']);
  assert.equal(report.project.build, 'existing');
});

test('ISO media preserves selected machine resources and native Windows relative paths', () => {
  const project = resolveProject('/os', '.', {
    image: 'boot.iso', boot: { type: 'iso' }, build: false,
    machineProfiles: { normal: { memoryMiB: 64, cpuModel: 'qemu32', display: false } },
    defaultMachineProfile: 'normal'
  }, { qemuArgs: ['-m', '16M', '-smp', '1'] });
  const args = qemuArguments(project);
  assert.equal(args[args.indexOf('-m') + 1], '64M');
  assert.equal(args[args.indexOf('-cpu') + 1], 'qemu32');
  assert.equal(args[args.indexOf('-smp') + 1], '1');
  assert(args.some(arg => arg.includes('media=cdrom')));
  const windows = qemuArguments({ ...project, root: 'C:\\OS workspace', image: 'C:\\OS workspace\\boot, image.iso' },
    { identity: { platform: 'win32' }, paths: path.win32 });
  assert(windows.includes('file=.\\boot,, image.iso,format=raw,media=cdrom,readonly=on'));
});
