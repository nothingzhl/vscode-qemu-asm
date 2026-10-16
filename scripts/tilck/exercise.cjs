const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const numeric = value => Number(/0x[\da-f]+|^-?\d+/i.exec(String(value))?.[0]);
async function top(client) { return (await client.request('stackTrace', { threadId: 1 })).stackFrames[0]; }
async function scalar(client, expression) {
  return numeric((await client.request('evaluate', { expression, frameId: (await top(client)).id, context: 'watch' })).result);
}
async function exercise(client, root) {
  const { source } = JSON.parse(await fs.readFile(path.join(root, 'tilck-source.json'), 'utf8'));
  const file = path.join(source, 'kernel/main.c');
  const original = await fs.readFile(file, 'utf8');
  let frame = await top(client);
  assert.match(frame.name, /kmain/); assert.equal(frame.source.path, file);
  assert(numeric(frame.instructionPointerReference) >= 0xc0000000);
  assert.equal(await scalar(client, 'multiboot_magic'), 0x2badb002);
  assert.equal(await scalar(client, 'saved_multiboot_magic'), 0);
  const pc = numeric(frame.instructionPointerReference);
  const paging = await client.request('qemuAsm.inspectPaging', { address: pc });
  assert.equal(paging.pagingEnabled, true); assert.equal(paging.status, 'mapped');
  assert.notEqual(paging.physicalAddress, pc, 'upstream high virtual address must not be treated as physical');
  const virtual = await client.request('qemuAsm.inspectMemory', { address: pc, count: 16, space: 'virtual' });
  const physical = await client.request('qemuAsm.inspectMemory', { address: paging.physicalAddress, count: 16, space: 'physical' });
  assert.equal(virtual.bytes.length, 16); assert.deepEqual(virtual.bytes, physical.bytes);
  await client.stoppedAfter('next'); await client.stoppedAfter('stepIn');
  const frames = (await client.request('stackTrace', { threadId: 1 })).stackFrames;
  assert.match(frames[0].name, /call_kernel_global_ctors/); assert(frames.some(f => /kmain/.test(f.name)));
  await client.stoppedAfter('next');
  const scopes = (await client.request('scopes', { frameId: (await top(client)).id })).scopes;
  const values = (await Promise.all(scopes.map(scope => client.request('variables', { variablesReference: scope.variablesReference })))).flatMap(group => group.variables);
  assert(values.some(value => value.name === 'h'), 'the real constructor local must appear in scopes');
  assert((await scalar(client, 'h')) >= 0xc0000000, 'local ELF header pointer must use the kernel virtual mapping');
  await client.stoppedAfter('stepOut');
  const line = original.split('\n').findIndex(text => text.includes('early_init_serial_ports();')) + 1;
  assert(line > 0);
  const bind = async () => {
    const result = await client.request('setBreakpoints', { source: { path: file }, breakpoints: [{ line }] });
    assert.equal(result.breakpoints[0].verified, true);
    assert.equal((await client.stoppedAfter('continue')).reason, 'breakpoint');
    const stopped = await top(client); assert.equal(stopped.line, line); assert.equal(stopped.source.path, file);
    assert.equal(await scalar(client, 'saved_multiboot_magic'), 0x2badb002);
  };
  await bind();
  const artifacts = async () => Promise.all(['iso', 'elf'].map(async ext =>
    createHash('sha256').update(await fs.readFile(path.join(root, `build/tilck-toolkit.${ext}`))).digest('hex')));
  const before = await artifacts();
  try {
    const changed = original.replace('static u32 saved_multiboot_magic;', 'static u32 saved_multiboot_magic = 0x12345678;');
    assert.notEqual(changed, original); await fs.writeFile(file, changed);
    await client.request('setBreakpoints', { source: { path: file }, breakpoints: [] });
    assert.equal((await client.stoppedAfter('restart', {})).reason, 'entry');
    assert.equal(await scalar(client, 'saved_multiboot_magic'), 0x12345678);
    const after = await artifacts();
    for (let i = 0; i < before.length; i++) assert.notEqual(before[i], after[i], 'ISO and ELF must both change');
    await bind();
  } finally { await fs.writeFile(file, original); }
  await client.request('setBreakpoints', { source: { path: file }, breakpoints: [] });
  assert.equal((await client.stoppedAfter('restart', {})).reason, 'entry');
  assert.equal(await scalar(client, 'saved_multiboot_magic'), 0);
  console.log('PASS: Tilck ISO, high-address C breakpoints, non-identity paging, memory, source steps, stack and changed/restored kernel restart');
}
module.exports = { exercise, top };
