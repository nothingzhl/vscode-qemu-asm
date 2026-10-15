const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

// runTests always appends --disable-workspace-trust, so restricted-mode coverage
// must launch the same real Electron test host directly with trust enabled.
async function runRestrictedHost(executable, extensionRoot, launchArgs, env) {
  const child = spawn(executable, [...launchArgs,
    `--extensionDevelopmentPath=${extensionRoot}`,
    `--extensionTestsPath=${path.join(extensionRoot, 'test', 'host', 'index.cjs')}`
  ], { env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', text => process.stdout.write(text));
  child.stderr.on('data', text => process.stderr.write(text));
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error('Restricted VS Code host timeout (90s)')); }, 90000);
      child.once('error', reject);
      child.once('exit', (code, signal) => { code === 0 ? resolve() : reject(new Error(`Restricted VS Code host failed: ${code ?? signal}`)); });
    });
  } finally {
    clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

async function main() {
  const extensionRoot = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu asm host, '));
  try {
    const supportedPhases = ['trusted', 'untrusted', 'resources', 'debug', 'display', 'protected', 'inspection'];
    const phases = process.env.QEMU_ASM_HOST_PHASES === undefined ? supportedPhases : process.env.QEMU_ASM_HOST_PHASES.split(',').map(phase => phase.trim()).filter(Boolean);
    if (!phases.length || phases.some(phase => !supportedPhases.includes(phase))) throw new Error(`QEMU_ASM_HOST_PHASES must name one or more phases: ${supportedPhases.join(', ')}`);
    const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    for (const phase of phases) {
      const root = path.join(temporary, phase, 'workspace with spaces, and commas');
      const other = path.join(temporary, phase, 'other workspace');
      const profile = path.join(temporary, phase, 'profile');
      await Promise.all([fs.mkdir(root, { recursive: true }), fs.mkdir(other, { recursive: true }), fs.mkdir(path.join(profile, 'User'), { recursive: true })]);
      await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': true,
        'security.workspace.trust.startupPrompt': 'never',
        'security.workspace.trust.banner': 'never',
        'workbench.startupEditor': 'none',
        'workbench.enableExperiments': false,
        'chat.disableAIFeatures': true,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none'
      }));
      let workspace = root;
      if (phase === 'resources') {
        workspace = path.join(temporary, phase, 'resources.code-workspace');
        await fs.writeFile(workspace, JSON.stringify({ folders: [{ path: root }, { path: other }] }));
      }
      console.log(`\nVS Code host phase: ${phase} (${executable})`);
      const extensionTestsEnv = { QEMU_ASM_HOST_PHASE: phase, QEMU_ASM_HOST_ROOT: root, QEMU_ASM_HOST_OTHER_ROOT: other };
      const launchArgs = [workspace, '--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', profile, '--extensions-dir', path.join(temporary, phase, 'extensions'),
        ...(phase === 'untrusted' ? [] : ['--disable-workspace-trust'])];
      if (phase === 'untrusted') await runRestrictedHost(executable, extensionRoot, launchArgs, extensionTestsEnv);
      else await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: extensionRoot,
        extensionTestsPath: path.join(extensionRoot, 'test', 'host', 'index.cjs'),
        extensionTestsEnv,
        launchArgs
      });
    }
    console.log(`\nPASS: real VS Code host phases: ${phases.join(', ')}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
