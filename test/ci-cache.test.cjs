const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { test } = require('node:test');
const { resolve, install, platformName } = require('../scripts/ci/vscode-cache.cjs');

test('fixed host versions resolve without network and isolate native platform caches', async () => {
  for (const [host, arch, platform] of [
    ['linux', 'x64', 'linux-x64'], ['darwin', 'arm64', 'darwin-arm64'],
    ['win32', 'x64', 'win32-x64-archive'], ['win32', 'arm64', 'win32-arm64-archive']
  ]) {
    const spec = await resolve('1.96.4', { os: host, arch, root: '/test host', releases: () => { throw new Error('must stay offline'); } });
    assert.equal(spec.platform, platform);
    assert.equal(path.basename(spec.directory), `vscode-${platform}-1.96.4`);
  }
  assert.throws(() => platformName('linux', 'unknown'), /Unsupported/);
});

test('stable resolves afresh and changes the cache identity when a new release appears', async () => {
  let version = '1.142.0';
  const options = { releases: async () => [version] };
  const first = await resolve('stable', options);
  version = '1.143.0';
  const second = await resolve('stable', options);
  assert.equal(first.version, '1.142.0'); assert.equal(second.version, '1.143.0');
  assert.notEqual(first.directory, second.directory);
});

test('unavailable or invalid stable metadata fails instead of silently using an older cached version', async () => {
  await assert.rejects(resolve('stable', { releases: async () => { throw new Error('offline'); } }), /offline/);
  for (const value of [[], {}, ['not-a-version'], ['1.142.0\nINJECTED=value']])
    await assert.rejects(resolve('stable', { releases: async () => value }), /Invalid/);
  for (const value of ['insiders', '1.96.4\nINJECTED=value', '../old'])
    await assert.rejects(resolve(value), /Expected/);
});

test('a complete exact-version distribution is reused by the real downloader without network', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VS Code cache, '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spec = await resolve('1.96.4', { os: 'linux', arch: 'x64', root });
  await fs.mkdir(spec.directory, { recursive: true });
  const executable = path.join(spec.directory, 'code');
  await fs.writeFile(executable, 'cache fixture; not executed');
  await fs.writeFile(path.join(spec.directory, 'is-complete'), '');
  const original = https.get;
  https.get = () => { throw new Error('cache hit attempted a network request'); };
  t.after(() => { https.get = original; });
  assert.equal(await install(spec), executable);
  assert.equal(await install(spec), executable);
});

test('cache misses pass the exact resolved version to the downloader and propagate failures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VS Code download, '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spec = await resolve('stable', { root, releases: async () => ['1.143.0'] });
  let received;
  const executable = path.join(root, 'downloaded-code');
  assert.equal(await install(spec, async options => { received = options; await fs.writeFile(executable, 'fixture'); return executable; }), executable);
  assert.equal(received.version, '1.143.0'); assert.equal(received.cachePath, spec.cachePath);
  await assert.rejects(install(spec, async () => { throw new Error('download failed'); }), /download failed/);
  await assert.rejects(install(spec, async () => path.join(root, 'missing')), /ENOENT/);
});
