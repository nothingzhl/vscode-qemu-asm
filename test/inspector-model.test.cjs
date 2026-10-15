const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InspectorModel, parseAddress } = require('../dist/inspector/model');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const memory = (address = 0x7c00, bytes = [1, 2, 3]) => ({ address, count: bytes.length, bytes, mode: 'real16', follow: 'address' });
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
