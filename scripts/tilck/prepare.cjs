const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const revision = '01dacaa51a074474a4e5491fc80addfe98956500';
async function lock(source) {
  const file = path.join(await fs.realpath(source), '.tilck-toolkit-test.lock');
  const handle = await fs.open(file, 'wx');
  return async () => { await handle.close(); await fs.unlink(file); };
}
async function prepare(source, destination) {
  source = await fs.realpath(source); destination = path.resolve(destination);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim(), revision);
  await exec('git', ['diff', '--exit-code', 'HEAD', '--', 'kernel', 'include', 'common'], { cwd: source });
  await fs.mkdir(destination); // refuse to overwrite a user workspace
  for (const file of ['tilck-iso.cjs', 'grub.cfg', 'qemu-asm.json'])
    await fs.copyFile(path.resolve(__dirname, '../../examples/tilck', file), path.join(destination, file), require('node:fs').constants.COPYFILE_EXCL);
  const configPath = path.join(destination, 'qemu-asm.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.build.command = process.execPath;
  config.build.args[1] = source;
  config.debug.sourceMap = { '/work': source };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await fs.writeFile(path.join(destination, 'tilck-source.json'), JSON.stringify({ source }));
  return destination;
}
module.exports = { prepare, lock };
