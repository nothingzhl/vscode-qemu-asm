const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionResourceOwner } = require('../dist/application/sessionResources');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function owned() {
  const calls = [];
  return {
    calls,
    backend: { async launch() { calls.push('launch'); }, async dispose() { calls.push('backend.dispose'); } },
    display: { async connect() { calls.push('connect'); }, async dispose() { calls.push('display.dispose'); } }
  };
}

test('debug release waits for late allocation and closes it without publishing a backend', async () => {
  const allocation = deferred(), resources = owned();
  const owner = new SessionResourceOwner(() => allocation.promise);
  const starting = owner.allocate({}, () => {}, () => {});
  const cancelled = assert.rejects(starting, /取消/);
  let done = false;
  const stopping = owner.release().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  allocation.resolve(resources);
  await Promise.all([cancelled, stopping]);
  assert.equal(owner.backend, undefined);
  assert.deepEqual(resources.calls, ['backend.dispose', 'display.dispose']);
});

test('trust revoked during allocation releases the complete resource pair', async () => {
  const resources = owned();
  const owner = new SessionResourceOwner(async () => resources);
  await assert.rejects(owner.allocate({}, () => {}, () => { throw new Error('workspace no longer trusted'); }), /trusted/);
  assert.equal(owner.backend, undefined);
  await owner.release();
  assert.deepEqual(resources.calls, ['backend.dispose', 'display.dispose']);
});

test('observer failure cannot strand an allocated backend or display', async () => {
  const resources = owned();
  resources.backend.capabilities = { record() {} };
  resources.display.observeCapabilities = () => { throw new Error('observer failed'); };
  const owner = new SessionResourceOwner(async () => resources);
  await assert.rejects(owner.allocate({}, () => {}, () => {}), /observer failed/);
  assert.equal(owner.backend, undefined);
  assert.deepEqual(resources.calls, ['backend.dispose', 'display.dispose']);
});

test('concurrent releases share teardown and do not capture the following session', async () => {
  const first = owned(), next = owned(), cleanup = deferred();
  first.backend.dispose = async () => { first.calls.push('backend.dispose'); await cleanup.promise; };
  let current = first;
  const owner = new SessionResourceOwner(async () => current);
  await owner.allocate({}, () => {}, () => {});
  const stopping = owner.release(), again = owner.release();
  cleanup.resolve();
  await Promise.all([stopping, again]);
  assert.deepEqual(first.calls, ['backend.dispose', 'display.dispose']);
  current = next;
  await owner.allocate({}, () => {}, () => {});
  assert.equal(owner.backend, next.backend);
  await owner.connect();
  assert.deepEqual(next.calls, ['connect']);
  await owner.release();
});

test('a synchronous backend teardown error still releases the display', async () => {
  const resources = owned();
  resources.backend.dispose = () => { throw new Error('backend teardown failed'); };
  const owner = new SessionResourceOwner(async () => resources);
  await owner.allocate({}, () => {}, () => {});
  await assert.rejects(owner.release(), /backend teardown failed/);
  assert.deepEqual(resources.calls, ['display.dispose']);
});

test('cleanup error waits for the other owned resource before it is reported', async () => {
  const resources = owned(), cleanup = deferred();
  resources.backend.dispose = async () => { throw new Error('backend teardown failed'); };
  resources.display.dispose = async () => { await cleanup.promise; resources.calls.push('display.dispose'); };
  const owner = new SessionResourceOwner(async () => resources);
  await owner.allocate({}, () => {}, () => {});
  let settled = false;
  const stopping = owner.release().finally(() => { settled = true; });
  const rejected = assert.rejects(stopping, /backend teardown failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'cleanup must not reject while the display remains owned');
  cleanup.resolve();
  await rejected;
  assert.deepEqual(resources.calls, ['display.dispose']);
});
