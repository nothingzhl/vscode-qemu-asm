const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProject, resolveProject, build, Processes } = require('../dist/core');
const { DebugRuntime, cpuMode, instructionAddress } = require('../dist/debug/runtime');
const { parseListing } = require('../dist/debug/listing');

function stopped(runtime, action, reason) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); runtime.off('stopped', onStop); runtime.off('terminated', onEnd); };
    const onStop = event => { cleanup(); try { assert.equal(event.reason, reason); resolve(event); } catch (error) { reject(error); } };
    const onEnd = event => { cleanup(); reject(new Error(event.error || 'QEMU unexpectedly terminated')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for physical-memory integration stop')); }, 15000);
    runtime.once('stopped', onStop);
    runtime.once('terminated', onEnd);
    Promise.resolve().then(action).catch(error => { cleanup(); reject(error); });
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu physical memory '));
  const processes = new Processes();
  const log = [];
  let runtime;
  try {
    await createProject(root);
    const project = resolveProject(root, '.', {}, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH });
    const source = `bits 16
org 0x7c00
cli
xor ax,ax
mov ds,ax
lgdt [gdt_descriptor]
mov eax,cr0
or eax,1
mov cr0,eax
jmp 8:protected_entry
bits 32
protected_entry:
mov ax,16
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x90000
cld
mov edi,0x1000
xor eax,eax
mov ecx,1024
rep stosd
mov edi,0x2000
mov eax,3
mov ecx,1024
page_loop:
stosd
add eax,0x1000
loop page_loop
mov dword [0x1000],0x2003
mov dword [0x2000+3*4],0x4003
mov dword [0x3000],0x11111111
mov dword [0x4000],0x22222222
mov eax,0x1000
mov cr3,eax
mov eax,cr0
or eax,0x80000000
mov cr0,eax
ready: nop
write: mov dword [0x3000],0x33333333
after_write: nop
idle: jmp idle
align 8
gdt:
dq 0
dw 0xffff,0
db 0,0x9a,0xcf,0
dw 0xffff,0
db 0,0x92,0xcf,0
gdt_descriptor:
dw $-gdt-1
dd gdt
times 510-($-$$) db 0
dw 0xaa55
`;
    await fs.writeFile(project.source, source);
    const listingPath = path.join(root, 'boot.lst');
    await build(project, processes, text => log.push(text), undefined, listingPath);
    const map = parseListing(await fs.readFile(listingPath, 'utf8'), project.source, source);
    const address = name => {
      const entry = map.forLine(source.split('\n').findIndex(line => line.startsWith(name + ':')) + 1);
      assert.ok(entry, name); return entry.address;
    };
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([address('ready')]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    const registers = await runtime.registers();
    assert.equal(cpuMode(registers), 'protected32');
    assert.ok(registers.cr0 & 0x80000000);
    assert.equal(registers.cr3, 0x1000);
    assert.equal(await runtime.client.command('qqemu.PhyMemMode'), '0');
    const [physical, virtual, concurrentRegisters] = await Promise.all([
      runtime.readPhysicalMemory(0x3000, 513), runtime.readMemory(0x3000, 4), runtime.registers()
    ]);
    assert.equal(physical.readUInt32LE(), 0x11111111);
    assert.equal(virtual.readUInt32LE(), 0x22222222);
    assert.equal(concurrentRegisters.eip, registers.eip);
    assert.equal(await runtime.client.command('qqemu.PhyMemMode'), '0');
    console.log('PASS: actual QEMU qqemu.PhyMemMode=0, Qqemu.PhyMemMode:1/m/restore0; virtual 0x3000 maps physical 0x4000 and physical 0x3000 remains distinct');

    const physicalDuringStep = runtime.readPhysicalMemory(0x3000, 4);
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal((await physicalDuringStep).readUInt32LE(), 0x11111111);
    assert.equal(instructionAddress(await runtime.registers()), address('write'));
    await runtime.setDataBreakpoints([{ address: 0x3000, size: 4, access: 'write' }]);
    const hit = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(hit.dataAddress, 0x3000);
    assert.equal(hit.dataAccess, 'write');
    assert.equal(instructionAddress(await runtime.registers()), address('after_write'));
    assert.equal((await runtime.readMemory(0x3000, 4)).readUInt32LE(), 0x33333333);
    assert.equal((await runtime.readPhysicalMemory(0x4000, 4)).readUInt32LE(), 0x33333333);
    assert.equal((await runtime.readPhysicalMemory(0x3000, 4)).readUInt32LE(), 0x11111111);
    assert.equal(await runtime.client.command('qqemu.PhyMemMode'), '0');
    console.log('PASS: concurrent physical read precedes actual paged single-step; virtual data watchpoint reports VA and writes the expected PA without leaking memory mode');
  } catch (error) {
    if (log.length) console.error(log.join(''));
    throw error;
  } finally {
    await runtime?.dispose();
    await processes.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
