const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProject, resolveProject, build, Processes } = require('../dist/core');
const { DebugRuntime, realModeAddress } = require('../dist/debug/runtime');

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

    // PE 位改变后必须明确拒绝源码定位，不能按旧实模式地址继续展示。
    await fs.writeFile(project.source, 'bits 16\norg 0x7c00\ncli\nmov eax,cr0\nor eax,1\nmov cr0,eax\nnop\njmp $\ntimes 510-($-$$) db 0\ndw 0xaa55\n');
    await build(project, processes, text => log.push(text));
    runtime = new DebugRuntime(project, text => log.push(text));
    await stopped(runtime, () => runtime.launch(), 'entry');
    await runtime.setBreakpoints([0x7c08]);
    await stopped(runtime, () => runtime.resume(), 'breakpoint');
    assert.equal(realModeAddress(await runtime.registers()), 0x7c08);
    await stopped(runtime, () => runtime.resume(true), 'step');
    await assert.rejects(runtime.registers(), /保护模式/);
    await assert.rejects(runtime.resume(), /保护模式/);
    await runtime.dispose();
    console.log('PASS: a real CR0.PE transition is detected and unsupported protected-mode execution is rejected');

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
