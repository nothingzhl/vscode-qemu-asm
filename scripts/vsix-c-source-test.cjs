// Launch an independently installed VSIX with copied, product-independent test
// inputs. No debugger code is loaded from the repository during this proof.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function main() {
  assert(process.env.QEMU_ASM_VSIX_EXTENSION, 'Set QEMU_ASM_VSIX_EXTENSION to the folder installed from the VSIX');
  const extensionRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION);
  const repositoryRoot = await fs.realpath(path.join(__dirname, '..'));
  assert(extensionRoot !== repositoryRoot && !extensionRoot.startsWith(repositoryRoot + path.sep), 'proof must use an independently installed package');
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'nothingzhl.vscode-qemu-asm');
  assert(manifest.contributes.breakpoints.some(item => item.language === 'c'), 'the installed package must contribute C source breakpoints');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu installed C source VSIX, '));
  try {
    const workspace = path.join(temporary, 'workspace with spaces, and commas');
    const profile = path.join(temporary, 'profile');
    const testDirectory = path.join(temporary, 'external-tests');
    await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(path.join(profile, 'User'), { recursive: true }), fs.mkdir(testDirectory)]);
    const tests = path.join(testDirectory, 'c-source.cjs');
    await fs.copyFile(path.join(repositoryRoot, 'test', 'host', 'c-source.cjs'), tests);
    const fixture = await fs.readFile(path.join(repositoryRoot, 'scripts', 'c-source-fixture.cjs'), 'utf8');
    assert(!fixture.includes('../dist/'), 'copied compiler fixture must contain no repository product import');
    await fs.writeFile(path.join(testDirectory, 'c-source-fixture.cjs'), fixture);
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.startupPrompt': 'never', 'workbench.startupEditor': 'none',
      'workbench.enableExperiments': false, 'chat.disableAIFeatures': true,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none'
    }));
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    console.log(`Testing installed C source VSIX ${manifest.version}: ${extensionRoot}`);
    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: extensionRoot, extensionTestsPath: tests,
      extensionTestsEnv: { QEMU_ASM_VSIX_EXTENSION: extensionRoot, QEMU_ASM_VSIX_TEST_ROOT: temporary },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions')]
    });
    console.log(`PASS: independently installed ${manifest.version} VSIX actual C source/native breakpoint/F11/F10/Shift-F11/DWARF struct-array/caller frame/stack inspector, with GDB and QEMU cleanup`);
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
