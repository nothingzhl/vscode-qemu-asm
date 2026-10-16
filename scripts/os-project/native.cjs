// Baseline: original Make build + direct QEMU/GDB, without the extension's backends.
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
async function baseline(root, tools) {
  const build = await exec('make', ['-f', 'qemu-toolkit.mk', 'toolkit-iso'], { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(build.stdout + build.stderr);
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const qemu = spawn(tools.qemu, ['-accel', 'tcg', '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
    '-nic', 'none', '-no-reboot', '-S', '-gdb', `tcp:127.0.0.1:${port}`, '-boot', 'd',
    '-drive', 'file=dreamos.iso,format=raw,media=cdrom,readonly=on'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => qemu.once('close', resolve));
  let output = '';
  qemu.stdout.on('data', chunk => { output += chunk; }); qemu.stderr.on('data', chunk => { output += chunk; });
  try {
    await new Promise((resolve, reject) => { qemu.once('spawn', resolve); qemu.once('error', reject); });
    const result = await exec(tools.gdb, ['--nx', '--quiet', '--batch', 'generated/kernel.bin',
      '-ex', 'set architecture i386', '-ex', 'set tcp auto-retry on', '-ex', 'set tcp connect-timeout 5',
      '-ex', `target remote 127.0.0.1:${port}`, '-ex', 'break main_loop', '-ex', 'continue',
      '-ex', 'printf "NATIVE_DREAMOS_MEM=%u\\n", boot_info->mem_upper', '-ex', 'detach'], { cwd: root, timeout: 30000 });
    process.stdout.write(result.stdout + result.stderr);
    assert.match(result.stdout, /Breakpoint \d+, main_loop/);
    assert(Number(/NATIVE_DREAMOS_MEM=(\d+)/.exec(result.stdout)?.[1]) > 0);
    console.log('PASS: direct Make/QEMU/GDB baseline reaches the unmodified upstream C entry with real Multiboot memory information');
  } catch (error) { error.message += `\nQEMU: ${output}`; throw error; }
  finally { qemu.kill(); await closed; }
}
module.exports = { baseline };
