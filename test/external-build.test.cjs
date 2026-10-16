const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveProject, Processes, build, execute } = require('../dist/core');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'C kernel build '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t, code, overrides = {}) {
  const root = await temporary(t);
  await fs.writeFile(path.join(root, 'builder with spaces.cjs'), code);
  const project = resolveProject(root, '.', {
    image: 'build/os.img',
    build: { command: process.execPath, args: ['builder with spaces.cjs'] },
    debug: { elf: 'build/kernel.elf', entry: 'kernel_main' },
    ...overrides
  });
  const processes = new Processes();
  t.after(() => processes.dispose());
  return { root, project, processes };
}
const validImage = "const fs=require('node:fs');fs.mkdirSync('build',{recursive:true});const b=Buffer.alloc(1024);b[510]=0x55;b[511]=0xaa;fs.writeFileSync('build/os.img',b);";

test('external project normalizes tools, source maps, entry and safe argument arrays', () => {
  const workspace = path.resolve(os.tmpdir(), 'two workspaces');
  const project = resolveProject(workspace, 'kernel source', {
    image: 'out/os.img',
    build: { command: './tool chain/build', args: ['a b', '$(literal)', ''], cwd: 'src', timeout: 5000 },
    debug: { elf: 'out/kernel.elf', gdbPath: './tools with spaces/gdb', sourceMap: { '/build/old': './src' }, entry: '0xc0000000' }
  }, { gdb: './ignored/gdb' });
  assert.equal(project.build.command, path.join(project.root, 'tool chain/build'));
  assert.deepEqual(project.build.args, ['a b', '$(literal)', '']);
  assert.equal(project.build.cwd, path.join(project.root, 'src'));
  assert.equal(project.build.timeout, 5000);
  assert.equal(project.debug.gdb, path.join(project.root, 'tools with spaces/gdb'));
  assert.equal(project.debug.elf, path.join(project.root, 'out/kernel.elf'));
  assert.equal(project.debug.sourceMap['/build/old'], path.join(project.root, 'src'));
  assert.equal(project.debug.entry, '0xc0000000');
  assert.equal(resolveProject(workspace, '.', { debug: { elf: 'kernel.elf' } }, { gdb: 'my-gdb' }).debug.gdb, 'my-gdb');
  assert.equal(resolveProject(workspace, '.', { build: { command: 'make' } }).build.timeout, 120000);
  assert.equal(resolveProject(workspace, '.', {}).build, undefined);
  assert.equal(resolveProject(workspace, '.', {}).debug, undefined);
});

test('external project rejects malformed commands, paths, maps and mixed build modes', () => {
  const invalid = [
    { build: null }, { build: {} }, { build: { command: '' } },
    { build: { command: 'C:make.exe' } }, { build: { command: 'make', args: 'all' } }, { build: { command: 'make', args: null } },
    { build: { command: 'make', args: ['\0'] } }, { build: { command: 'make', cwd: '..' } },
    { build: { command: 'make', timeout: 99 } }, { build: { command: 'make', timeout: 1800001 } }, { build: { command: 'make', timeout: null } },
    { build: { command: 'make' }, stages: [{ source: 'stage.asm', loadAddress: 0x8000, lba: 1 }] },
    { debug: {} }, { debug: null }, { debug: { elf: '' } },
    { debug: { elf: 'build/boot.img' } }, { debug: { elf: 'a', gdbPath: 'C:gdb.exe' } }, { debug: { elf: 'a', gdbPath: null } },
    { debug: { elf: 'a', sourceMap: [] } }, { debug: { elf: 'a', sourceMap: { old: 1 } } }, { debug: { elf: 'a', sourceMap: { old: undefined } } },
    { debug: { elf: 'a', entry: 'main\n-exec-run' } }, { debug: { elf: 'a', entry: '0x100000000' } }
  ];
  for (const config of invalid) assert.throws(() => resolveProject('/project', '.', config), JSON.stringify(config));
});

test('external build executes its argv without NASM or shell expansion and preserves its ELF', async t => {
  const { root, project, processes } = await fixture(t, validImage + "fs.writeFileSync('build/kernel.elf','builder ELF');fs.writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));", {
    build: { command: process.execPath, args: ['builder with spaces.cjs', 'one two', '$(touch should-not-exist)'] }
  });
  assert.deepEqual(await build(project, processes, () => {}), { units: [], imageBytes: 1024 });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'args.json'), 'utf8')), ['one two', '$(touch should-not-exist)']);
  assert.equal(await fs.readFile(project.debug.elf, 'utf8'), 'builder ELF');
  await assert.rejects(fs.stat(path.join(root, 'should-not-exist')));
});

test('failed external build preserves project-owned partial image and ELF, and rejects launch', async t => {
  const { project, processes } = await fixture(t, "const fs=require('node:fs');fs.writeFileSync('build/os.img','partial');process.exit(7);");
  await fs.mkdir(path.dirname(project.image));
  await fs.writeFile(project.image, 'old boot image');
  await fs.writeFile(project.debug.elf, 'keep ELF');
  await assert.rejects(build(project, processes, () => {}), /退出码 7/);
  assert.equal(await fs.readFile(project.image, 'utf8'), 'partial');
  assert.equal(await fs.readFile(project.debug.elf, 'utf8'), 'keep ELF');
});

test('external image validation rejects absent, unaligned, oversized and unsigned artifacts', async t => {
  for (const [bytes, signed] of [[0, false], [513, true], [1475072, true], [512, false]]) {
    const { project, processes } = await fixture(t, `const fs=require('node:fs');const b=Buffer.alloc(${bytes});${signed ? 'b[510]=0x55;b[511]=0xaa;' : ''}fs.writeFileSync('build/os.img',b);`);
    await assert.rejects(build(project, processes, () => {}), /512|55 aa/);
    assert.equal((await fs.stat(project.image)).size, bytes);
  }
  const { project, processes } = await fixture(t, '');
  await assert.rejects(build(project, processes, () => {}), /ENOENT/);
});

test('external image and listing aliases cannot replace ELF or configuration', async t => {
  const { root, project, processes } = await fixture(t, validImage);
  await fs.mkdir(path.dirname(project.image));
  for (const protectedFile of [project.debug.elf, path.join(root, 'qemu-asm.json')]) {
    await fs.writeFile(protectedFile, 'keep protected input');
    await fs.link(protectedFile, project.image);
    await assert.rejects(build(project, processes, () => {}), /同一文件/);
    assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep protected input');
    await fs.unlink(project.image);
  }
  await assert.rejects(build(project, processes, () => {}, () => false, project.debug.elf), /同一文件/);
  assert.equal(await fs.readFile(project.debug.elf, 'utf8'), 'keep protected input');
});

test('external build cwd and generated image cannot escape through symlinks', { skip: process.platform === 'win32' }, async t => {
  const outside = await temporary(t);
  const { root, project, processes } = await fixture(t, validImage, {
    build: { command: process.execPath, args: ['builder with spaces.cjs'], cwd: 'linked' }
  });
  await fs.symlink(outside, path.join(root, 'linked'));
  await assert.rejects(build(project, processes, () => {}), /build.cwd.*符号链接/);
  const externalFile = path.join(outside, 'disk.img');
  await fs.writeFile(externalFile, 'keep outside');
  await fs.writeFile(path.join(root, 'builder with spaces.cjs'), `require('node:fs').symlinkSync(${JSON.stringify(externalFile)},'build/os.img');`);
  project.build.cwd = root;
  await assert.rejects(build(project, processes, () => {}), /普通镜像文件/);
  assert.equal(await fs.readFile(externalFile, 'utf8'), 'keep outside');
  assert.equal((await fs.lstat(project.image)).isSymbolicLink(), true);
});

test('external build cancellation and timeout preserve project files and keep the manager usable', async t => {
  const script = "const fs=require('node:fs');fs.writeFileSync('build/os.img','partial');console.log('ready');setInterval(()=>{},1000);";
  for (const timeout of [1000, 5000]) {
    const { project, processes } = await fixture(t, script, { build: { command: process.execPath, args: ['builder with spaces.cjs'], timeout } });
    let cancelled = false;
    await assert.rejects(build(project, processes, text => { if (timeout === 5000 && text.includes('ready')) cancelled = true; }, () => cancelled), timeout === 1000 ? /超时/ : /已停止/);
    assert.equal(await fs.readFile(project.image, 'utf8'), 'partial');
    await execute(processes, process.execPath, ['-e', 'process.exit(0)'], project.root, () => {});
  }
});

test('stop terminates builder descendants even after their parent process exits', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const root = await temporary(t);
  const processes = new Processes();
  t.after(() => processes.dispose());
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const code = "const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',\"console.log('descendant ready');process.send('ready');setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>process.exit(0));";
  const run = processes.start(process.execPath, ['-e', code], root, () => markReady());
  await run.ready;
  await ready;
  await processes.stop();
  await run.done;
});

test('successful and failed builder exits clean unref descendants with ignored stdio', { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const root = await temporary(t);
  const processes = new Processes();
  t.after(() => processes.dispose());
  for (const status of [0, 7]) {
    const readyFile = path.join(root, `ready-${status}`);
    const leakedFile = path.join(root, `leaked-${status}`);
    const childCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(leakedFile)},'leaked'),200);`;
    const parentCode = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyFile)})){clearInterval(timer);process.exit(${status});}},5);`;
    const run = processes.start(process.execPath, ['-e', parentCode], root, () => {});
    await run.ready;
    if (status === 0) await run.done;
    else await assert.rejects(run.done, /退出码 7/);
    await new Promise(resolve => setTimeout(resolve, 250));
    await assert.rejects(fs.stat(leakedFile));
  }
});
