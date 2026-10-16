// Developer-invoked baseline only: no tool installation, downloads or source edits.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const revision = '01dacaa51a074474a4e5491fc80addfe98956500';

async function main() {
  assert(process.env.TILCK_SOURCE, 'Set TILCK_SOURCE to the pinned, built Tilck checkout');
  const root = await fs.realpath(process.env.TILCK_SOURCE);
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  assert.equal(stdout.trim(), revision, 'use the assessed Tilck revision');
  const kernel = path.join(root, 'build/tilck');
  const symbols = path.join(root, 'build/tilck_unstripped');
  const initrd = path.join(root, 'build/fatpart');
  for (const file of [kernel, symbols, initrd]) assert((await fs.stat(file)).size > 0, file);
  const elf = await fs.readFile(symbols);
  assert.deepEqual([...elf.subarray(0, 5)], [0x7f, 0x45, 0x4c, 0x46, 1], 'require ELF32');
  assert.equal(elf.readUInt16LE(18), 3, 'require i386 symbols');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const qemu = spawn(process.env.QEMU_PATH || 'qemu-system-i386', [
    '-accel', 'tcg', '-m', '128', '-display', 'none', '-monitor', 'none',
    '-serial', 'none', '-nic', 'none', '-no-reboot', '-S', '-gdb', `tcp:127.0.0.1:${port}`,
    '-kernel', kernel, '-initrd', initrd
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => qemu.once('close', resolve));
  let output = '';
  for (const stream of [qemu.stdout, qemu.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-65536); });
  try {
    await new Promise((resolve, reject) => { qemu.once('spawn', resolve); qemu.once('error', reject); });
    // The assessment build runs in /work inside a container. Map its DWARF
    // source prefix explicitly; do not change kernel link/load addresses.
    const commands = [
      `set substitute-path /work "${root.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
      'set architecture i386', 'set tcp auto-retry on', 'set tcp connect-timeout 5',
      `target remote 127.0.0.1:${port}`, 'hbreak kmain', 'continue',
      'printf "TILCK_MAGIC=%#x\\n", multiboot_magic',
      'printf "TILCK_PC=%#x\\n", $pc', 'monitor info registers',
      'bt', 'next', 'step', 'bt', 'finish', 'bt', 'detach'
    ];
    const result = await exec(process.env.GDB_PATH || 'gdb', [
      '--nx', '--quiet', '--batch', '-iex', 'set auto-load off', symbols,
      ...commands.flatMap(command => ['-ex', command])
    ], { cwd: root, timeout: 60000, maxBuffer: 1024 * 1024 });
    const transcript = result.stdout + result.stderr;
    process.stdout.write(transcript);
    assert.match(transcript, /TILCK_MAGIC=0x2badb002/);
    const pc = Number(/TILCK_PC=(0x[\da-f]+)/i.exec(transcript)?.[1]);
    const control = /\bCR0=([\da-f]+)/i.exec(transcript);
    assert(control, 'QEMU must report a real CR0 value');
    const cr0 = Number.parseInt(control[1], 16);
    assert(pc >= 0xc0000000, 'C entry must execute at its upstream high virtual address');
    assert((cr0 >>> 31) === 1, 'paging must already be enabled at the C entry');
    assert.match(result.stdout, /kernel\/main\.c/);
    assert.match(result.stdout, /^#0\s+call_kernel_global_ctors\b/m, 'source step must enter the real initializer');
    console.log('PASS: native Tilck ELF32/Multiboot, high virtual C entry, paging and source stepping');
  } catch (error) { error.message += `\nQEMU: ${output}`; throw error; }
  finally {
    qemu.kill();
    const deadline = setTimeout(() => qemu.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(deadline); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
