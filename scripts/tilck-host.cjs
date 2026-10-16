const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
const { prepare, lock } = require('./tilck/prepare.cjs');
async function main() {
  assert(process.env.TILCK_SOURCE, 'Set TILCK_SOURCE');
  assert(process.env.VSCODE_EXECUTABLE_PATH, 'Set VSCODE_EXECUTABLE_PATH to an existing VS Code executable');
  const repository = path.resolve(__dirname, '..');
  const extension = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION || repository);
  if (process.env.QEMU_ASM_VSIX_EXTENSION) assert(extension !== repository && !extension.startsWith(repository + path.sep));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'Tilck host, '));
  let release;
  try {
    release = await lock(process.env.TILCK_SOURCE);
    const root = await prepare(process.env.TILCK_SOURCE, path.join(temp, 'workspace with spaces'));
    const tests = path.join(temp, 'tests'); await fs.mkdir(tests);
    await fs.copyFile(path.join(repository, 'test/host/tilck.cjs'), path.join(tests, 'index.cjs'));
    await fs.copyFile(path.join(repository, 'scripts/tilck/exercise.cjs'), path.join(tests, 'exercise.cjs'));
    const profile = path.join(temp, 'profile'); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.startupPrompt': 'never',
      'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
    await runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH, extensionDevelopmentPath: extension,
      extensionTestsPath: path.join(tests, 'index.cjs'), extensionTestsEnv: { OS_PROJECT_EXTENSION: extension },
      launchArgs: [root, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temp, 'extensions')] });
    console.log(`PASS: Tilck VS Code host (${process.env.QEMU_ASM_VSIX_EXTENSION ? 'installed VSIX' : 'development'})`);
  } finally {
    if (release) await release();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
