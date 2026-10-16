// CI-only: resolve moving aliases before constructing an exact executable cache key.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const release = /^\d+\.\d+\.\d+$/;
function platformName(os, arch) {
  const platforms = {
    'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64',
    'darwin-x64': 'darwin', 'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win32-x64-archive', 'win32-arm64': 'win32-arm64-archive'
  };
  const value = platforms[`${os}-${arch}`];
  if (!value) throw new Error(`Unsupported VS Code test host: ${os}/${arch}`);
  return value;
}
async function stableReleases() {
  const { stdout } = await exec(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    '--fail', '--silent', '--show-error', '--location', '--retry', '3', '--retry-all-errors',
    '--connect-timeout', '15', '--max-time', '60',
    'https://update.code.visualstudio.com/api/releases/stable?released=true'
  ], { maxBuffer: 1024 * 1024, timeout: 260000 });
  return JSON.parse(stdout);
}
async function resolve(requested, {
  os = process.platform, arch = process.arch, root = process.cwd(), releases = stableReleases
} = {}) {
  let version = requested;
  if (requested === 'stable') {
    const versions = await releases();
    if (!Array.isArray(versions) || !release.test(versions[0])) throw new Error('Invalid stable release response');
    version = versions[0];
  }
  if (!release.test(version)) throw new Error('Expected stable or a fixed VS Code x.y.z version');
  const platform = platformName(os, arch);
  const cachePath = path.resolve(root, '.vscode-test');
  return { version, platform, cachePath, directory: path.join(cachePath, `vscode-${platform}-${version}`) };
}
async function install(spec, download = require('@vscode/test-electron').downloadAndUnzipVSCode) {
  // Exact versions prevent the library's offline "latest locally available" fallback.
  const executable = await download({ version: spec.version, platform: spec.platform, cachePath: spec.cachePath, timeout: 30000 });
  if (!(await fs.stat(executable)).isFile()) throw new Error('VS Code executable missing after preparation');
  return executable;
}
async function main() {
  const [mode, requested] = process.argv.slice(2);
  const spec = await resolve(requested);
  if (mode === 'resolve') {
    const values = { version: spec.version, platform: spec.platform, directory: spec.directory,
      downloader: require('@vscode/test-electron/package.json').version };
    if (process.env.GITHUB_OUTPUT)
      await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`VS Code ${requested} -> ${spec.version} (${spec.platform})`);
  } else if (mode === 'install') {
    const executable = await install(spec);
    if (process.env.GITHUB_ENV)
      await fs.appendFile(process.env.GITHUB_ENV, `VSCODE_VERSION=${spec.version}\nVSCODE_EXECUTABLE_PATH=${executable}\n`);
    console.log(`VS Code ${spec.version}: ${executable}`);
  } else throw new Error('Usage: vscode-cache.cjs resolve|install stable|VERSION');
}
module.exports = { resolve, install, platformName };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
