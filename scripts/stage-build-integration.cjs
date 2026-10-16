const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PROTECTED_MARKER, createProject, resolveProject, build, Processes, qemuArguments } = require('../dist/core');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu 二阶段 build, '));
  const runner = new Processes();
  let timer;
  try {
    await createProject(root, 'protected');
    const config = JSON.parse(await fs.readFile(path.join(root, 'qemu-asm.json'), 'utf8'));
    const project = resolveProject(root, '.', config, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH });
    const listing = path.join(root, 'boot.lst');
    const result = await build(project, runner, text => process.stdout.write(text), () => false, listing);
    assert.equal(result.imageBytes, 1474560);
    assert.deepEqual(result.units.map(unit => [unit.loadAddress, unit.lba, unit.size]), [[0x7c00, 0, 512], [0x8000, 1, 1024]]);
    await Promise.all(result.units.map(unit => fs.access(unit.listingPath)));
    const image = await fs.readFile(project.image);
    assert.equal(image.length, 1474560);
    assert.equal(image.subarray(510, 512).toString('hex'), '55aa');
    assert.equal(image.indexOf(PROTECTED_MARKER), 512 + 768, 'Success marker must require reading stage2\'s second sector');
    assert(image.subarray(1536).every(byte => byte === 0));
    console.log('PASS: actual NASM builds a 1.44MB floppy, boot signature, 1024B second stage and independent listings');

    let output = '';
    let received;
    const marker = new Promise(resolve => { received = resolve; });
    const run = runner.start(project.qemu, qemuArguments(project, runner.host), project.root, text => {
      output += text;
      process.stdout.write(text);
      if (output.includes(PROTECTED_MARKER)) received();
    });
    await run.ready;
    await Promise.race([
      marker,
      run.done.then(() => { throw new Error('QEMU exited before the protected-mode marker'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QEMU stage2 boot timed out (15s)')), 15000); })
    ]);
    clearTimeout(timer);
    await runner.stop();
    await run.done;
    assert(run.child.exitCode !== null || run.child.signalCode !== null);
    console.log('\nPASS: actual QEMU TCG reads multiple sectors, enters 32-bit mode, emits serial success and stops cleanly');

    await fs.writeFile(path.join(root, 'extra.asm'), 'bits 16\norg 0xa000\ntimes 513 db 0x5a\n');
    const multiple = resolveProject(root, '.', { ...config, stages: [...config.stages, { source: 'extra.asm', loadAddress: 0xa000, lba: 4 }] }, { nasm: process.env.NASM_PATH });
    const multipleResult = await build(multiple, runner, text => process.stdout.write(text));
    assert.deepEqual(multipleResult.units.map(unit => unit.size), [512, 1024, 513]);
    const multipleImage = await fs.readFile(multiple.image);
    assert(multipleImage.subarray(2048, 2561).every(byte => byte === 0x5a));
    assert(multipleImage.subarray(2561, 3072).every(byte => byte === 0));
    console.log('PASS: actual NASM lays out multiple source files at configured LBAs and pads partial sectors');

    await fs.writeFile(project.stages[0].source, 'invalid stage assembly\n');
    await assert.rejects(build(project, runner, () => {}));
    await assert.rejects(fs.stat(project.image));
    assert.deepEqual(await fs.readdir(path.dirname(project.image)), []);
    console.log('PASS: a real stage2 assembler failure removes the previous image and temporary artifacts');
  } finally {
    clearTimeout(timer);
    await runner.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
