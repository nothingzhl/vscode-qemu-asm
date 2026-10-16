// Explicit external builder. Toolchain setup and CMake configuration are prerequisites.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);
async function build(source, output) {
  source = path.resolve(source); output = path.resolve(output);
  if (!output.endsWith('.iso')) throw new Error('Output must end in .iso');
  const result = await exec(process.env.TILCK_CMAKE || 'cmake', ['--build', path.join(source, 'build'), '--parallel', '2'],
    { cwd: source, timeout: 150000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout + result.stderr);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temp = await fs.mkdtemp(path.join(path.dirname(output), '.tilck-iso-'));
  try {
    const boot = path.join(temp, 'root/boot'); await fs.mkdir(path.join(boot, 'grub'), { recursive: true });
    for (const file of ['tilck', 'fatpart']) await fs.copyFile(path.join(source, 'build', file), path.join(boot, file));
    await fs.copyFile(path.join(source, 'build/tilck_unstripped'), path.join(temp, 'symbols.elf'));
    await fs.copyFile(path.join(__dirname, 'grub.cfg'), path.join(boot, 'grub/grub.cfg'));
    const iso = await exec(process.env.GRUB_MKRESCUE || 'grub-mkrescue', ['-o', path.join(temp, 'boot.iso'), path.join(temp, 'root')],
      { timeout: 30000, maxBuffer: 1024 * 1024 });
    process.stdout.write(iso.stdout + iso.stderr);
    await fs.rename(path.join(temp, 'symbols.elf'), output.slice(0, -4) + '.elf');
    await fs.rename(path.join(temp, 'boot.iso'), output);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
module.exports = { build };
if (require.main === module) {
  const [source, output, ...extra] = process.argv.slice(2);
  if (!source || !output || extra.length) throw new Error('Usage: node tilck-iso.cjs SOURCE OUTPUT.iso');
  build(source, output).catch(error => { console.error(error); process.exitCode = 1; });
}
