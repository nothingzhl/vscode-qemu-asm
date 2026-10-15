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

test('repeated release waits for teardown and rejects allocation until resources are gone', async () => {
  const resources = owned(), cleanup = deferred();
  resources.backend.dispose = async () => { resources.calls.push('backend.dispose'); await cleanup.promise; };
  const owner = new SessionResourceOwner(async () => resources);
  await owner.allocate({}, () => {}, () => {});
  const first = owner.release();
  let secondFinished = false;
  const second = owner.release().then(() => { secondFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondFinished, false, 'a second stop must still wait for the owned connection to close');
  await assert.rejects(owner.allocate({}, () => {}, () => {}), /先释放/);
  cleanup.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(resources.calls, ['backend.dispose', 'display.dispose']);
});

test('allocation failure leaves the owner reusable and competing allocations do not call the factory', async () => {
  const allocation = deferred(), resources = owned();
  let calls = 0;
  const owner = new SessionResourceOwner(() => { calls++; return calls === 1 ? allocation.promise : Promise.resolve(resources); });
  const first = owner.allocate({}, () => {}, () => {});
  await assert.rejects(owner.allocate({}, () => {}, () => {}), /先释放/);
  assert.equal(calls, 1);
  allocation.resolve(Promise.reject(new Error('factory failed')));
  await assert.rejects(first, /factory failed/);
  await owner.allocate({}, () => {}, () => {});
  assert.equal(owner.backend, resources.backend);
  await owner.release();
});

test('simultaneous releases both report the same cleanup failure after remaining resources settle', async () => {
  const resources = owned(), cleanup = deferred();
  resources.backend.dispose = () => { throw new Error('teardown failed'); };
  resources.display.dispose = async () => { await cleanup.promise; resources.calls.push('display.dispose'); };
  const owner = new SessionResourceOwner(async () => resources);
  await owner.allocate({}, () => {}, () => {});
  const first = assert.rejects(owner.release(), /teardown failed/);
  const second = assert.rejects(owner.release(), /teardown failed/);
  cleanup.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(resources.calls, ['display.dispose']);
});

test('a factory cannot reenter allocation before the first resource pair is tracked', async () => {
  const resources = owned();
  let nested;
  const owner = new SessionResourceOwner(async () => {
    nested = assert.rejects(owner.allocate({}, () => {}, () => {}), /先释放/);
    return resources;
  });
  await owner.allocate({}, () => {}, () => {});
  await nested;
  await owner.release();
  assert.deepEqual(resources.calls, ['backend.dispose', 'display.dispose']);
});

test('synchronous cancellation from a capability observer never publishes the cancelled backend', async () => {
  const resources = owned();
  resources.backend.capabilities = { record() {} };
  let stopping;
  const owner = new SessionResourceOwner(async () => resources);
  resources.display.observeCapabilities = () => { stopping = owner.release(); };
  await assert.rejects(owner.allocate({}, () => {}, () => {}), /取消/);
  await stopping;
  assert.equal(owner.backend, undefined);
  assert.deepEqual(resources.calls, ['backend.dispose', 'display.dispose']);
});

test('late cleanup failure reaches every concurrent release after all resources finish', async () => {
  const allocation = deferred(), cleanup = deferred(), resources = owned();
  const failure = new Error('late backend cleanup failed');
  resources.backend.dispose = () => { resources.calls.push('backend.dispose'); throw failure; };
  resources.display.dispose = async () => { await cleanup.promise; resources.calls.push('display.dispose'); };
  const owner = new SessionResourceOwner(() => allocation.promise);
  const starting = assert.rejects(owner.allocate({}, () => {}, () => {}), error => error === failure);
  const first = owner.release(), second = owner.release();
  assert.equal(first, second, 'simultaneous stops share the complete allocation and cleanup result');
  let settled = false;
  const stopping = assert.rejects(first.finally(() => { settled = true; }), error => error === failure);
  allocation.resolve(resources);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'cleanup failure must wait for the late display teardown');
  assert.equal(owner.backend, undefined);
  await assert.rejects(owner.allocate({}, () => {}, () => {}), /先释放/);
  cleanup.resolve();
  await Promise.all([starting, stopping]);
  assert.deepEqual(resources.calls, ['backend.dispose', 'display.dispose']);
});

test('release distinguishes an allocation failure from failure to clean allocated resources', async () => {
  const allocation = deferred();
  const owner = new SessionResourceOwner(() => allocation.promise);
  const starting = assert.rejects(owner.allocate({}, () => {}, () => {}), /factory failed/);
  const stopping = owner.release();
  allocation.resolve(Promise.reject(new Error('factory failed')));
  await Promise.all([starting, stopping]);
  assert.equal(owner.backend, undefined);
});

test('late cleanup errors remain errors even when a disposer rejects without an Error object', async () => {
  const allocation = deferred(), resources = owned();
  resources.backend.dispose = () => Promise.reject(undefined);
  const owner = new SessionResourceOwner(() => allocation.promise);
  const starting = owner.allocate({}, () => {}, () => {});
  const stopping = owner.release();
  const results = Promise.allSettled([starting, stopping]);
  allocation.resolve(resources);
  assert.deepEqual(await results, [
    { status: 'rejected', reason: undefined },
    { status: 'rejected', reason: undefined }
  ]);
  assert.deepEqual(resources.calls, ['display.dispose']);
});
