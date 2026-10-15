const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

async function main() {
  if (!process.env.QEMU_ASM_VSIX_EXTENSION) throw new Error('Set QEMU_ASM_VSIX_EXTENSION to the extension folder installed from the packaged VSIX');
  const extensionRoot = await fs.realpath(process.env.QEMU_ASM_VSIX_EXTENSION);
  const repositoryRoot = await fs.realpath(path.join(__dirname, '..'));
  if (extensionRoot === repositoryRoot) throw new Error('VSIX proof must use the installed package, not the repository development extension');
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  if (`${manifest.publisher}.${manifest.name}` !== 'nothingzhl.vscode-qemu-asm') throw new Error('Unexpected installed extension identity');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu VSIX machine proof '));
  try {
    const workspace = path.join(temporary, 'workspace with spaces, and commas');
    const profile = path.join(temporary, 'profile');
    const tests = path.join(temporary, 'external-tests', 'vsix-machine.cjs');
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }), fs.mkdir(path.join(profile, 'User'), { recursive: true }),
      fs.mkdir(path.dirname(tests), { recursive: true })
    ]);
    // The host executes a standalone copy outside both the repository and the
    // installed extension; it imports product code only from the latter.
    await fs.copyFile(path.join(repositoryRoot, 'test', 'host', 'vsix-machine.cjs'), tests);
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.startupPrompt': 'never', 'workbench.startupEditor': 'none',
      'workbench.enableExperiments': false, 'chat.disableAIFeatures': true,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none'
    }));
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    console.log(`Testing installed VSIX ${manifest.version}: ${extensionRoot}`);
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: tests,
      extensionTestsEnv: { QEMU_ASM_VSIX_EXTENSION: extensionRoot, QEMU_ASM_VSIX_TEST_ROOT: temporary },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--user-data-dir', profile, '--extensions-dir', path.join(temporary, 'extensions')]
    });
    console.log(`PASS: packaged VSIX ${manifest.version} loads its own WASM decoder, source debugging and real QEMU data watchpoints`);
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
