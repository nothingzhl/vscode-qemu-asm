// Install the actual artifact outside the checkout before executing host tests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
const { options, runScript, writeResults } = require('./run-suite.cjs');

async function main() {
  // This CI entry point is Linux-only; the upstream CLI resolver returns a .cmd
  // on Windows, which requires a separately reviewed native launch boundary.
  assert.equal(process.platform, 'linux', 'Installed CI suite currently targets Linux');
  const args = options(process.argv.slice(2), ['vsix', 'output']);
  if (!args.vsix) throw new Error('Set --vsix to the packaged extension artifact');
  const output = path.resolve(args.output || 'artifacts/installed');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu CI installed, '));
  const results = [];
  try {
    const extensions = path.join(temporary, 'extensions');
    const executable = process.env.VSCODE_EXECUTABLE_PATH ||
      await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
    const install = await promisify(execFile)(cli, [...cliArgs, '--no-sandbox',
      '--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', extensions,
      '--install-extension', path.resolve(args.vsix), '--force'], { timeout: 120000 });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'install.log'), install.stdout + install.stderr);
    const candidates = await fs.readdir(extensions);
    const installed = candidates.filter(name => /^nothingzhl\.vscode-qemu-asm-/.test(name));
    assert.equal(installed.length, 1, `Expected one installed product: ${candidates.join(', ')}`);
    const extension = await fs.realpath(path.join(extensions, installed[0]));
    const decoder = require.resolve('iced-x86', { paths: [extension] });
    assert(decoder.startsWith(extension + path.sep), 'Decoder must resolve from the VSIX');
    assert.equal(await fs.stat(path.join(path.dirname(decoder), 'iced_x86_bg.wasm')).then(item => item.isFile()), true);
    const env = { ...process.env, VSCODE_EXECUTABLE_PATH: executable, QEMU_ASM_VSIX_EXTENSION: extension };
    for (const name of ['vsix-machine-test', 'vsix-paging-test', 'vsix-c-source-test', 'vsix-dependencies-test', 'vsix-machine-profiles-test']) {
      results.push(await runScript(name, output, env));
    }
    const report = writeResults(output, results, {
      suite: 'installed', vscode: process.env.VSCODE_VERSION || null, extension
    });
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'setup-error.log'),
      `${error.stack}\n${error.stdout || ''}${error.stderr || ''}`);
    writeResults(output, [...results, { name: 'install-or-package', passed: false, error: error.message }]);
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
