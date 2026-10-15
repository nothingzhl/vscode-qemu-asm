const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { localHost } = require('../dist/platform/host');
const { resolveExecutable, requireExecutable } = require('../dist/dependencies/tools');

function temporary(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool resolution '));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 return dir;
}
function executable(file, text = '#!/bin/sh\nexit 0\n') {
 fs.mkdirSync(path.dirname(file), { recursive: true });
 fs.writeFileSync(file, text, { mode: 0o755 });
 fs.chmodSync(file, 0o755);
 return file;
}
function hostWith(env) { return { ...localHost, env }; }
const posixFixture = { skip: process.platform === 'win32' };

test('actual extension host executable resolves without changing its launch path', () => {
 const resolved = requireExecutable(process.execPath, process.cwd());
 assert.equal(resolved.executable, process.execPath);
 assert.equal(resolved.host.platform, process.platform);
});

test('configured POSIX executable keeps spaces and resolves relative to the selected cwd', posixFixture, t => {
 const cwd = temporary(t);
 const file = executable(path.join(cwd, 'tools with spaces', 'compiler'));
 const resolved = requireExecutable('tools with spaces/compiler', cwd);
 assert.equal(resolved.requested, 'tools with spaces/compiler');
 assert.equal(resolved.source, 'configured');
 assert.equal(resolved.executable, file);
 assert.equal(resolved.canonicalPath, fs.realpathSync(file));
 assert.equal(resolved.host.platform, process.platform);
 assert.match(resolved.fingerprint, /^\d+:\d+:\d+:/);
 assert.equal(requireExecutable(resolved), resolved);
});

test('bare POSIX executable searches PATH in order, using cwd for relative and empty entries', posixFixture, t => {
 const cwd = temporary(t);
 const first = executable(path.join(cwd, 'first dir', 'tool'));
 const second = executable(path.join(cwd, 'second dir', 'tool'));
 const local = executable(path.join(cwd, 'tool'));
 const host = hostWith({ PATH: ['first dir', 'second dir'].join(path.delimiter) });
 assert.equal(requireExecutable('tool', cwd, host).executable, first);
 assert.equal(requireExecutable('tool', cwd, hostWith({ PATH: ['second dir', 'first dir'].join(path.delimiter) })).executable, second);
 assert.equal(requireExecutable('tool', cwd, hostWith({ PATH: ['', 'second dir'].join(path.delimiter) })).executable, local);
 // No implicit current-directory lookup ahead of the configured PATH.
 assert.equal(resolveExecutable('tool', cwd, hostWith({ PATH: path.join(cwd, 'missing') })).status, 'missing');
 assert.equal(requireExecutable('./tool', cwd, host).executable, local);
});

test('explicit POSIX paths are never replaced with a matching PATH command', posixFixture, t => {
 const cwd = temporary(t);
 executable(path.join(cwd, 'bin', 'missing'));
 const host = hostWith({ PATH: path.join(cwd, 'bin') });
 const missing = resolveExecutable('./missing', cwd, host);
 assert.equal(missing.status, 'missing');
 assert.equal(missing.source, 'configured');
 assert.equal(missing.executable, path.join(cwd, 'missing'));
 assert.throws(() => requireExecutable(missing), error => error.code === 'ENOENT' && error.path === path.join(cwd, 'missing'));
 assert.equal(resolveExecutable('missing', cwd, host).status, 'resolved');
});

test('a directory is not a tool, and missing PATH commands preserve ENOENT', t => {
 const cwd = temporary(t);
 fs.mkdirSync(path.join(cwd, 'directory.exe'));
 assert.equal(resolveExecutable('./directory.exe', cwd).status, 'not-executable');
 assert.throws(() => requireExecutable('./directory.exe', cwd), error => error.code === 'EACCES' && error.path === path.join(cwd, 'directory.exe'));
 const missing = resolveExecutable('missing-tool', cwd, hostWith({ PATH: cwd }));
 assert.equal(missing.executable, undefined);
 assert.throws(() => requireExecutable(missing), error => error.code === 'ENOENT' && error.path === 'missing-tool');
});

test('POSIX execute permissions are checked and PATH skips an inaccessible same-name file', { skip: process.platform === 'win32' }, t => {
 const cwd = temporary(t);
 const blocked = executable(path.join(cwd, 'blocked', 'tool'));
 fs.chmodSync(blocked, 0o644);
 const usable = executable(path.join(cwd, 'usable', 'tool'));
 assert.equal(resolveExecutable(blocked, cwd).status, 'not-executable');
 assert.throws(() => requireExecutable(blocked, cwd), error => error.code === 'EACCES' && error.path === blocked);
 const host = hostWith({ PATH: [path.dirname(blocked), path.dirname(usable)].join(path.delimiter) });
 assert.equal(requireExecutable('tool', cwd, host).executable, usable);
 const failure = resolveExecutable('tool', cwd, hostWith({ PATH: [path.dirname(blocked), 'absent'].join(path.delimiter) }));
 assert.equal(failure.status, 'not-executable');
 assert.equal(failure.executable, blocked);
});

test('symlink identity never changes the startup path used by a wrapper', { skip: process.platform === 'win32' }, t => {
 const cwd = temporary(t);
 const original = executable(path.join(cwd, 'original', 'wrapper'), '#!/bin/sh\nprintf "%s" "$0"\n');
 const link = path.join(cwd, 'entry with spaces');
 fs.symlinkSync(original, link);
 const resolved = requireExecutable(link, cwd);
 assert.equal(resolved.executable, link);
 assert.equal(resolved.canonicalPath, original);
 const run = spawnSync(resolved.executable, [], { cwd, encoding: 'utf8', shell: false });
 assert.equal(run.status, 0);
 assert.equal(run.stdout, link);
 fs.unlinkSync(link);
 assert.equal(resolveExecutable(link, cwd).status, 'missing');
});

test('POSIX resolver does not trim quotes, expand environment variables or use a shell', posixFixture, t => {
 const cwd = temporary(t);
 const file = executable(path.join(cwd, '$TOOL', 'binary'));
 const host = hostWith({ PATH: cwd, TOOL: 'expanded' });
 assert.equal(requireExecutable('$TOOL/binary', cwd, host).executable, file);
 assert.equal(resolveExecutable('~/binary', cwd, host).status, 'missing');
 for (const requested of ['', '   ', '"tool with spaces"', "'tool'", 'bad\0entry', 'C:tool.exe', 'C:']) {
  const rejected = resolveExecutable(requested, cwd, host);
  assert.equal(rejected.status, 'unsupported', requested);
  assert.throws(() => requireExecutable(rejected), error => error.code === 'EINVAL');
 }
 const shellText = 'tool; touch marker';
 assert.equal(resolveExecutable(shellText, cwd, host).status, 'missing');
 assert.equal(fs.existsSync(path.join(cwd, 'marker')), false);
});

test('batch files require an explicit interpreter rather than enabling shell fallback', t => {
 const cwd = temporary(t);
 for (const extension of ['.cmd', '.BAT']) {
  const file = executable(path.join(cwd, 'script' + extension));
  const result = resolveExecutable(file, cwd);
  assert.equal(result.status, 'unsupported');
  assert.match(result.message, /显式配置解释器/);
  assert.throws(() => requireExecutable(result), error => error.code === 'EINVAL' && error.path === file);
 }
});

// This is Windows path/metadata simulation only, not native Windows execution.
function windowsMetadata(t, entries, env) {
 const normalized = new Map(entries.map(([file, kind = 'file']) => [path.win32.normalize(file).toLowerCase(), kind]));
 t.mock.method(fs, 'statSync', file => {
  const kind = normalized.get(path.win32.normalize(file).toLowerCase());
  if (!kind) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return { isFile: () => kind === 'file', dev: 1, ino: 1, size: 100, mtimeMs: 1 };
 });
 t.mock.method(fs, 'accessSync', () => {});
 t.mock.method(fs, 'realpathSync', file => file);
 return { ...localHost, identity: { platform: 'win32', arch: 'x64', release: 'simulated' }, paths: path.win32, env };
}

test('Windows metadata simulation handles Path, PATHEXT, spaces, relative PATH and COM/EXE', t => {
 const host = windowsMetadata(t, [
  ['C:\\workspace\\relative tools\\qemu.COM'],
  ['C:\\Program Files\\tools\\qemu.EXE'],
  ['C:\\workspace\\tools\\nasm.EXE'],
 ], { Path: 'relative tools;C:\\Program Files\\tools', pAtHeXt: '.COM;.EXE;.BAT;.CMD' });
 const resolved = requireExecutable('qemu', 'C:\\workspace', host);
 assert.equal(resolved.executable, 'C:\\workspace\\relative tools\\qemu.COM');
 assert.equal(resolved.source, 'path');
 assert.equal(resolved.host.release, 'simulated');
 assert.equal(requireExecutable('C:\\Program Files\\tools\\qemu.exe', 'C:\\workspace', host).executable, 'C:\\Program Files\\tools\\qemu.exe');
 assert.equal(requireExecutable('tools/nasm', 'C:\\workspace', host).executable, 'C:\\workspace\\tools\\nasm.EXE');
 assert.equal(resolveExecutable('\\tools\\nasm.exe', 'C:\\workspace', host).status, 'unsupported');
 assert.equal(resolveExecutable('D:nasm.exe', 'C:\\workspace', host).status, 'unsupported');
});

test('Windows metadata simulation refuses PATHEXT scripts and unsupported entry formats', t => {
 const host = windowsMetadata(t, [
  ['C:\\tools\\build.CMD'], ['C:\\later\\build.EXE'], ['C:\\tools\\script.py'],
 ], { PATH: 'C:\\tools;C:\\later', PATHEXT: '.EXE;.CMD;.PY' });
 const batch = resolveExecutable('build', 'C:\\workspace', host);
 assert.equal(batch.status, 'unsupported');
 assert.equal(batch.executable, 'C:\\tools\\build.CMD');
 assert.match(batch.message, /显式配置解释器/);
 assert.equal(resolveExecutable('script.py', 'C:\\workspace', host).status, 'unsupported');
 assert.equal(resolveExecutable('missing', 'C:\\workspace', host).status, 'missing');
 assert.equal(resolveExecutable('build', 'C:\\workspace', { ...host, env: { Path: 'C:\\tools', PATHEXT: '' } }).status, 'unsupported');
});

test('filesystem access errors keep their code and candidate path in diagnostics', t => {
 const cwd = temporary(t);
 const file = path.join(cwd, 'blocked');
 t.mock.method(fs, 'statSync', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
 const result = resolveExecutable(file, cwd);
 assert.equal(result.status, 'not-executable');
 assert.equal(result.errorCode, 'EPERM');
 assert.throws(() => requireExecutable(result), error => error.code === 'EPERM' && error.path === file);
});
