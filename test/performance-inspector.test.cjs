const test = require('node:test');
const assert = require('node:assert/strict');
const { InspectorSnapshots } = require('../dist/inspector/snapshots');

function raw(address, bytes) {
  return { value: {
    address, bytes, count: bytes.length, mode: 'real16', follow: 'address',
    space: 'virtual', addressContext: 'virtual:unpaged', pagingEnabled: false, pageMappings: []
  } };
}

test('bounded memory history evicts the oldest bytes and preserves the latest comparison after scrolling', () => {
  const snapshots = new InspectorSnapshots();
  const form = { tab: 'memory', memorySpace: 'virtual' };
  for (let address = 0; address < 5120; address += 256)
    snapshots.apply(form, raw(address, Array(256).fill(1)));
  assert.equal(snapshots.seen.size, 4096);
  assert.deepEqual(snapshots.apply(form, raw(5000, [2])).memory.changed, [true]);
  assert.deepEqual(snapshots.apply(form, raw(0, [2])).memory.changed, [false]);
  assert.equal(snapshots.seen.size, 4096);
  assert.deepEqual(snapshots.apply(form, raw(0, [3])).memory.changed, [true]);
  snapshots.clear();
  assert.equal(snapshots.seen.size, 0);
  assert.deepEqual(snapshots.apply(form, raw(0, [4])).memory.changed, [false]);
});

test('failed paged snapshots never displace history or commit partial byte values', () => {
  const snapshots = new InspectorSnapshots();
  const form = { tab: 'memory', memorySpace: 'virtual' };
  const valid = raw(0x1000, [0]);
  valid.value.pagingEnabled = true;
  valid.value.pageMappings = [{ virtualPage: 0x1000, physicalPage: 0x2000 }];
  snapshots.apply(form, valid);
  const invalid = { value: { ...valid.value, bytes: [9], pageMappings: [] } };
  assert.throws(() => snapshots.apply(form, invalid), /缺少物理映射/);
  assert.equal(snapshots.seen.size, 1);
  valid.value.bytes = [1];
  assert.deepEqual(snapshots.apply(form, valid).memory.changed, [true]);
});
