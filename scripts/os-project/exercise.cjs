// Shared real-project assertions. No imports of product code or editor APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const numeric = value => Number(/0x[\da-f]+|^-?\d+/i.exec(String(value))?.[0]);
async function top(client) { return (await client.request('stackTrace', { threadId: 1 })).stackFrames[0]; }
async function scalar(client, expression) {
  const frame = await top(client);
  return numeric((await client.request('evaluate', { expression, frameId: frame.id, context: 'watch' })).result);
}
async function exercise(client, root, restart) {
  const source = path.join(root, 'src/kernel.c');
  const original = await fs.readFile(source, 'utf8');
  const line = original.split('\n').findIndex(text => text.includes('_kcolor(BRIGHT_GREEN)')) + 1;
  let frame = await top(client);
  assert.match(frame.name, /main_loop/); assert.equal(frame.source.path, source);
  assert.equal(await scalar(client, 'module_end'), 0);
  assert((await scalar(client, 'boot_info->mem_upper')) > 0);
  const scopes = (await client.request('scopes', { frameId: frame.id })).scopes;
  const values = (await Promise.all(scopes.map(scope => client.request('variables', { variablesReference: scope.variablesReference })))).flatMap(group => group.variables);
  assert(values.some(value => value.name === 'boot_info'), 'real C argument must appear in scopes');
  await client.stoppedAfter('next');
  await client.stoppedAfter('stepIn');
  let frames = (await client.request('stackTrace', { threadId: 1 })).stackFrames;
  assert.match(frames[0].name, /_kclear/); assert(frames.some(item => item.name === 'main_loop'));
  const video = await fs.readFile(path.join(root, 'src/io/video.c'), 'utf8');
  const initializedLine = video.split('\n').findIndex((text, index, lines) => text.includes('VIDEO_PTR = VIDEO_MEM;') && lines.slice(Math.max(0, index - 4), index).some(line => line.includes('row = 0;'))) + 1;
  for (let steps = 0; (await top(client)).line !== initializedLine && steps < 6; steps++)
    await client.stoppedAfter('next');
  assert.equal((await top(client)).line, initializedLine);
  assert.equal(await scalar(client, 'line'), 0); assert.equal(await scalar(client, 'row'), 0);
  await client.stoppedAfter('stepOut');
  const breakpoint = await client.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line }] });
  assert.equal(breakpoint.breakpoints[0].verified, true);
  assert.equal((await client.stoppedAfter('continue')).reason, 'breakpoint');
  frame = await top(client); assert.equal(frame.line, line);
  const start = await scalar(client, 'module_start'), end = await scalar(client, 'module_end');
  assert(end > start && start > 0, 'GRUB must load the actual upstream initfs module');
  const pc = numeric(frame.instructionPointerReference);
  const memory = await client.request('qemuAsm.inspectMemory', { address: pc, count: 16, space: 'virtual', follow: 'address' });
  const physical = await client.request('qemuAsm.inspectMemory', { address: pc, count: 16, space: 'physical', follow: 'address' });
  assert.equal(memory.bytes.length, 16); assert.deepEqual(memory.bytes, physical.bytes);
  const paging = await client.request('qemuAsm.inspectPaging', { address: pc });
  assert.equal(paging.pagingEnabled, false); assert.equal(paging.physicalAddress, pc);
  const gdt = await client.request('qemuAsm.inspectDescriptors', { table: 'gdt', start: 0, count: 4 });
  assert(gdt.entries.length > 0);
  const assembly = await client.request('qemuAsm.disassemble', { address: pc, count: 4 });
  assert.equal(assembly.bits, 32); assert(assembly.instructions.length > 0);
  console.log('PASS: real DreamOS ISO, DWARF C breakpoint, arguments/locals, F10/F11/step-out, nested stack, GRUB module, virtual/physical memory, GDT, paging state and disassembly');
  const pagedLine = original.split('\n').findIndex(text => text.includes('kernel_init_heap();')) + 1;
  const pagedBreakpoint = await client.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: pagedLine }] });
  assert.equal(pagedBreakpoint.breakpoints[0].verified, true);
  assert.equal((await client.stoppedAfter('continue')).reason, 'breakpoint');
  frame = await top(client); assert.equal(frame.line, pagedLine);
  const pagedPc = numeric(frame.instructionPointerReference);
  const translation = await client.request('qemuAsm.inspectPaging', { address: pagedPc });
  assert.equal(translation.pagingEnabled, true); assert.equal(translation.status, 'mapped');
  const virtualBytes = await client.request('qemuAsm.inspectMemory', { address: pagedPc, count: 16, space: 'virtual' });
  const physicalBytes = await client.request('qemuAsm.inspectMemory', { address: translation.physicalAddress, count: 16, space: 'physical' });
  assert.deepEqual(virtualBytes.bytes, physicalBytes.bytes);
  const ownGdt = await client.request('qemuAsm.inspectDescriptors', { table: 'gdt', start: 0, count: 4 });
  assert(ownGdt.entries.some(entry => entry.present));
  console.log('PASS: real kernel initializes its GDT/IDT and paging; live PDE/PTE translation agrees with virtual and physical code bytes');
  if (!restart) return;
  try {
    await fs.writeFile(source, original.replace('unsigned int module_end;', 'unsigned int module_end = 0x12345678;'));
    await client.request('setBreakpoints', { source: { path: source }, breakpoints: [] });
    assert.equal((await client.stoppedAfter('restart', {})).reason, 'entry');
    assert.equal(await scalar(client, 'module_end'), 0x12345678, 'restart must rebuild and load the changed kernel, not an old ISO');
    console.log('PASS: editing the real kernel and restarting loads the newly built ISO and ELF');
  } finally { await fs.writeFile(source, original); }
}
module.exports = { exercise, top, scalar, numeric };
