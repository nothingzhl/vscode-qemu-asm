const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectPaging } = require('../dist/debug/paging');
const { inspectMemory } = require('../dist/debug/inspection');

function registers(changes = {}) {
  return { cr0: 0x80010011, cr3: 0x100018, cr4: 0x10, eflags: 2, cs: 8, cs_base: 0, cs_limit: 0xffffffff,
    cs_flags: 0xcf9b00, ss: 16, ss_base: 0, ss_flags: 0xcf9300, esp: 0xc0100000, ebp: 0xc0100020,
    eip: 0xc0000020, ...changes };
}

function runtime(regs = registers(), values = new Map()) {
  const physicalReads = [], virtualReads = [];
  return { physicalReads, virtualReads, registers: async () => regs,
    readMemory: async (address, count) => { virtualReads.push({ address, count }); return Buffer.alloc(count, 0xaa); },
    readPhysicalMemory: async (address, count) => {
      physicalReads.push({ address, count });
      const value = values.get(address);
      assert.notEqual(value, undefined, `unexpected physical read at ${address.toString(16)}`);
      if (Buffer.isBuffer(value)) return value;
      const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes;
    } };
}

function mapping({ pde = 0x102007, pte = 0x210007, regs = registers(), address = 0xc0100023 } = {}) {
  const directoryAddress = (regs.cr3 & 0xfffff000) >>> 0;
  const values = new Map([[directoryAddress + (address >>> 22) * 4, pde],
    [((pde & 0xfffff000) >>> 0) + ((address >>> 12) & 1023) * 4, pte]]);
  return { address, values, rt: runtime(regs, values) };
}

test('paging disabled is an identity mapping with the actual segmented current PC and no physical read', async () => {
  const rt = runtime(registers({ cr0: 0x11, cr3: undefined, cr4: undefined, cs_base: 0x100000, eip: 0x2345 }));
  const result = await inspectPaging(rt);
  assert.equal(result.address, 0x102345);
  assert.equal(result.physicalAddress, result.address);
  assert.equal(result.pagingEnabled, false);
  assert.equal(result.format, 'disabled');
  assert.equal(result.status, 'identity');
  assert.equal(result.pageSize, undefined);
  assert.equal(result.effective, undefined);
  assert.deepEqual(rt.physicalReads, []);
});

test('4KiB translation reads only physical PDE/PTE entries and combines their permissions', async () => {
  const { rt, address } = mapping({ pde: 0x102027, pte: 0x2101ed });
  const result = await inspectPaging(rt, { address: '0xC0100023' });
  assert.equal(result.status, 'mapped'); assert.equal(result.format, 'legacy32');
  assert.equal(result.address, address); assert.equal(result.physicalAddress, 0x210023);
  assert.equal(result.directoryBase, 0x100000); assert.equal(result.directoryIndex, 768);
  assert.equal(result.tableIndex, 256); assert.equal(result.offset, 0x23); assert.equal(result.pageSize, 4096);
  assert.equal(result.pde.address, 0x100c00); assert.equal(result.pte.address, 0x102400);
  assert.equal(result.pde.raw, 0x102027); assert.equal(result.pte.base, 0x210000);
  assert.equal(result.pde.accessed, true); assert.equal(result.pte.accessed, true); assert.equal(result.pte.dirty, true);
  assert.equal(result.pte.global, true); assert.equal(result.pte.pat, true); assert.equal(result.pte.writeThrough, true);
  assert.deepEqual(result.effective, { user: true, writable: false, supervisorRead: true, supervisorWrite: false, userRead: true, userWrite: false });
  assert.deepEqual(rt.physicalReads, [{ address: 0x100c00, count: 4 }, { address: 0x102400, count: 4 }]);
  assert.deepEqual(rt.virtualReads, []);
  assert.match(result.explanation, /没有 NX/);
  assert.match(result.warnings.join(''), /TLB.*INVLPG/);
});

test('PDE restrictions and CR0.WP control page-level write permissions independently of PTE', async () => {
  const { rt, address } = mapping({ pde: 0x102001, pte: 0x210007, regs: registers({ cr0: 0x80000011 }) });
  const result = await inspectPaging(rt, { address });
  assert.equal(result.wp, false);
  assert.deepEqual(result.effective, { user: false, writable: false, supervisorRead: true, supervisorWrite: true, userRead: false, userWrite: false });
  const writable = mapping({ pde: 0x102007, pte: 0x210007 });
  assert.deepEqual((await inspectPaging(writable.rt, { address })).effective,
    { user: true, writable: true, supervisorRead: true, supervisorWrite: true, userRead: true, userWrite: true });
});

test('PDE present=0 stops before using software-controlled reserved or page-size fields', async () => {
  const rt = runtime(registers(), new Map([[0x100c00, 0xffffffff - 1]]));
  const result = await inspectPaging(rt, { address: 0xc0100000 });
  assert.equal(result.status, 'not-present'); assert.equal(result.faultLevel, 'directory');
  assert.equal(result.physicalAddress, undefined); assert.equal(result.pte, undefined);
  assert.equal(result.pageSize, undefined); assert.equal(result.effective, undefined);
  assert.equal(rt.physicalReads.length, 1);
});

test('PTE present=0 retains raw software data without manufacturing a physical address', async () => {
  const { rt, address } = mapping({ pte: 0xfffffffe });
  const result = await inspectPaging(rt, { address });
  assert.equal(result.status, 'not-present'); assert.equal(result.faultLevel, 'table');
  assert.equal(result.pte.raw, 0xfffffffe); assert.equal(result.pte.base, undefined);
  assert.equal(result.physicalAddress, undefined); assert.equal(result.effective, undefined);
  assert.equal(rt.physicalReads.length, 2);
});

test('ordinary PSE 4MiB mappings preserve unsigned physical addresses and legal PAT bits', async () => {
  const rt = runtime(registers(), new Map([[0x100ffc, 0xffc011e7]]));
  const result = await inspectPaging(rt, { address: 0xffffffff });
  assert.equal(result.status, 'mapped'); assert.equal(result.pageSize, 4194304);
  assert.equal(result.physicalAddress, 0xffffffff); assert.equal(result.offset, 0x3fffff);
  assert.equal(result.pde.base, 0xffc00000); assert.equal(result.pde.pat, true);
  assert.equal(result.pde.global, true); assert.equal(result.pde.dirty, true);
  assert.equal(result.pte, undefined); assert.equal(rt.physicalReads.length, 1);
});

test('CR4.PSE=0 ignores PDE.PS and follows the ordinary 4KiB page table', async () => {
  const { rt, address } = mapping({ pde: 0x102087, regs: registers({ cr4: 0 }) });
  const result = await inspectPaging(rt, { address });
  assert.equal(result.pde.pageSize, true); assert.equal(result.pse, false);
  assert.equal(result.pageSize, 4096); assert.equal(result.physicalAddress, 0x210023);
  assert.match(result.warnings.join(''), /PS 被忽略/);
});

test('PSE-36 high physical bits and the 4MiB reserved bit never produce a truncated address', async () => {
  for (const bit of [13, 16, 20, 21]) {
    const rt = runtime(registers(), new Map([[0x100800, 0x400083 + 2 ** bit]]));
    const result = await inspectPaging(rt, { address: 0x80001234 });
    assert.equal(result.status, bit === 21 ? 'invalid' : 'unsupported');
    assert.equal(result.faultLevel, 'directory'); assert.equal(result.physicalAddress, undefined);
    assert.equal(result.pte, undefined); assert.equal(result.effective, undefined);
    if (bit === 21) assert.equal(result.pde.reservedBits, 0x200000);
    else assert.match(result.explanation, /PSE-36.*32 位物理/);
    assert.equal(rt.physicalReads.length, 1);
  }
});

test('the top page-directory and table entries remain bounded to 32-bit physical space', async () => {
  const { rt, address } = mapping({ regs: registers({ cr3: 0xfffff01f }), address: 0xffffffff, pde: 0xfffff007, pte: 0xfffff007 });
  const result = await inspectPaging(rt, { address });
  assert.equal(result.directoryBase, 0xfffff000); assert.equal(result.pde.address, 0xfffffffc);
  assert.equal(result.pte.address, 0xfffffffc); assert.equal(result.physicalAddress, 0xffffffff);
  assert.deepEqual(rt.physicalReads, [{ address: 0xfffffffc, count: 4 }, { address: 0xfffffffc, count: 4 }]);
});

test('unsupported CPU modes and incomplete paging control registers fail before any physical read', async () => {
  for (const change of [{ cr4: 0x20 }, { cr3: undefined }, { cr4: undefined }, { cr3: -1 }, { cr0: 0x80000000 }, { efer: 0x400 }, { eflags: 0x20002 }, { smm: 1 }, { cs_flags: 0xef9b00 }]) {
    const rt = runtime(registers(change));
    await assert.rejects(inspectPaging(rt, { address: 0 }));
    assert.deepEqual(rt.physicalReads, []);
  }
  await assert.rejects(inspectPaging(runtime(registers({ cr4: 0x20 })), { address: 0 }), /PAE/);
});

test('paging requests accept only bounded literal addresses and exact physical entry replies', async () => {
  const rt = runtime();
  for (const args of [null, [], { address: null }, { address: '' }, { address: 'eax' }, { address: '0x10+4' }, { address: '1e3' }, { address: -1 }, { address: 0.1 }, { address: 0x100000000 }]) await assert.rejects(inspectPaging(rt, args));
  assert.deepEqual(rt.physicalReads, []);
  const broken = runtime(registers(), new Map([[0x100c00, Buffer.alloc(3)]]));
  await assert.rejects(inspectPaging(broken, { address: 0xc0000000 }), /不完整/);
  await assert.rejects(inspectPaging({ registers: async () => registers() }, { address: 0 }), /物理内存/);
});

test('additional SMEP/SMAP protection is explicitly outside the basic page-permission result', async () => {
  const { rt, address } = mapping({ regs: registers({ cr4: 0x300010 }) });
  const result = await inspectPaging(rt, { address });
  assert.equal(result.status, 'mapped');
  assert.match(result.warnings.join(''), /SMEP\/SMAP.*仅解释页表/);
  assert.match(result.explanation, /不代替段权限、CPL/);
});

test('physical memory mode requires a literal physical address and never reuses virtual ESP/EBP', async () => {
  const rt = runtime(registers(), new Map([[0x210000, Buffer.from([1, 2, 3, 4])]]));
  const result = await inspectMemory(rt, { space: 'physical', address: '0x210000', count: 4 });
  assert.deepEqual(result.bytes, [1, 2, 3, 4]); assert.equal(result.address, 0x210000);
  assert.equal(result.space, 'physical'); assert.equal(result.addressContext, 'physical'); assert.equal(result.pagingEnabled, true);
  assert.deepEqual(result.pageMappings, []);
  assert.deepEqual(rt.virtualReads, []);
  for (const args of [{ space: 'linear' }, { space: null }, { space: 'physical', count: 1 }, { space: 'physical', address: 1, follow: 'esp' }, { space: 'physical', address: 1, follow: 'ebp' }]) await assert.rejects(inspectMemory(rt, args));
  await assert.rejects(inspectMemory({ registers: rt.registers, readMemory: rt.readMemory }, { space: 'physical', address: 0, count: 1 }), /不支持物理内存/);
});

test('virtual memory diff context detects PTE remapping even when CR3 is unchanged', async () => {
  const { rt, values, address } = mapping();
  const first = await inspectMemory(rt, { address, count: 16 });
  assert.equal(first.space, 'virtual'); assert.equal(first.pagingEnabled, true);
  assert.deepEqual(first.pageMappings, [{ virtualPage: 0xc0100000, physicalPage: 0x210000 }]);
  values.set(0x102400, 0x310007);
  const second = await inspectMemory(rt, { address, count: 16 });
  assert.equal(first.addressContext, second.addressContext);
  assert.deepEqual(second.pageMappings, [{ virtualPage: 0xc0100000, physicalPage: 0x310000 }]);
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(rt.virtualReads, [{ address, count: 16 }, { address, count: 16 }]);
});

test('virtual memory snapshots crossing pages include both noncontiguous physical mappings', async () => {
  const { rt, values } = mapping();
  values.set(0x102404, 0x710007);
  const result = await inspectMemory(rt, { address: 0xc0100ff0, count: 32 });
  assert.deepEqual(result.pageMappings, [{ virtualPage: 0xc0100000, physicalPage: 0x210000 }, { virtualPage: 0xc0101000, physicalPage: 0x710000 }]);
  assert.ok(result.addressContext.length < 128);
  assert.equal(result.bytes.length, 32);
  assert.equal(rt.physicalReads.length, 4);
});

test('virtual memory ESP follow retains the linear address while its physical mapping is separate', async () => {
  const { rt } = mapping();
  const result = await inspectMemory(rt, { follow: 'esp', count: 4 });
  assert.equal(result.address, 0xc0100000); assert.equal(result.follow, 'esp');
  assert.deepEqual(result.pageMappings, [{ virtualPage: 0xc0100000, physicalPage: 0x210000 }]);
  assert.deepEqual(rt.virtualReads, [{ address: 0xc0100000, count: 4 }]);
});
