const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InspectorModel, parseAddress } = require('../dist/inspector/model');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const memory = (address = 0x7c00, bytes = [1, 2, 3]) => ({ address, count: bytes.length, bytes, mode: 'real16', follow: 'address', space: 'virtual', addressContext: 'virtual:unpaged', pagingEnabled: false, pageMappings: [] });
function harness(id = 'a') {
  const requests = []; const snapshots = [];
  const session = { id, customRequest(command, args) { const pending = deferred(); requests.push({ command, args, ...pending }); return pending.promise; } };
  const model = new InspectorModel(snapshot => snapshots.push(snapshot));
  return { session, requests, snapshots, model };
}
function start(h) { h.model.setSession(h.session); h.model.setVisible(true); h.model.stopped(); }

test('inspector address parsing accepts literal decimal/hex only and bounds the 32-bit address space', () => {
  assert.equal(parseAddress('0xFFFFFFFF'), 0xffffffff); assert.equal(parseAddress(' 31744 '), 0x7c00);
  for (const value of ['eax', '[0x7c00]', '1+2', '0x100000000', '4294967296', '-1', '0b10', '', '1e3', '0x', {}, 123]) assert.equal(parseAddress(value), undefined);
});
test('inspector never reads a running guest or an invisible panel, and reads when opened at an existing stop', async () => {
  const h = harness(); h.model.setSession(h.session); h.model.refresh(); h.model.setVisible(true); h.model.refresh();
  assert.equal(h.requests.length, 0); h.model.setVisible(false); h.model.stopped(); assert.equal(h.requests.length, 0);
  h.model.setVisible(true); assert.equal(h.requests.length, 1); h.requests[0].resolve(memory()); await turn();
  assert.equal(h.model.snapshot.status, 'stopped'); assert.equal(h.model.snapshot.stale, false);
});
test('resume discards an in-flight stopped response and keeps the preceding snapshot visibly stale', async () => {
  const h = harness(); start(h); h.requests[0].resolve(memory()); await turn(); h.model.refresh();
  h.model.request('next'); h.requests[1].resolve(memory(0x7c00, [9])); await turn();
  assert.equal(h.model.snapshot.status, 'running'); assert.equal(h.model.snapshot.stale, true);
  assert.deepEqual(h.model.snapshot.memory.bytes, [1, 2, 3]); assert.equal(h.requests.length, 2);
});
test('form and stop changes coalesce to one newest read without applying an older source response', async () => {
  const h = harness(); start(h);
  for (let index = 0; index < 20; index += 1) { h.model.configure({ address: 0x8000 + index }); h.model.refresh(); }
  h.model.running(); h.model.stopped(); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(memory()); await turn(); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].args.address, 0x8013); assert.equal(h.model.snapshot.memory, undefined);
  h.requests[1].resolve(memory(0x8013, [4])); await turn(); assert.deepEqual(h.model.snapshot.memory.bytes, [4]);
});
test('a pending old session read cannot overwrite a new session or leave it unread', async () => {
  const h = harness(); start(h); const current = harness('b');
  h.model.setSession(current.session); h.model.stopped(); h.requests[0].resolve(memory(0x7c00, [9])); await turn();
  assert.equal(h.model.snapshot.memory, undefined); assert.equal(current.requests.length, 1);
  current.requests[0].resolve(memory(0x7c00, [5])); await turn(); assert.deepEqual(h.model.snapshot.memory.changed, [false]);
});
test('memory highlights compare absolute addresses and clear on restart and session end', async () => {
  const h = harness(); start(h); h.requests[0].resolve(memory(0x7c00, [1, 2, 3])); await turn();
  h.model.configure({ address: 0x7c01 }); h.requests[1].resolve(memory(0x7c01, [2, 9, 4])); await turn();
  assert.deepEqual(h.model.snapshot.memory.changed, [false, true, false]);
  h.model.request('restart'); assert.equal(h.model.snapshot.memory, undefined); h.model.stopped();
  h.requests[2].resolve(memory(0x7c01, [8, 8, 8])); await turn(); assert.deepEqual(h.model.snapshot.memory.changed, [false, false, false]);
  h.model.setSession(undefined); assert.equal(h.model.snapshot.memory, undefined); assert.equal(h.model.snapshot.status, 'idle');
});
test('invalid forms cannot inject requests, last-address reads are clamped, and malformed responses remain stale', async () => {
  const h = harness(); h.model.configure({ address: 0xffffffff, tab: 'memory', follow: 'address', gdtStart: -1, idtStart: 1e9 }); start(h);
  assert.equal(h.requests[0].args.count, 1); assert.equal(h.model.snapshot.form.gdtStart, 0); assert.equal(h.model.snapshot.form.idtStart, 0);
  h.requests[0].resolve(memory(0xffffffff, [256])); await turn(); assert.equal(h.model.snapshot.memory, undefined); assert.match(h.model.snapshot.message, /无效/);
});
test('descriptor reads are paged and a disposed inspector ignores any final response', async () => {
  const h = harness(); h.model.configure({ tab: 'gdt', gdtStart: 64 }); start(h);
  assert.equal(h.requests[0].command, 'qemuAsm.inspectDescriptors'); assert.deepEqual(h.requests[0].args, { table: 'gdt', start: 64, count: 64 });
  h.model.dispose(); const updates = h.snapshots.length; h.requests[0].resolve({ table: 'gdt', format: 'gdt', mode: 'protected32', base: 0x8000, limit: 511, entrySize: 8, totalEntries: 64, start: 64, count: 0, entries: [], warnings: [] });
  await turn(); assert.equal(h.snapshots.length, updates); assert.equal(h.model.snapshot.gdt, undefined);
});

test('following ESP still reads a full page after visiting the final fixed address', async () => {
  const h = harness(); h.model.configure({ address: 0xffffffff }); start(h);
  h.requests[0].resolve(memory(0xffffffff, [1])); await turn();
  h.model.configure({ follow: 'esp' }); assert.equal(h.requests[1].args.count, 256); assert.equal(h.requests[1].args.follow, 'esp');
  h.requests[1].resolve({ ...memory(0x8ffe0, [2]), follow: 'esp' }); await turn();
  assert.equal(h.model.snapshot.memory.address, 0x8ffe0);
});

const disassembly = (address = 0x100000) => ({ address, pc: 0x100000, mode: 'protected32', bits: 32, instructions: [{ address: `0x${address.toString(16)}`, instructionBytes: '90', instruction: 'nop', size: 1 }], nextAddress: address + 1 });
const instructionState = breakpoints => ({ breakpoints: breakpoints ?? [] });
const watchpoint = { id: 3, dataId: '0x110000:4', address: 0x110000, size: 4, access: 'write', verified: true, origin: 'custom' };
test('disassembly follows PC by default, bounds its page, and rejects late responses from another tab', async () => {
  const h = harness(); h.model.configure({ tab: 'disassembly' }); start(h);
  assert.equal(h.requests[0].command, 'qemuAsm.disassemble'); assert.deepEqual(h.requests[0].args, { count: 64 });
  assert.equal(h.requests[1].command, 'qemuAsm.instructionBreakpoints');
  h.model.configure({ tab: 'watchpoints' }); h.requests[0].resolve(disassembly()); h.requests[1].resolve(instructionState()); await turn();
  assert.equal(h.model.snapshot.disassembly, undefined); assert.equal(h.requests[2].command, 'qemuAsm.watchpoints');
  h.requests[2].resolve({ breakpoints: [] }); await turn(); assert.deepEqual(h.model.snapshot.watchpoints.breakpoints, []);
  h.model.configure({ tab: 'disassembly', disassemblyAddress: 0x100020, disassemblyFollow: false });
  assert.deepEqual(h.requests[3].args, { address: 0x100020, count: 64 });
  h.requests[3].resolve(disassembly(0x100020)); h.requests[4].resolve(instructionState()); await turn();
  assert.equal(h.model.snapshot.disassembly.pc, 0x100000); assert.equal(h.model.snapshot.disassembly.address, 0x100020);
});
test('disassembly accepts explicit unknown-boundary placeholders but rejects malformed machine bytes', async () => {
  const h = harness(); h.model.configure({ tab: 'disassembly' }); start(h);
  const data = disassembly(); data.instructions.push({ address: '0x100001', instructionBytes: '', instruction: '边界不可用', size: 0, presentationHint: 'invalid' });
  h.requests[0].resolve(data); h.requests[1].resolve(instructionState()); await turn(); assert.equal(h.model.snapshot.stale, false);
  h.model.refresh(); h.requests[2].resolve({ ...disassembly(), instructions: [{ address: '0x100000', instructionBytes: 'ZZ', instruction: 'nop', size: 1 }] }); h.requests[3].resolve(instructionState()); await turn();
  assert.equal(h.model.snapshot.stale, true); assert.match(h.model.snapshot.message, /无效/);
});
test('watchpoint changes require a confirmed visible stop and discard mutations completed after resume', async () => {
  const h = harness(); h.model.configure({ tab: 'watchpoints' }); h.model.setSession(h.session); h.model.setVisible(true);
  await h.model.changeWatchpoint('add', watchpoint); assert.equal(h.requests.length, 0);
  h.model.stopped(); h.requests[0].resolve({ breakpoints: [] }); await turn();
  const changing = h.model.changeWatchpoint('add', watchpoint); assert.equal(h.requests[1].args.action, 'add'); assert.equal(h.model.snapshot.busy, true);
  h.model.running(); h.requests[1].resolve({ breakpoints: [watchpoint] }); await changing;
  assert.equal(h.model.snapshot.status, 'running'); assert.deepEqual(h.model.snapshot.watchpoints.breakpoints, []);
  h.model.stopped(); h.requests[2].resolve({ breakpoints: [watchpoint], lastHit: { address: 0x110000, access: 'write', ids: [3], pc: 0x100002 } }); await turn();
  assert.deepEqual(h.model.snapshot.watchpoints.lastHit.ids, [3]);
  h.model.request('restart'); assert.equal(h.model.snapshot.watchpoints, undefined); assert.equal(h.model.snapshot.disassembly, undefined);
});
test('instruction mutation keeps native ownership from its response and failed mutations recover for refresh', async () => {
  const h = harness(); h.model.configure({ tab: 'disassembly' }); start(h);
  h.requests[0].resolve(disassembly()); h.requests[1].resolve(instructionState()); await turn();
  const change = h.model.changeInstructionBreakpoint(0x100000, true);
  h.requests[2].resolve(instructionState([{ id: 5, address: 0x100000, verified: true, origin: 'both' }])); await change;
  assert.equal(h.model.snapshot.instructionBreakpoints[0].origin, 'both');
  h.requests[3].resolve(disassembly()); h.requests[4].resolve(instructionState([{ id: 5, address: 0x100000, verified: true, origin: 'both' }])); await turn();
  const failed = h.model.changeInstructionBreakpoint(0x100000, false); h.requests[5].reject(new Error('断点更新失败')); await failed;
  assert.equal(h.model.snapshot.busy, false); assert.equal(h.model.snapshot.stale, true); assert.match(h.model.snapshot.message, /断点更新失败/);
  h.model.refresh(); assert.equal(h.requests[6].command, 'qemuAsm.disassemble');
  h.model.dispose(); h.requests[6].resolve(disassembly()); h.requests[7].resolve(instructionState()); await turn();
});

test('memory address spaces and paging contexts have independent bounded change baselines', async () => {
  const h = harness(); start(h);
  const virtual = (byte, cr3 = 0x100000) => ({ ...memory(0xc0100000, [byte]), mode: 'protected32', pagingEnabled: true, cr3, cr4: 0, addressContext: `virtual:legacy32:${cr3}:0`, pageMappings: [{ virtualPage: 0xc0100000, physicalPage: 0x210000 }] });
  h.requests[0].resolve(virtual(1)); await turn();
  h.model.refresh(); h.requests[1].resolve(virtual(2)); await turn(); assert.deepEqual(h.model.snapshot.memory.changed, [true]);
  h.model.refresh(); h.requests[2].resolve(virtual(9, 0x110000)); await turn(); assert.deepEqual(h.model.snapshot.memory.changed, [false], 'same virtual address with another CR3 must have a fresh baseline');
  h.model.configure({ memorySpace: 'physical', follow: 'esp' });
  assert.equal(h.model.snapshot.form.follow, 'address'); assert.equal(h.requests[3].args.space, 'physical'); assert.equal(h.requests[3].args.follow, 'address');
  h.requests[3].resolve({ ...virtual(17), space: 'physical', addressContext: 'physical' }); await turn();
  assert.deepEqual(h.model.snapshot.memory.changed, [false], 'physical bytes must not compare against virtual bytes');
  h.model.configure({ memorySpace: 'virtual' }); h.requests[4].resolve(virtual(3)); await turn();
  assert.deepEqual(h.model.snapshot.memory.changed, [true], 'returning to a known paging context compares its own preceding snapshot');
  h.model.configure({ memorySpace: 'physical' }); h.requests[5].resolve(virtual(4)); await turn();
  assert.equal(h.model.snapshot.stale, true); assert.match(h.model.snapshot.message, /地址空间不匹配/);
});
const paging = (address = 0xc0100000) => ({ address, mode: 'protected32', pagingEnabled: true, format: 'legacy32', cr0: 0x80010001, cr3: 0x100000, cr4: 0,
  wp: true, pse: false, directoryBase: 0x100000, directoryIndex: 768, tableIndex: 256, offset: 0,
  status: 'mapped', physicalAddress: 0x210000, pageSize: 4096, warnings: [], explanation: '页级权限；不含段权限。',
  effective: { user: false, writable: true, supervisorRead: true, supervisorWrite: true, userRead: false, userWrite: false },
  pde: { level: 'directory', index: 768, address: 0x100c00, raw: 0x102003, present: true, writable: true, user: false, writeThrough: false, cacheDisable: false, accessed: true, pageSize: false, base: 0x102000 },
  pte: { level: 'table', index: 256, address: 0x102400, raw: 0x210003, present: true, writable: true, user: false, writeThrough: false, cacheDisable: false, accessed: true, base: 0x210000 },
});
test('page walks are literal reads, discard old addresses/stops, and clear on restart', async () => {
  const h = harness(); h.model.configure({ tab: 'paging', pagingAddress: 0xc0100000 }); start(h);
  assert.equal(h.requests[0].command, 'qemuAsm.inspectPaging'); assert.deepEqual(h.requests[0].args, { address: 0xc0100000 });
  h.model.configure({ pagingAddress: 0xc0100004 }); h.requests[0].resolve(paging()); await turn(); assert.equal(h.model.snapshot.paging, undefined);
  h.requests[1].resolve(paging(0xc0100004)); await turn(); assert.equal(h.model.snapshot.paging.physicalAddress, 0x210000);
  h.model.refresh(); h.model.running(); h.requests[2].resolve(paging()); await turn();
  assert.equal(h.model.snapshot.paging.address, 0xc0100004); assert.equal(h.model.snapshot.stale, true);
  h.model.request('restart'); assert.equal(h.model.snapshot.paging, undefined);
});
test('page walks show unsupported or missing pages without inventing a physical address', async () => {
  const h = harness(); h.model.configure({ tab: 'paging' }); start(h);
  h.requests[0].resolve({ ...paging(), status: 'unsupported', physicalAddress: undefined, explanation: 'PAE 分页暂不支持。' }); await turn();
  assert.equal(h.model.snapshot.stale, false); assert.equal(h.model.snapshot.paging.physicalAddress, undefined);
  h.model.refresh(); h.requests[1].resolve({ ...paging(), status: 'not-present', faultLevel: 'table', physicalAddress: 0x210000 }); await turn();
  assert.equal(h.model.snapshot.stale, true); assert.match(h.model.snapshot.message, /无效的页表/);
});

test('paging memory comparison keeps overlap across viewport boundaries and separates remapped pages', async () => {
  const h = harness(); start(h);
  const data = (address, bytes, mappings) => ({ ...memory(address, bytes), pagingEnabled: true, mode: 'protected32', cr3: 0x100000, cr4: 0,
    addressContext: 'virtual:legacy32:1048576:0', pageMappings: mappings.map(([virtualPage, physicalPage]) => ({ virtualPage, physicalPage })) });
  h.requests[0].resolve(data(0x1ffc, [1, 2, 3, 4, 5, 6, 7, 8], [[0x1000, 0x3000], [0x2000, 0x5000]])); await turn();
  h.model.configure({ address: 0x2000 }); h.requests[1].resolve(data(0x2000, [5, 9, 7, 8], [[0x2000, 0x5000]])); await turn();
  assert.deepEqual(h.model.snapshot.memory.changed, [false, true, false, false], 'viewport losing its first page must retain overlap history for the second page');
  h.model.refresh(); h.requests[2].resolve(data(0x2000, [10, 11, 12, 13], [[0x2000, 0x7000]])); await turn();
  assert.deepEqual(h.model.snapshot.memory.changed, [false, false, false, false], 'a changed PTE must not compare a different physical page');
  h.model.refresh(); h.requests[3].resolve(data(0x2000, [5, 10, 7, 8], [[0x2000, 0x5000]])); await turn();
  assert.deepEqual(h.model.snapshot.memory.changed, [false, true, false, false]);
  h.model.refresh(); h.requests[4].resolve(data(0x2000, [5], [])); await turn();
  assert.equal(h.model.snapshot.stale, true); assert.match(h.model.snapshot.message, /缺少物理映射/);
});
