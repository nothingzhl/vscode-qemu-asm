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
