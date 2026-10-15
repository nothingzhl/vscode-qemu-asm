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
    const onStop = event => { cleanup(); try { if (reason) assert.equal(event.reason, reason); resolve(event); } catch (error) { reject(error); } };
    const onEnd = event => { cleanup(); reject(new Error(event.error || 'QEMU unexpectedly terminated')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for QEMU data breakpoint')); }, 15000);
    runtime.once('stopped', onStop);
    runtime.once('terminated', onEnd);
    Promise.resolve().then(action).catch(error => { cleanup(); reject(error); });
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu 数据断点 '));
  const processes = new Processes();
  let runtime;
  const log = [];
  try {
    await createProject(root);
    const source = `bits 16
org 0x7c00
cli
xor ax,ax
mov ds,ax
mov ss,ax
mov sp,0x7c00
ready: nop
write8: mov byte [0x9001],0x11
read8: mov al,[0x9001]
write16: mov word [0x9003],0x2233
read16: mov bx,[0x9003]
write32: mov dword [0x9007],0x44556677
read32: mov ecx,[0x9007]
access8: inc byte [0x9001]
removed8: inc byte [0x9001]
tail: mov dx,0x5a5a
overlapWrite: mov word [0x9010],0xabcd
overlapRead: mov ax,[0x9010]
mov cx,3
steppedWrite: mov byte [0x9012],0x5a
loopBack: loop loopBack
idle: jmp idle
times 510-($-$$) db 0
dw 0xaa55
`;
    const project = resolveProject(root, '.', {}, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH });
    await fs.writeFile(project.source, source);
    const listingPath = path.join(root, 'boot.lst');
    await build(project, processes, text => log.push(text), undefined, listingPath);
    const map = parseListing(await fs.readFile(listingPath, 'utf8'), project.source, source);
    const address = label => {
      const entry = map.forLine(source.split('\n').findIndex(line => line.startsWith(`${label}:`)) + 1);
      assert.ok(entry, label); return entry.address;
    };
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([address('write8')]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    await runtime.setDataBreakpoints([{ address: 0x9001, size: 1, access: 'write' }]);
    const event = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(event.dataAddress, 0x9001);
    assert.equal(event.dataAccess, 'write');
    assert.equal(instructionAddress(await runtime.registers()), address('read8'), 'QEMU watch stop occurs after the access instruction');
    await runtime.setBreakpoints([address('read8')]);
    assert.equal(instructionAddress(await runtime.registers()), address('read8'));
    assert.equal((await runtime.readMemory(0x9001, 1))[0], 0x11);
    await runtime.setDataBreakpoints([{ address: 0x9001, size: 1, access: 'read' }]);
    const read = await stopped(runtime, () => runtime.resume(true), 'data breakpoint');
    assert.equal(read.dataAddress, 0x9001);
    assert.equal(read.dataAccess, 'read');
    assert.equal(instructionAddress(await runtime.registers()), address('write16'));
    assert.equal((await runtime.registers()).eax & 0xff, 0x11);
    await runtime.setBreakpoints([address('write16')]);
    await runtime.setDataBreakpoints([{ address: 0x9003, size: 2, access: 'readWrite' }]);
    const access = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(access.dataAddress, 0x9003);
    assert.equal(access.dataAccess, 'readWrite');
    assert.equal(instructionAddress(await runtime.registers()), address('read16'));
    assert.equal((await runtime.readMemory(0x9003, 2)).readUInt16LE(), 0x2233);
    const accessRead = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(accessRead.dataAccess, 'readWrite', 'awatch identifies the configured read/write class, not whether this individual access was a read');
    assert.equal((await runtime.registers()).ebx & 0xffff, 0x2233);
    assert.equal(instructionAddress(await runtime.registers()), address('write32'));
    await runtime.setDataBreakpoints([{ address: 0x9007, size: 4, access: 'write' }]);
    const write32 = await stopped(runtime, () => runtime.resume(true), 'data breakpoint');
    assert.equal(write32.dataAddress, 0x9007);
    assert.equal(write32.dataAccess, 'write');
    assert.equal((await runtime.readMemory(0x9007, 4)).readUInt32LE(), 0x44556677);
    assert.equal(instructionAddress(await runtime.registers()), address('read32'));
    await runtime.setDataBreakpoints([{ address: 0x9007, size: 4, access: 'read' }]);
    const read32 = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(read32.dataAddress, 0x9007);
    assert.equal(read32.dataAccess, 'read');
    assert.equal((await runtime.registers()).ecx, 0x44556677);
    assert.equal(instructionAddress(await runtime.registers()), address('access8'));
    await runtime.setDataBreakpoints([{ address: 0x9001, size: 1, access: 'readWrite' }]);
    const rmw = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(rmw.dataAddress, 0x9001);
    assert.equal(rmw.dataAccess, 'readWrite');
    assert.equal((await runtime.readMemory(0x9001, 1))[0], 0x12);
    assert.equal(instructionAddress(await runtime.registers()), address('removed8'));
    await runtime.setDataBreakpoints([]);
    await runtime.setBreakpoints([address('tail')]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal(instructionAddress(await runtime.registers()), address('tail'));
    assert.equal((await runtime.readMemory(0x9001, 1))[0], 0x13, 'removed data watchpoint must not stop the next access');
    await runtime.setBreakpoints([]);
    await runtime.setDataBreakpoints([{ address: 0x9011, size: 1, access: 'write' }]);
    const overlapWrite = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(overlapWrite.dataAddress, 0x9011, 'QEMU reports configured watchpoint start even when the write starts before the watched range');
    await runtime.setDataBreakpoints([{ address: 0x9011, size: 1, access: 'read' }]);
    const overlapRead = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(overlapRead.dataAddress, 0x9011, 'overlapping reads also report the configured watchpoint start');
    assert.equal((await runtime.registers()).eax & 0xffff, 0xabcd);
    await runtime.setBreakpoints([address('steppedWrite')]);
    await runtime.setDataBreakpoints([{ address: 0x9012, size: 1, access: 'write' }]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal((await runtime.registers()).ecx & 0xffff, 3);
    await stopped(runtime, () => runtime.resume(true), 'data breakpoint');
    assert.equal(instructionAddress(await runtime.registers()), address('loopBack'));
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal((await runtime.registers()).ecx & 0xffff, 2, 'pending watch step-trap must not execute LOOP twice');
    assert.equal(instructionAddress(await runtime.registers()), address('loopBack'));
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal((await runtime.registers()).ecx & 0xffff, 1, 'a real self-PC LOOP step remains visible');
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal((await runtime.registers()).ecx & 0xffff, 0);
    assert.equal(instructionAddress(await runtime.registers()), address('idle'));
    await runtime.setBreakpoints([]);
    await runtime.setDataBreakpoints([]);
    await runtime.resume();
    await stopped(runtime, () => runtime.pause(), 'pause');
    assert.equal((await runtime.registers()).edx & 0xffff, 0x5a5a);
    await runtime.dispose();
    console.log('PASS: real TCG Z2/Z3/Z4, unaligned 1/2/4-byte accesses, overlap-report address, read-modify-write, source step-off, watch trap drain, exactly-once LOOP steps, removal, continue and pause');

    const protectedSource = `bits 16
org 0x7c00
cli
xor ax,ax
mov ds,ax
mov ss,ax
mov sp,0x7c00
lgdt [gdt_desc]
mov eax,cr0
or eax,1
mov cr0,eax
jmp dword 8:protected_entry
bits 32
protected_entry:
mov ax,0x10
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x90000
writeHigh: mov dword [0x190003],0x12345678
readHigh: mov eax,[0x190003]
removedHigh: mov dword [0x190003],0x87654321
idleHigh: jmp idleHigh
align 8
gdt: dq 0
dq 0x00cf9a000000ffff
dq 0x00cf92000000ffff
gdt_desc: dw $-gdt-1
dd gdt
times 510-($-$$) db 0
dw 0xaa55
`;
    await fs.writeFile(project.source, protectedSource);
    await build(project, processes, text => log.push(text), undefined, listingPath);
    const protectedMap = parseListing(await fs.readFile(listingPath, 'utf8'), project.source, protectedSource);
    const protectedAddress = label => {
      const entry = protectedMap.forLine(protectedSource.split('\n').findIndex(line => line.startsWith(`${label}:`)) + 1);
      assert.ok(entry, label); return entry.address;
    };
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([protectedAddress('writeHigh')]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal(cpuMode(await runtime.registers()), 'protected32');
    await runtime.setDataBreakpoints([{ address: 0x190003, size: 4, access: 'readWrite' }]);
    const highWrite = await stopped(runtime, () => runtime.resume(), 'data breakpoint');
    assert.equal(highWrite.dataAddress, 0x190003);
    assert.equal(instructionAddress(await runtime.registers()), protectedAddress('readHigh'));
    assert.equal((await runtime.readMemory(0x190003, 4)).readUInt32LE(), 0x12345678);
    const highRead = await stopped(runtime, () => runtime.resume(true), 'data breakpoint');
    assert.equal(highRead.dataAddress, 0x190003);
    assert.equal((await runtime.registers()).eax, 0x12345678);
    await runtime.setDataBreakpoints([]);
    await runtime.setBreakpoints([protectedAddress('idleHigh')]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal((await runtime.readMemory(0x190003, 4)).readUInt32LE(), 0x87654321);
    await runtime.setBreakpoints([]);
    await runtime.resume();
    await stopped(runtime, () => runtime.pause(), 'pause');
    await runtime.dispose();
    console.log('PASS: real protected32 unaligned dword watchpoint above 1MiB, internal source-step stop, read-step priority, replacement, removal, pause and owned-process cleanup');
  } catch (error) { console.error(log.join('')); throw error; }
  finally { await runtime?.dispose(); await processes.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
