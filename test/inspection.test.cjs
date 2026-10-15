const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectMemory, inspectDescriptors, decodeGdtEntry, decodeIdtEntry, inspectionAddress } = require('../dist/debug/inspection');
const { monitorRegisters } = require('../dist/debug/runtime');

function segment({ base = 0, limit = 0xfffff, access = 0x9a, flags = 0xc0 } = {}) {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt16LE(limit & 0xffff, 0);
  bytes.writeUInt16LE(base & 0xffff, 2);
  bytes[4] = (base >>> 16) & 255;
  bytes[5] = access;
  bytes[6] = (flags & 0xf0) | ((limit >>> 16) & 15);
  bytes[7] = base >>> 24;
  return bytes;
}
function gate({ selector = 8, offset = 0x89abcdef, access = 0x8e, parameters = 0 } = {}) {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt16LE(offset & 0xffff, 0);
  bytes.writeUInt16LE(selector, 2);
  bytes[4] = parameters;
  bytes[5] = access;
  bytes.writeUInt16LE(offset >>> 16, 6);
  return bytes;
}
function protectedRegisters(changes = {}) {
  return { cr0: 0x11, eflags: 2, cs: 8, cs_base: 0, cs_limit: 0xffffffff, cs_flags: 0xcf9b00,
    ss: 16, ss_base: 0x100000, ss_limit: 0xffffffff, ss_flags: 0xcf9300, eip: 0x10020, esp: 0x12348, ebp: 0x23450,
    gdtr_base: 0x8000, gdtr_limit: 23, idtr_base: 0x9000, idtr_limit: 31, ...changes };
}
function runtime(registers, contents) {
  const reads = [];
  return { reads, registers: async () => registers,
    readMemory: async (address, count) => { reads.push({ address, count }); return contents ? contents(address, count) : Buffer.alloc(count, 0xab); } };
}

test('GDT decoding preserves unsigned bases, 4GiB granularity and access rights', () => {
  const code = decodeGdtEntry(segment({ base: 0x89abcdef }), 1);
  assert.equal(code.kind, 'code');
  assert.equal(code.base, 0x89abcdef);
  assert.equal(code.rawLimit, 0xfffff);
  assert.equal(code.effectiveLimit, 0xffffffff);
  assert.equal(code.defaultBits, 32);
  assert.equal(code.granularity, true);
  assert.equal(code.readable, true);
  assert.equal(code.writable, false);
  assert.equal(code.present, true);
  assert.equal(code.valid, true);
  const data = decodeGdtEntry(segment({ base: 0x12340000, limit: 0x1234, access: 0xf7, flags: 0x10 }), 2);
  assert.equal(data.kind, 'data');
  assert.equal(data.dpl, 3);
  assert.equal(data.expandDown, true);
  assert.equal(data.writable, true);
  assert.equal(data.accessed, true);
  assert.equal(data.available, true);
  assert.equal(data.defaultBits, 16);
  assert.equal(data.effectiveLimit, 0x1234);
  assert.equal(decodeGdtEntry(segment({ access: 0x9e }), 1).conforming, true);
});

test('GDT index zero stays null and segment reserved L/D combinations are flagged', () => {
  const zero = decodeGdtEntry(segment(), 0, protectedRegisters({ cs: 0 }));
  assert.equal(zero.kind, 'null');
  assert.equal(zero.present, false);
  assert.deepEqual(zero.registers, []);
  assert.equal(zero.base, undefined);
  assert.match(zero.warnings.join(''), /空选择子/);
  assert.equal(decodeGdtEntry(segment({ flags: 0xe0 }), 1).valid, false);
  assert.equal(decodeGdtEntry(segment({ access: 0x92, flags: 0xa0 }), 1).valid, false);
  assert.equal(decodeGdtEntry(segment({ flags: 0xa0 }), 1).valid, true);
});

test('GDT system types distinguish LDT/TSS, call gates and reserved types', () => {
  const ldt = decodeGdtEntry(segment({ limit: 0x17, access: 0x82, flags: 0 }), 1);
  assert.equal(ldt.kind, 'ldt'); assert.equal(ldt.effectiveLimit, 0x17); assert.equal(ldt.valid, true);
  assert.equal(ldt.defaultBits, undefined);
  const tss = decodeGdtEntry(segment({ limit: 0x67, access: 0x8b, flags: 0 }), 2);
  assert.equal(tss.kind, 'tss'); assert.match(tss.type, /忙/); assert.equal(tss.valid, true);
  assert.equal(decodeGdtEntry(segment({ access: 0x89, flags: 0x40 }), 2).valid, false);
  const call = decodeGdtEntry(gate({ access: 0xec, parameters: 5 }), 3);
  assert.equal(call.kind, 'call-gate'); assert.equal(call.parameterCount, 5); assert.equal(call.offset, 0x89abcdef); assert.equal(call.valid, true);
  assert.equal(call.selector, 24); assert.equal(call.targetSelector, 8);
  assert.equal(decodeGdtEntry(gate({ access: 0x8c, parameters: 0x20 }), 1).valid, false);
  const narrowCall = decodeGdtEntry(gate({ access: 0x84, offset: 0x1234 }), 1);
  assert.equal(narrowCall.gateBits, 16); assert.equal(narrowCall.valid, true);
  assert.equal(decodeGdtEntry(gate({ access: 0x84 }), 1).valid, false);
  for (const type of [0, 6, 7, 8, 10, 13, 14, 15]) {
    const entry = decodeGdtEntry(segment({ access: 0x80 | type }), 1);
    assert.equal(entry.kind, 'reserved'); assert.equal(entry.valid, false);
  }
});

test('GDT active selector tags respect TI, real mode, Accessed and cached segment changes', () => {
  const bytes = segment();
  const same = decodeGdtEntry(bytes, 1, protectedRegisters({ ds: 0x0b, ds_base: 0, ds_limit: 0xffffffff, ds_flags: 0xcf9b00, es: 0x0c }));
  assert.deepEqual(same.registers, ['CS', 'DS']);
  assert.deepEqual(same.cacheWarnings, []);
  assert.deepEqual(decodeGdtEntry(bytes, 1, protectedRegisters({ cr0: 0, cs: 8 })).registers, []);
  const changed = decodeGdtEntry(segment({ base: 0x200000, access: 0x92 }), 1, protectedRegisters());
  assert.match(changed.cacheWarnings.join(''), /基址.*属性/);
  assert.match(decodeGdtEntry(gate({ access: 0x8c }), 1, protectedRegisters()).cacheWarnings.join(''), /不.*代码\/数据段/);
  assert.match(decodeGdtEntry(segment({ access: 0x80 }), 1, protectedRegisters()).cacheWarnings.join(''), /不.*代码\/数据段/);
});

test('IDT decoding separates 16/32-bit interrupt/trap gates and task gates', () => {
  for (const [access, kind, bits] of [[0x86, 'interrupt-gate', 16], [0x87, 'trap-gate', 16], [0xee, 'interrupt-gate', 32], [0xef, 'trap-gate', 32]]) {
    const entry = decodeIdtEntry(gate({ access, offset: bits === 16 ? 0x5678 : 0x89abcdef }), 3);
    assert.equal(entry.kind, kind); assert.equal(entry.gateBits, bits); assert.equal(entry.valid, true);
    assert.equal(entry.offset, bits === 16 ? 0x5678 : 0x89abcdef);
    assert.equal(entry.dpl, access >>> 5 & 3);
  }
  const task = decodeIdtEntry(gate({ access: 0x85, selector: 0x18, offset: 0 }), 8);
  assert.equal(task.kind, 'task-gate'); assert.equal(task.valid, true); assert.equal(task.offset, undefined);
  assert.equal(decodeIdtEntry(gate({ access: 0x85, offset: 1 }), 8).valid, false);
  assert.equal(decodeIdtEntry(gate({ access: 0x85, selector: 0x1c, offset: 0 }), 8).valid, false);
});

test('IDT reserved bits, S bit, invalid gate types and null target are never presented as valid', () => {
  for (const bytes of [gate({ access: 0x86 }), gate({ parameters: 1 }), gate({ selector: 0 }), gate({ access: 0x9e }), gate({ access: 0x8c }), Buffer.alloc(8)]) {
    assert.equal(decodeIdtEntry(bytes).valid, false);
  }
  const ivt = decodeIdtEntry(Buffer.from('34127856', 'hex'), 255, 'ivt');
  assert.equal(ivt.kind, 'real-mode-vector'); assert.equal(ivt.offset, 0x1234); assert.equal(ivt.selector, 0x5678);
  assert.equal(ivt.gateBits, 16); assert.equal(ivt.valid, true);
  assert.throws(() => decodeIdtEntry(Buffer.alloc(7)), /8 字节/);
  assert.throws(() => decodeGdtEntry(Buffer.alloc(8), 8192), /索引/);
});

test('memory inspector uses full protected offsets and SS cached base for ESP/EBP follow', async () => {
  const rt = runtime(protectedRegisters());
  const stack = await inspectMemory(rt, { follow: 'esp', count: 32 });
  assert.equal(stack.address, 0x112348); assert.deepEqual(stack.bytes, Array(32).fill(0xab));
  assert.equal(stack.mode, 'protected32'); assert.equal(stack.follow, 'esp');
  assert.equal((await inspectMemory(rt, { follow: 'ebp', count: 1 })).address, 0x123450);
  assert.equal((await inspectMemory(rt, { count: 1 })).address, 0x10020);
  const narrowStack = runtime(protectedRegisters({ ss_base: 0x1000, ss_flags: 0x9300 }));
  assert.equal((await inspectMemory(narrowStack, { follow: 'esp', count: 1 })).address, 0x3348);
  const real = runtime({ cr0: 0, cs: 0, eip: 0x7c00, ss: 0x1000, esp: 0x12340010, ebp: 0x56780020 });
  assert.equal((await inspectMemory(real, { follow: 'esp', count: 1 })).address, 0x10010);
  assert.equal((await inspectMemory(real, { follow: 'ebp', count: 1 })).address, 0x10020);
});

test('memory inspector accepts only bounded literal addresses and complete read responses', async () => {
  assert.equal(inspectionAddress(' 0xFFFFFFFF '), 0xffffffff);
  assert.equal(inspectionAddress('4294967295'), 0xffffffff);
  const rt = runtime(protectedRegisters());
  assert.equal((await inspectMemory(rt, { address: 0xffffffff, count: 1 })).address, 0xffffffff);
  assert.equal((await inspectMemory(rt, { address: 0, count: 4096 })).bytes.length, 4096);
  for (const args of [null, [], { count: null }, { count: 0 }, { count: 4097 }, { count: 1.5 }, { count: '32' }, { address: -1 }, { address: 0.5 }, { address: 0x100000000 }, { address: '0x100000000' }, { address: '1e3' }, { address: '0x10 + 4' }, { address: 'EDI' }, { address: {} }, { follow: null }, { follow: 'eax' }, { address: 0xfffffff0, count: 32 }]) {
    await assert.rejects(inspectMemory(rt, args));
  }
  await assert.rejects(inspectMemory(runtime(protectedRegisters(), () => Buffer.alloc(0)), { count: 1 }), /不完整/);
});

test('real IDTR defines a relocated IVT and partial final vectors are not read', async () => {
  const rt = runtime({ cr0: 0, idtr_base: 0x12300, idtr_limit: 10 }, (_address, count) => Buffer.from('34127856abcd0010', 'hex').subarray(0, count));
  const result = await inspectDescriptors(rt, { table: 'idt', count: 128 });
  assert.equal(result.format, 'ivt'); assert.equal(result.base, 0x12300); assert.equal(result.limit, 10);
  assert.equal(result.totalEntries, 2); assert.equal(result.count, 2); assert.equal(result.entrySize, 4);
  assert.equal(result.entries[0].selector, 0x5678); assert.equal(result.entries[1].address, 0x12304);
  assert.deepEqual(rt.reads, [{ address: 0x12300, count: 8 }]);
  assert.match(result.warnings.join(''), /不足/);
});

test('descriptor pages honor full table extent and never read outside complete rows', async () => {
  const rt = runtime(protectedRegisters({ gdtr_limit: 0xffff, idtr_limit: 0xffff, ds: 0x0c }));
  const last = await inspectDescriptors(rt, { table: 'gdt', start: 8191, count: 128 });
  assert.equal(last.totalEntries, 8192); assert.equal(last.count, 1);
  assert.deepEqual(rt.reads[0], { address: 0x8000 + 8191 * 8, count: 8 });
  assert.match(last.warnings.join(''), /LDT/);
  const idt = await inspectDescriptors(rt, { table: 'idt', start: 250, count: 128 });
  assert.equal(idt.totalEntries, 256); assert.equal(idt.count, 6); assert.match(idt.warnings.join(''), /256/);
  const short = runtime(protectedRegisters());
  const empty = await inspectDescriptors(short, { table: 'gdt', start: 3 });
  assert.equal(empty.count, 0); assert.deepEqual(empty.entries, []); assert.deepEqual(short.reads, []);
  const tiny = runtime(protectedRegisters({ gdtr_limit: 6 }));
  assert.equal((await inspectDescriptors(tiny, { table: 'gdt' })).count, 0); assert.deepEqual(tiny.reads, []);
});

test('descriptor requests reject malformed paging and overflowing table reads', async () => {
  const rt = runtime(protectedRegisters());
  for (const args of [undefined, null, [], {}, { table: 'ldt' }, { table: 'gdt', start: null }, { table: 'gdt', start: -1 }, { table: 'gdt', start: 8192 }, { table: 'idt', start: 256 }, { table: 'gdt', start: 0.5 }, { table: 'gdt', count: null }, { table: 'gdt', count: 0 }, { table: 'gdt', count: 129 }, { table: 'gdt', count: '2' }]) {
    await assert.rejects(inspectDescriptors(rt, args));
  }
  assert.deepEqual(rt.reads, []);
  await assert.rejects(inspectDescriptors(runtime(protectedRegisters({ gdtr_base: 0xfffffff8 })), { table: 'gdt' }), /32 位/);
  await assert.rejects(inspectDescriptors(runtime(protectedRegisters({ gdtr_base: undefined })), { table: 'gdt' }), /GDTR/);
  await assert.rejects(inspectDescriptors(runtime(protectedRegisters({ idtr_limit: 0x10000 })), { table: 'idt' }), /IDTR/);
  const real = await inspectDescriptors(runtime({ cr0: 0, cs: 8, gdtr_base: 0x7000, gdtr_limit: 15 }), { table: 'gdt' });
  assert.match(real.warnings.join(''), /实模式/); assert.deepEqual(real.entries[1].registers, []);
});

test('monitor adds optional descriptor tables and system segments without requiring old fixtures to change', () => {
  const base = ['ES', 'CS', 'SS', 'DS', 'FS', 'GS'].map(name => `${name} =0000 00000000 0000ffff 00009300`).join('\n') + '\nCR0=00000010\n';
  assert.equal(monitorRegisters(base).gdtr_base, undefined);
  const registers = monitorRegisters(base + 'GDT=     89abcdef 00000017\nIDT=     00009000 000003ff\nLDT=0000 00000000 0000ffff 00008200\nTR =0018 00123456 00000067 00008b00\n');
  assert.equal(registers.gdtr_base, 0x89abcdef); assert.equal(registers.gdtr_limit, 23);
  assert.equal(registers.idtr_base, 0x9000); assert.equal(registers.idtr_limit, 0x3ff);
  assert.equal(registers.ldt_flags, 0x8200); assert.equal(registers.tr, 0x18); assert.equal(registers.tr_base, 0x123456); assert.equal(registers.tr_limit, 0x67);
});
