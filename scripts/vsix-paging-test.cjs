const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

async function main() {
  if (!process.env.QEMU_ASM_VSIX_EXTENSION) throw new Error('Set QEMU_ASM_VSIX_EXTENSION to the extension folder installed from the packaged VSIX');
  const extensionRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION);
  const repositoryRoot = await fs.realpath(path.join(__dirname, '..'));
  if (extensionRoot === repositoryRoot || extensionRoot.startsWith(repositoryRoot + path.sep)) {
    throw new Error('VSIX paging proof must use the installed package outside the repository');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'nothingzhl.vscode-qemu-asm');
  assert(manifest.contributes.commands.some(command => command.command === 'qemuAsm.showPaging'), 'installed package must contribute its paging command');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu VSIX paging proof '));
  try {
    const workspace = path.join(temporary, 'workspace with spaces, and commas');
    const profile = path.join(temporary, 'profile');
    const testDirectory = path.join(temporary, 'external-tests');
    const tests = path.join(testDirectory, 'vsix-paging.cjs');
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }), fs.mkdir(path.join(profile, 'User'), { recursive: true }),
      fs.mkdir(testDirectory, { recursive: true })
    ]);
    await fs.copyFile(path.join(repositoryRoot, 'test', 'host', 'vsix-paging.cjs'), tests);
    // The fixture is test data, copied outside the repository. Its sole product
    // import must resolve from the independently installed package as well.
    const fixture = await fs.readFile(path.join(repositoryRoot, 'scripts', 'paging-fixture.cjs'), 'utf8');
    const originalImport = "const core = require('../dist/core');";
    assert.equal(fixture.split(originalImport).length, 2, 'paging fixture must have exactly one known product import');
    await fs.writeFile(path.join(testDirectory, 'paging-fixture.cjs'), fixture.replace(originalImport,
      "const core = require(path.join(process.env.QEMU_ASM_VSIX_EXTENSION, 'dist', 'core.js'));"));
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.startupPrompt': 'never', 'workbench.startupEditor': 'none',
      'workbench.enableExperiments': false, 'chat.disableAIFeatures': true,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none'
    }));
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    console.log(`Testing installed VSIX paging ${manifest.version}: ${extensionRoot}`);
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: tests,
      extensionTestsEnv: { QEMU_ASM_VSIX_EXTENSION: extensionRoot, QEMU_ASM_VSIX_TEST_ROOT: temporary },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions')]
    });
    console.log(`PASS: packaged VSIX ${manifest.version} paging command, own WASM decoder, real high virtual code, physical page walk and data breakpoints`);
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
