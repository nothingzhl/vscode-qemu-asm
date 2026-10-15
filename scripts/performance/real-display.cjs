const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { QemuScreen } = require('../../dist/display/screen');
const { measure, report, writeReport } = require('./measure.cjs');

async function guestUsage(pid) {
  if (process.platform !== 'linux') return { available: false };
  const [status, stat] = await Promise.all([
    fs.readFile(`/proc/${pid}/status`, 'utf8'), fs.readFile(`/proc/${pid}/stat`, 'utf8')
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // Linux exposes ticks, not microseconds; keep the unit instead of guessing CLK_TCK.
  return {
    available: true, pid, residentBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
    userCpuTicks: Number(fields[11]), systemCpuTicks: Number(fields[12])
  };
}

async function waitReady(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'QEMU guest did not reach its static display');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--enforce')) assert.equal(typeof global.gc, 'function', 'Run with node --expose-gc');
  const filename = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu performance '));
  let screen, child, exited;
  try {
    const source = path.join(directory, 'screen.asm'), image = path.join(directory, 'screen.bin');
    await fs.writeFile(source, `bits 16
org 0x7c00
mov ax,3
int 0x10
mov ax,0xb800
mov es,ax
xor di,di
mov ax,0x1f50
mov cx,2000
rep stosw
mov al,'R'
out 0xe9,al
cli
idle: hlt
jmp idle
times 510-($-$$) db 0
dw 0xaa55
`);
    const nasm = spawnSync(process.env.NASM_PATH || 'nasm', ['-f', 'bin', source, '-o', image], { encoding: 'utf8' });
    if (nasm.error) throw nasm.error;
    assert.equal(nasm.status, 0, nasm.stderr);
    screen = await QemuScreen.create();
    let ready = false, errorText = '';
    child = spawn(process.env.QEMU_PATH || 'qemu-system-i386', [
      '-accel', 'tcg', '-display', 'none', '-monitor', 'none', '-serial', 'none',
      '-no-reboot', '-no-shutdown', '-debugcon', 'stdio',
      '-drive', `file=${image},format=raw,if=floppy`, ...screen.args
    ], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', data => { ready ||= data.includes(82); });
    child.stderr.on('data', data => { errorText = (errorText + data.toString()).slice(-4096); });
    exited = new Promise(resolve => {
      child.once('exit', resolve);
      child.once('error', error => { errorText = error.message; resolve(); });
    });
    await waitReady(() => { if (child.exitCode !== null) throw new Error(errorText); return ready; });
    await screen.connect();
    const guestBefore = await guestUsage(child.pid);
    let last, uniqueFrames = 0;
    const scenario = await measure('real-qemu-static-capture', 75, async () => {
      const frame = await screen.capture();
      assert.ok(frame.width > 0 && frame.height > 0);
      if (last !== frame.png) uniqueFrames++;
      last = frame.png;
    });
    const guestAfter = await guestUsage(child.pid);
    const budget = { msPerOperation: 300, retainedHeapBytes: 20 * 1024 * 1024, retainedArrayBufferBytes: 20 * 1024 * 1024 };
    await writeReport(report([{ ...scenario, uniqueFrames }], {
      budget, qemu: { before: guestBefore, after: guestAfter },
      tools: Object.fromEntries([['qemu', process.env.QEMU_PATH || 'qemu-system-i386'],
        ['nasm', process.env.NASM_PATH || 'nasm']].map(([name, executable]) => {
        const probe = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 });
        return [name, { executable, version: probe.stdout?.split(/\r?\n/)[0] || 'unreported' }];
      })),
      notes: ['CPU and memory in each scenario belong to Node, not QEMU.',
        'QEMU memory and Linux CPU ticks are reported separately; guest allocation is not extension heap.']
    }), filename);
    if (args.includes('--enforce')) {
      assert.ok(scenario.msPerOperation < budget.msPerOperation, 'display latency exceeded conservative budget');
      assert.ok(scenario.retainedHeapBytes < budget.retainedHeapBytes, 'display retained excessive heap');
      assert.ok(scenario.retainedArrayBufferBytes < budget.retainedArrayBufferBytes, 'display retained excessive buffers');
    }
    const files = screen.directory;
    await screen.dispose();
    await assert.rejects(fs.stat(files), { code: 'ENOENT' });
    assert.equal(child.exitCode, null, 'display disposal must leave the VM to its owner');
  } finally {
    await screen?.dispose();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let timeout;
      await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
