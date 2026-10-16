const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProject, resolveProject, build, Processes } = require('../dist/core');
const { DebugRuntime, realModeAddress, cpuMode, instructionAddress, stackAddress, stackWidth } = require('../dist/debug/runtime');

function stopped(runtime, action, reason) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); runtime.off('stopped', onStop); runtime.off('terminated', onEnd); };
    const onStop = event => { cleanup(); try { if (reason) assert.equal(event.reason, reason); resolve(event); } catch (error) { reject(error); } };
    const onEnd = event => { cleanup(); reject(new Error(event.error || 'QEMU unexpectedly terminated')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for QEMU stop')); }, 15000);
    runtime.once('stopped', onStop);
    runtime.once('terminated', onEnd);
    Promise.resolve().then(action).catch(error => { cleanup(); reject(error); });
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qemu debug 集成 '));
  const processes = new Processes();
  let runtime;
  const log = [];
  try {
    await createProject(root);
    await fs.writeFile(path.join(root, 'boot.asm'), 'bits 16\norg 0x7c00\ncli\nxor ax,ax\nmov ds,ax\nmov ss,ax\nmov sp,0x7c00\nmov ax,0x1234\npush ax\nmov bx,0x5678\npop cx\nidle: jmp idle\ntimes 510-($-$$) db 0\ndw 0xaa55\n');
    const project = resolveProject(root, '.', {}, { nasm: process.env.NASM_PATH, qemu: process.env.QEMU_PATH });
    await build(project, processes, text => log.push(text));
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x7c00, 0x7c0e]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal(realModeAddress(await runtime.registers()), 0x7c00);
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal(realModeAddress(await runtime.registers()), 0x7c01);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    let registers = await runtime.registers();
    assert.equal(realModeAddress(registers), 0x7c0e);
    assert.equal(registers.eax & 0xffff, 0x1234);
    assert.equal(registers.esp & 0xffff, 0x7bfe);
    assert.equal((await runtime.readMemory(0x7bfe, 2)).toString('hex'), '3412');
    await runtime.setBreakpoints([0x7c00, 0x7c0e, 0x7c11]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    registers = await runtime.registers();
    assert.equal(realModeAddress(registers), 0x7c11, 'Continue must advance past the current hardware breakpoint');
    assert.equal(registers.ebx & 0xffff, 0x5678);
    await stopped(runtime, () => runtime.resume(true), 'step');
    registers = await runtime.registers();
    assert.equal(registers.ecx & 0xffff, 0x1234);
    assert.equal(registers.esp & 0xffff, 0x7c00);
    await runtime.setBreakpoints([]);
    await runtime.resume();
    await stopped(runtime, () => runtime.pause(), 'pause');
    await runtime.dispose();
    console.log('PASS: real QEMU hardware breakpoints, single-step, registers, stack memory, pause and cleanup');

    // A different CS:IP pair must still map to the same real boot-source address.
    await fs.writeFile(project.source, 'bits 16\norg 0x7c00\njmp 0x07c0:(relocated - $$)\nrelocated:\nmov ax,0x2255\njmp $\ntimes 510-($-$$) db 0\ndw 0xaa55\n');
    await build(project, processes, text => log.push(text));
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x7c05]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    registers = await runtime.registers();
    assert.equal(registers.cs, 0x07c0);
    assert.equal(registers.eip, 5);
    assert.equal(realModeAddress(registers), 0x7c05);
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal((await runtime.registers()).eax & 0xffff, 0x2255);
    await runtime.dispose();
    console.log('PASS: real far jump CS:IP=07c0:0005 maps to physical source address 0x7c05');

    // CS 缓存以远跳转为界切换指令宽度，SS 缓存则在 mov ss 后独立切换。
    // 特意使用 base=0x7000 的代码段及 >1MiB 的栈，避免把 selector<<4 或 SP 截断误当作地址。
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
nop
jmp dword 8:(protected_entry-0x7000)
bits 32
protected_entry:
mov ax,0x10
mov ds,ax
mov es,ax
mov ss,ax
mov esp,0x180000
mov eax,0x12345678
push eax
mov ebx,0x87654321
pop ecx
idle: jmp idle
align 8
gdt: dq 0
dw 0xffff,0x7000
db 0,0x9a,0xcf,0
dw 0xffff,0
db 0,0x92,0xcf,0
gdt_desc: dw $-gdt-1
dd gdt
times 510-($-$$) db 0
dw 0xaa55
`;
    await fs.writeFile(project.source, protectedSource);
    await build(project, processes, text => log.push(text));
    const protectedImage = await fs.readFile(project.image);
    const peWrite = protectedImage.indexOf(Buffer.from('0f22c0', 'hex'));
    const protectedEntry = protectedImage.indexOf(Buffer.from('66b810008ed88ec08ed0', 'hex'));
    const afterPush = protectedImage.indexOf(Buffer.from('bb2143658759', 'hex'));
    assert.ok(peWrite > 0 && protectedEntry > peWrite && afterPush > protectedEntry);
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x7c00 + peWrite, 0x7c00 + peWrite + 3, 0x7c00 + protectedEntry, 0x7c00 + afterPush, 0x7c00 + afterPush + 5]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal(cpuMode(await runtime.registers()), 'real16');
    await stopped(runtime, () => runtime.resume(true), 'step');
    registers = await runtime.registers();
    assert.equal(cpuMode(registers), 'protected16');
    assert.equal(instructionAddress(registers), 0x7c00 + peWrite + 3);
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal(cpuMode(await runtime.registers()), 'protected16');
    await stopped(runtime, () => runtime.resume(true), 'step');
    registers = await runtime.registers();
    assert.equal(cpuMode(registers), 'protected32');
    assert.equal(registers.cs, 8);
    assert.equal(registers.cs_base, 0x7000);
    assert.equal(registers.eip, 0x7c00 + protectedEntry - 0x7000);
    assert.equal(instructionAddress(registers), 0x7c00 + protectedEntry);
    assert.equal(stackWidth(registers), 2, 'SS must retain its old 16-bit cache until loaded');
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    registers = await runtime.registers();
    assert.equal(instructionAddress(registers), 0x7c00 + afterPush);
    assert.equal(stackWidth(registers), 4);
    assert.equal(stackAddress(registers), 0x17fffc);
    assert.equal((await runtime.readMemory(stackAddress(registers), 4)).toString('hex'), '78563412');
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    registers = await runtime.registers();
    assert.equal(instructionAddress(registers), 0x7c00 + afterPush + 5, '32-bit continue must advance beyond the current hardware breakpoint');
    assert.equal(registers.ebx, 0x87654321);
    await stopped(runtime, () => runtime.resume(true), 'step');
    registers = await runtime.registers();
    assert.equal(registers.ecx, 0x12345678);
    assert.equal(registers.esp, 0x180000);
    await runtime.setBreakpoints([]);
    await runtime.resume();
    await stopped(runtime, () => runtime.pause(), 'pause');
    await runtime.dispose();
    console.log('PASS: real CR0.PE transition16, far jump with nonzero CS.base, 32-bit hardware continue, >1MiB stack push/pop and pause');

    // D=0 的代码段可通过 32 位 far jump 在 EIP>0xffff 执行；默认指令宽度不等于地址上限。
    await fs.writeFile(project.source, `bits 16
org 0x7c00
cli
xor ax,ax
mov ds,ax
mov ss,ax
mov sp,0x7c00
cld
mov ax,0x1000
mov es,ax
mov si,payload
mov di,0x20
mov cx,payload_end-payload
rep movsb
lgdt [gdt_desc]
mov eax,cr0
or eax,1
mov cr0,eax
jmp dword 8:0x10020
payload:
jmp near dword high_next
high_next:
jmp near dword high_idle
high_idle:
jmp near dword high_idle
payload_end:
align 8
gdt: dq 0
dw 0xffff,0
db 0,0x9a,0x8f,0
gdt_desc: dw $-gdt-1
dd gdt
times 510-($-$$) db 0
dw 0xaa55
`);
    await build(project, processes, text => log.push(text));
    // NASM 3 can shorten an unqualified dword jump; this case requires rel32
    // branches to retain full EIP above 64KiB and the exact six-byte offsets.
    const highImage = await fs.readFile(project.image);
    assert.notEqual(highImage.indexOf(Buffer.from('66e90000000066e90000000066e9faffffff', 'hex')), -1,
      'Protected16 payload must contain three six-byte operand32 near jumps');
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x10020, 0x10026]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    registers = await runtime.registers();
    assert.equal(cpuMode(registers), 'protected16');
    assert.equal(registers.cs_base, 0);
    assert.equal(registers.cs_limit, 0xffffffff);
    assert.equal(registers.eip, 0x10020);
    assert.equal(instructionAddress(registers), 0x10020);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    registers = await runtime.registers();
    assert.equal(instructionAddress(registers), 0x10026, 'D=0 hardware continue must use full EIP above 64KiB');
    await stopped(runtime, () => runtime.resume(true), 'step');
    registers = await runtime.registers();
    assert.equal(instructionAddress(registers), 0x1002c);
    await runtime.setBreakpoints([]);
    await runtime.resume();
    await stopped(runtime, () => runtime.pause(), 'pause');
    assert.equal(instructionAddress(await runtime.registers()), 0x1002c);
    await runtime.dispose();
    console.log('PASS: real protected16 CS.D=0 with large limit and 32-bit far jump retains EIP>64KiB for continue, step and pause');

    // 实际 legacy page table：打开 PG 后仍可读取、单步，不能退回旧版拒绝所有分页的行为。
    const pagingSetup = `cld
mov edi,0x2000
mov eax,3
mov ecx,1024
page_loop:
stosd
add eax,0x1000
loop page_loop
mov dword [0x1000],0x2003
mov eax,0x1000
mov cr3,eax
mov eax,cr0
or eax,0x80000000
mov cr0,eax
nop
`;
    await fs.writeFile(project.source, protectedSource.replace('mov eax,0x12345678\npush eax', `${pagingSetup}mov eax,0x12345678\npush eax`));
    await build(project, processes, text => log.push(text));
    const pagingImage = await fs.readFile(project.image);
    const pagingWrite = pagingImage.indexOf(Buffer.from('0f22c0', 'hex'), peWrite + 3);
    assert.ok(pagingWrite > peWrite);
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x7c00 + pagingWrite]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal(cpuMode(await runtime.registers()), 'protected32');
    await stopped(runtime, () => runtime.resume(true), 'step');
    assert.equal(cpuMode(await runtime.registers()), 'protected32');
    assert.deepEqual(await runtime.readMemory(0x7c00, 2), pagingImage.subarray(0, 2));
    await stopped(runtime, () => runtime.resume(true), 'step');
    await runtime.dispose();
    console.log('PASS: real CR0.PG transition with valid identity legacy paging preserves register reads, virtual memory reads and single stepping');

    // PAE 是另一种页表格式：用有效的 2MiB PAE 映射测试明确拒绝，不能靠页故障伪造边界。
    const paeSetup = `mov dword [0x1000],0x2001
mov dword [0x1004],0
mov dword [0x2000],0x83
mov dword [0x2004],0
mov eax,cr4
or eax,0x30
mov cr4,eax
mov eax,0x1000
mov cr3,eax
mov eax,cr0
or eax,0x80000000
mov cr0,eax
nop
`;
    await fs.writeFile(project.source, protectedSource.replace('mov eax,0x12345678\npush eax', `${paeSetup}mov eax,0x12345678\npush eax`));
    await build(project, processes, text => log.push(text));
    const paeImage = await fs.readFile(project.image);
    const paeWrite = paeImage.indexOf(Buffer.from('0f22c0', 'hex'), peWrite + 3);
    assert.ok(paeWrite > peWrite);
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x7c00 + paeWrite]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal(cpuMode(await runtime.registers()), 'protected32');
    await stopped(runtime, () => runtime.resume(true), 'step');
    await assert.rejects(runtime.registers(), /PAE/i);
    await assert.rejects(runtime.resume(), /PAE/i);
    await runtime.dispose();
    console.log('PASS: real CR0.PG with valid PAE 2MiB mappings is rejected explicitly as unsupported PAE');

    await fs.writeFile(project.source, 'bits 16\norg 0x7c00\ncli\nlgdt [gdt_desc]\nmov eax,cr0\nor eax,1\nmov cr0,eax\nmov ax,8\nmov ds,ax\nmov eax,cr0\nand eax,0xfffffffe\nmov cr0,eax\nnop\njmp $\ngdt: dq 0\ndw 0xffff,0\ndb 0,0x92,0xcf,0\ngdt_desc: dw $-gdt-1\ndd gdt\ntimes 510-($-$$) db 0\ndw 0xaa55\n');
    await build(project, processes, text => log.push(text));
    const unrealImage = await fs.readFile(project.image);
    const writeCR0 = Buffer.from([0x0f, 0x22, 0xc0]);
    const clearPE = unrealImage.indexOf(writeCR0, unrealImage.indexOf(writeCR0) + writeCR0.length);
    assert.ok(clearPE > 0);
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x7c00 + clearPE + writeCR0.length]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    await assert.rejects(runtime.registers(), /unreal\/big-real/);
    await runtime.dispose();
    console.log('PASS: a real unreal-mode DS cache is rejected after CR0.PE has been cleared');

    runtime = new DebugRuntime({ ...project, qemu: path.join(root, 'missing qemu executable') }, text => log.push(text));
    let terminations = 0;
    runtime.on('terminated', () => terminations++);
    await assert.rejects(runtime.launch(), /ENOENT/);
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    assert.equal(terminations, 1);
    console.log('PASS: launch failure reports the error, terminates once and supports repeated cleanup');
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
