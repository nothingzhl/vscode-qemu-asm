const test = require('node:test');
const assert = require('node:assert/strict');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');
const { SourceMap } = require('../dist/debug/listing');

const registers = { cr0: 0x80010011, cr3: 0x1000, cr4: 0, eflags: 2,
  cs: 8, cs_base: 0, cs_limit: 0xffffffff, cs_flags: 0xcf9b00,
  ss: 16, ss_base: 0, ss_limit: 0xffffffff, ss_flags: 0xcf9300, eip: 0x8ffe };
function adapter(pages, fail = false) {
  const result = new AssemblyDebugAdapter({ isTrusted: () => true, getProject: async () => { throw new Error('unused'); } });
  result.map = new SourceMap('/tmp/stage2.asm', 0x8000, [{ line: 7, address: 0x8ffe, size: 5, bits: 32, text: 'call nested' }], 0x2000);
  result.phase = 'stopped';
  result.runtime = { registers: async () => registers, readPhysicalMemory: async (address, count) => {
    if (fail) throw new Error('physical reads unsupported');
    assert.equal(count, 4);
    const value = address === 0x1000 ? 0x2003 : pages[(address - 0x2000) / 4] || 0;
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes;
  }, dispose: async () => {} };
  return result;
}
test('paged NASM source requires identity mapping for both pages of an instruction', async () => {
  const a = adapter({ 8: 0x8003, 9: 0x9003 });
  assert.equal((await a.locateLive(0x8ffe, 32, registers)).entry.line, 7);
  assert.equal((await a.locateLive(0x9001, 32, registers)).entry.line, 7);
  a.runtime.readPhysicalMemory = adapter({ 8: 0x8003, 9: 0xa003 }).runtime.readPhysicalMemory;
  assert.equal(await a.locateLive(0x8ffe, 32, registers), undefined, 'remapped instruction tail cannot inherit listing size');
  a.runtime.readPhysicalMemory = adapter({ 8: 0xb003, 9: 0x9003 }).runtime.readPhysicalMemory;
  assert.equal(await a.locateLive(0x9001, 32, registers), undefined, 'a query inside the instruction still verifies its first page');
  await a.dispose();
});
test('unverified physical source mapping falls back to machine debugging', async () => {
  const a = adapter({}, true);
  assert.equal(await a.locateLive(0x8ffe, 32, registers), undefined);
  assert.equal(await a.locateLive(0xc0000000, 32, registers), undefined);
  assert.equal((await a.locateLive(0x8ffe, 32, { ...registers, cr0: 0x11 })).entry.line, 7);
  await a.dispose();
});
