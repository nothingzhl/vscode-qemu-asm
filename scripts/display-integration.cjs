const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { inflateSync } = require('node:zlib');
const { QemuScreen } = require('../dist/display/screen');

function pixels(frame) {
  const chunks = [];
  for (let offset = 8; offset < frame.png.length;) {
    const length = frame.png.readUInt32BE(offset);
    if (frame.png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(frame.png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const result = Buffer.alloc(frame.width * frame.height * 3);
  const stride = frame.width * 3;
  for (let y = 0; y < frame.height; y++) {
    assert.equal(raw[y * (stride + 1)], 0);
    raw.copy(result, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return result;
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu screen 集成 '));
  let screen; let child; let exit;
  try {
    const source = path.join(root, 'boot.asm');
    const image = path.join(root, 'boot.bin');
    await fs.writeFile(source, `bits 16
org 0x7c00
cli
xor ax,ax
mov ss,ax
mov sp,0x7c00
mov ds,ax
sti
cld
mov ax,3
int 0x10
mov si,message
print:
lodsb
test al,al
jz ready
mov ah,0x0e
mov bx,7
int 0x10
jmp print
ready:
mov al,'T'
out 0xe9,al
xor ah,ah
int 0x16
mov ax,0x13
int 0x10
mov ax,0xa000
mov es,ax
xor di,di
mov cx,32000
mov al,4
rep stosb
mov cx,32000
mov al,2
rep stosb
mov al,'G'
out 0xe9,al
idle: hlt
jmp idle
message: db 'QEMU screen integration: press Enter',0
times 510-($-$$) db 0
dw 0xaa55
`);
    const nasm = spawnSync(process.env.NASM_PATH || 'nasm', ['-f', 'bin', source, '-o', image], { encoding: 'utf8' });
    if (nasm.error) throw nasm.error;
    assert.equal(nasm.status, 0, nasm.stderr);
    screen = await QemuScreen.create();
    const statuses = [];
    screen.on('status', event => statuses.push(event));
    let output = ''; let stderr = '';
    child = spawn(process.env.QEMU_PATH || 'qemu-system-i386', ['-accel', 'tcg', '-display', 'none', '-monitor', 'none', '-serial', 'none', '-no-reboot', '-no-shutdown', '-debugcon', 'stdio', '-S', '-drive', `file=${image},format=raw,if=floppy`, ...screen.args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => output += data.toString('ascii'));
    child.stderr.on('data', data => stderr += data.toString('utf8'));
    exit = new Promise(resolve => {
      child.once('exit', resolve);
      child.once('error', error => { stderr += error.message; resolve(); });
    });
    await screen.connect();
    const initial = await screen.capture();
    assert.ok(initial.width > 0 && initial.height > 0, 'capture works before BIOS with QEMU -S');
    await screen.client.command('cont');
    await waitFor(() => output.includes('T'), 'BIOS text did not finish: ' + stderr);
    const text = await screen.capture();
    assert.ok(pixels(text).some(value => value !== 0), 'real VGA text contains visible pixels');
    assert.equal((await screen.client.command('query-status')).running, true, 'screen capture must not pause the CPU');
    await screen.sendKey('ret');
    await waitFor(() => output.includes('G'), 'QMP keyboard did not reach BIOS input: ' + stderr);
    const graphics = await screen.capture();
    const rgb = pixels(graphics);
    const palette = new Map();
    let red = 0; let green = 0;
    for (let offset = 0; offset < rgb.length; offset += 3) {
      const color = rgb.subarray(offset, offset + 3).toString('hex');
      palette.set(color, (palette.get(color) || 0) + 1);
      // Mode 13h's 6-bit VGA DAC expands palette level 42 to 168.
      if (rgb[offset] === 168 && rgb[offset + 1] === 0 && rgb[offset + 2] === 0) red++;
      if (rgb[offset] === 0 && rgb[offset + 1] === 168 && rgb[offset + 2] === 0) green++;
    }
    assert.equal(red, graphics.width * graphics.height / 2, 'mode 13h first half must be actual VGA red: ' + JSON.stringify([...palette]));
    assert.equal(green, graphics.width * graphics.height / 2, 'mode 13h second half must be actual VGA green');
    assert.equal((await screen.client.command('query-status')).running, true);
    await screen.client.command('stop');
    const stopped = await screen.capture();
    assert.deepEqual(pixels(stopped), rgb, 'paused debug screen remains readable');
    assert.equal((await screen.client.command('query-status')).running, false);
    if (process.env.DISPLAY_ARTIFACT_DIR) {
      await fs.mkdir(process.env.DISPLAY_ARTIFACT_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.DISPLAY_ARTIFACT_DIR, 'qemu-text.png'), text.png);
      await fs.writeFile(path.join(process.env.DISPLAY_ARTIFACT_DIR, 'qemu-mode13h.png'), graphics.png);
    }
    const directory = screen.directory;
    await Promise.all([screen.dispose(), screen.dispose()]);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    assert.ok(!statuses.some(status => status.state === 'error'), JSON.stringify(statuses));
    assert.equal(child.exitCode, null, 'display disposal must not kill a process owned by the runtime');
    console.log(`PASS: real QEMU -S startup, BIOS text ${text.width}x${text.height}, QMP keyboard, VGA mode 13h ${graphics.width}x${graphics.height} (${red} red + ${green} green pixels), running/paused capture and cleanup`);
  } finally {
    await screen?.dispose();
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
