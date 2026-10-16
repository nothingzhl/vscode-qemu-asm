// Explicit developer setup only. No network access and no overwriting user projects.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const revision = '85393cbcdeb9ca0bafb84e9631c2c7f21be76141';
async function prepare(source, destination) {
  source = path.resolve(source); destination = path.resolve(destination);
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: source });
  if (stdout.trim() !== revision) throw new Error(`Expected DreamOS commit ${revision}`);
  await fs.mkdir(destination); // exclusive: refuse any existing destination
  const archive = path.join(destination, '.upstream.tar');
  try {
    // Export the pinned tree, never local edits or earlier build products.
    await exec('git', ['archive', '--format=tar', '--output', archive, revision], { cwd: source });
    await exec('tar', ['-xf', archive, '-C', destination]);
    const examples = path.resolve(__dirname, '../../examples/dreamos');
    for (const file of ['qemu-toolkit.mk', 'qemu-asm.json'])
      await fs.copyFile(path.join(examples, file), path.join(destination, file), require('node:fs').constants.COPYFILE_EXCL);
  } finally { await fs.rm(archive, { force: true }); }
  return destination;
}
module.exports = { prepare, revision };
if (require.main === module) {
  const [source, destination, ...extra] = process.argv.slice(2);
  if (!source || !destination || extra.length) throw new Error('Usage: node scripts/os-project/prepare.cjs UPSTREAM_CHECKOUT NEW_DIRECTORY');
  prepare(source, destination).then(root => console.log(root)).catch(error => { console.error(error); process.exitCode = 1; });
}
