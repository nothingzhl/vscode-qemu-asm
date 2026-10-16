// Install-product proof: only disposable inputs and tests are copied; product
// modules and manifest must come from the independently installed artifact.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
async function main() {
  assert(process.env.QEMU_ASM_VSIX_EXTENSION, 'Set QEMU_ASM_VSIX_EXTENSION to the installed artifact folder');
  const extensionRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION);
  const repositoryRoot = await fs.realpath(path.join(__dirname, '..'));
  assert(extensionRoot !== repositoryRoot && !extensionRoot.startsWith(repositoryRoot + path.sep));
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'nothingzhl.vscode-qemu-asm');
  assert(manifest.contributes.commands.some(item => item.command === 'qemuAsm.selectMachineProfile'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu installed startup profiles, '));
  try {
    const first = path.join(temporary, 'first workspace with spaces, and commas'), second = path.join(temporary, 'other workspace');
    const profile = path.join(temporary, 'profile'), testDirectory = path.join(temporary, 'external-tests');
    await Promise.all([fs.mkdir(first), fs.mkdir(second), fs.mkdir(path.join(profile, 'User'), { recursive: true }), fs.mkdir(testDirectory)]);
    const workspace = path.join(temporary, 'profiles.code-workspace');
    await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: first }, { path: second }] }));
    const tests = path.join(testDirectory, 'machine-profiles.cjs');
    await fs.copyFile(path.join(repositoryRoot, 'test', 'host', 'machine-profiles.cjs'), tests);
    await fs.copyFile(path.join(repositoryRoot, 'scripts', 'c-source-fixture.cjs'), path.join(testDirectory, 'c-source-fixture.cjs'));
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.startupPrompt': 'never', 'workbench.startupEditor': 'none',
      'workbench.enableExperiments': false, 'chat.disableAIFeatures': true,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none'
    }));
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: extensionRoot, extensionTestsPath: tests,
      extensionTestsEnv: { QEMU_ASM_VSIX_EXTENSION: extensionRoot, QEMU_ASM_VSIX_TEST_ROOT: temporary },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions')]
    });
    console.log(`PASS: independently installed ${manifest.version} VSIX actual QuickPick, isolated profiles, launch/restart memory/CPU/display and C/NASM debug`);
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
