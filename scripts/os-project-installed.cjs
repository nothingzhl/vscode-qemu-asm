const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
async function main() {
  const vsix = process.argv[2];
  assert(vsix && process.argv.length === 3, 'Usage: node scripts/os-project-installed.cjs PATH_TO_VSIX');
  assert(process.env.VSCODE_EXECUTABLE_PATH, 'Set VSCODE_EXECUTABLE_PATH');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'DreamOS installed, '));
  try {
    const extensions = path.join(temp, 'extensions');
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(process.env.VSCODE_EXECUTABLE_PATH);
    const install = await promisify(execFile)(cli, [...args, '--no-sandbox', '--user-data-dir', path.join(temp, 'profile'),
      '--extensions-dir', extensions, '--install-extension', path.resolve(vsix), '--force'], { timeout: 120000 });
    process.stdout.write(install.stdout + install.stderr);
    const candidates = (await fs.readdir(extensions)).filter(name => /^nothingzhl\.vscode-qemu-asm-/.test(name));
    assert.equal(candidates.length, 1);
    const extension = await fs.realpath(path.join(extensions, candidates[0]));
    const child = spawn(process.execPath, [path.join(__dirname, 'os-project-host.cjs')], {
      env: { ...process.env, QEMU_ASM_VSIX_EXTENSION: extension }, stdio: 'inherit', shell: false
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed DreamOS test failed: ${code ?? signal}`)));
    });
  } finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
