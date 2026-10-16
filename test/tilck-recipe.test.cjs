const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const recipe = require.resolve('../examples/tilck/tilck-iso.cjs');
function builder(run) {
  const original = cp.execFile;
  try {
    cp.execFile = Object.assign(() => {}, { [promisify.custom]: run });
    delete require.cache[recipe];
    return require(recipe).build;
  } finally { cp.execFile = original; delete require.cache[recipe]; }
}
for (const failure of ['none', 'compile', 'iso']) test(`Tilck recipe ${failure}: matching output and compiler/package failure preservation`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Tilck recipe, spaces '));
  try {
    const source = path.join(root, 'upstream'); const output = path.join(root, 'output/boot.iso');
    await fs.mkdir(path.join(source, 'build'), { recursive: true });
    await fs.mkdir(path.dirname(output));
    for (const [name, text] of Object.entries({ tilck: 'new kernel', fatpart: 'real initrd', tilck_unstripped: 'matching symbols' }))
      await fs.writeFile(path.join(source, 'build', name), text);
    await fs.writeFile(output, 'old ISO'); await fs.writeFile(output.replace('.iso', '.elf'), 'old ELF');
    let calls = 0;
    const build = builder(async (command, args) => {
      calls++;
      if (calls === 1) { if (failure === 'compile') throw new Error('compile failed'); }
      else {
        const staging = args.at(-1);
        assert.equal(await fs.readFile(path.join(staging, 'boot/tilck'), 'utf8'), 'new kernel');
        assert.equal(await fs.readFile(path.join(staging, 'boot/fatpart'), 'utf8'), 'real initrd');
        if (failure === 'iso') throw new Error('ISO failed');
        await fs.writeFile(args[1], 'new ISO');
      }
      return { stdout: '', stderr: '' };
    });
    if (failure === 'none') await build(source, output);
    else await assert.rejects(build(source, output), /failed/);
    assert.equal(await fs.readFile(output, 'utf8'), failure === 'none' ? 'new ISO' : 'old ISO');
    assert.equal(await fs.readFile(output.replace('.iso', '.elf'), 'utf8'), failure === 'none' ? 'matching symbols' : 'old ELF');
    assert.deepEqual((await fs.readdir(path.dirname(output))).sort(), ['boot.elf', 'boot.iso']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('Tilck acceptance excludes concurrent edits to the same source checkout', async () => {
  const { lock } = require('../scripts/tilck/prepare.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Tilck lock '));
  try {
    const release = await lock(root);
    try { await assert.rejects(lock(root), { code: 'EEXIST' }); }
    finally { await release(); }
    const again = await lock(root); await again();
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
