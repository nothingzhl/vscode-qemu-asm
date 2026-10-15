// Independently installed-package proof: copy only test inputs outside the
// checkout and import every product module from the installed extension root.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function main() {
  assert(process.env.QEMU_ASM_VSIX_EXTENSION, 'Set QEMU_ASM_VSIX_EXTENSION to the independently installed VSIX folder');
  const extensionRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION);
  const repositoryRoot = await fs.realpath(path.join(__dirname, '..'));
  assert(extensionRoot !== repositoryRoot && !extensionRoot.startsWith(repositoryRoot + path.sep));
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'nothingzhl.vscode-qemu-asm');
  assert(manifest.contributes.commands.some(command => command.command === 'qemuAsm.showDependencyReport'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu installed dependencies VSIX, '));
  try {
    const workspace = path.join(temporary, 'workspace with spaces, and commas'), profile = path.join(temporary, 'profile');
    const testDirectory = path.join(temporary, 'external-tests');
    await Promise.all([fs.mkdir(workspace), fs.mkdir(path.join(profile, 'User'), { recursive: true }), fs.mkdir(testDirectory)]);
    const tests = path.join(testDirectory, 'dependencies.cjs');
    await fs.copyFile(path.join(repositoryRoot, 'test', 'host', 'dependencies.cjs'), tests);
    const fixture = await fs.readFile(path.join(repositoryRoot, 'scripts', 'c-source-fixture.cjs'), 'utf8');
    assert(!fixture.includes('../dist/')); await fs.writeFile(path.join(testDirectory, 'c-source-fixture.cjs'), fixture);
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.startupPrompt': 'never', 'workbench.startupEditor': 'none',
      'workbench.enableExperiments': false, 'chat.disableAIFeatures': true,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    }));
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    console.log(`Testing installed dependency VSIX ${manifest.version}: ${extensionRoot}`);
    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: extensionRoot, extensionTestsPath: tests,
      extensionTestsEnv: { QEMU_ASM_VSIX_EXTENSION: extensionRoot, QEMU_ASM_VSIX_TEST_ROOT: temporary },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions')],
    });
    console.log(`PASS: independently installed ${manifest.version} VSIX dependency resolution/check/report, NASM without GDB, external build/C without NASM, display-off debugging and owned-process cleanup`);
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
