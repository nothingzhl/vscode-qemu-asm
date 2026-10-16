// Same host assertions run against development output or an independently installed VSIX.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
const { prepare } = require('./os-project/prepare.cjs');
async function main() {
  assert(process.env.DREAMOS_SOURCE, 'Set DREAMOS_SOURCE to the pinned upstream checkout');
  assert(process.env.VSCODE_EXECUTABLE_PATH, 'Set VSCODE_EXECUTABLE_PATH to an existing VS Code executable');
  const repository = path.resolve(__dirname, '..');
  const extension = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION || repository);
  if (process.env.QEMU_ASM_VSIX_EXTENSION) assert(!extension.startsWith(repository + path.sep) && extension !== repository);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'DreamOS host, '));
  try {
    const root = await prepare(process.env.DREAMOS_SOURCE, path.join(temp, 'real OS workspace, with spaces'));
    const tests = path.join(temp, 'external-tests'); await fs.mkdir(tests);
    await fs.copyFile(path.join(repository, 'test/host/os-project.cjs'), path.join(tests, 'index.cjs'));
    await fs.copyFile(path.join(repository, 'scripts/os-project/exercise.cjs'), path.join(tests, 'os-project-exercise.cjs'));
    const profile = path.join(temp, 'profile'); await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.startupPrompt': 'never',
      'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
    await runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH, extensionDevelopmentPath: extension,
      extensionTestsPath: path.join(tests, 'index.cjs'), extensionTestsEnv: { OS_PROJECT_EXTENSION: extension },
      launchArgs: [root, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temp, 'extensions')] });
    console.log(`PASS: DreamOS host acceptance (${process.env.QEMU_ASM_VSIX_EXTENSION ? 'installed VSIX' : 'development'})`);
  } finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
