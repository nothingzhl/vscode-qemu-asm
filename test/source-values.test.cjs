const test = require('node:test');
const assert = require('node:assert/strict');
const { SourceValues } = require('../dist/application/source/values');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = (id = 'root', children = 0) => ({
  id,
  name: id,
  type: 'struct item',
  value: '{...}',
  childCount: children,
  hasMore: false
});
function setup() {
  const released = [];
  const backend = {
    stack: {
      async frames() {
        return [{ level: 0, name: 'kernel', line: 5, address: 0x1000 }];
      }
    },
    variables: {
      async list() {
        return [];
      },
      async create(expression) {
        return row(expression);
      },
      async children() {
        return [];
      },
      async release(ids) {
        released.push(...ids);
      }
    }
  };
  return {
    backend,
    released,
    values: new SourceValues(
      () => backend,
      () => backend
    )
  };
}

test('concurrent frame requests share one backend read and stable frame handles', async () => {
  const { backend, values } = setup(),
    pending = deferred();
  let reads = 0;
  backend.stack.frames = () => {
    reads++;
    return pending.promise;
  };
  const first = values.frames(),
    second = values.frames();
  pending.resolve([{ level: 0, name: 'kernel', line: 5 }]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(a, b);
  assert.equal(values.framesById.size, 1);
  assert.equal(await values.frames(), a);
});

test('cleared pending frames cannot overwrite the next stop and failures remain retryable', async () => {
  const { backend, values } = setup(),
    old = deferred(),
    current = deferred();
  backend.stack.frames = () => old.promise;
  const first = assert.rejects(values.frames(), /过期/);
  values.clear();
  backend.stack.frames = () => current.promise;
  const second = values.frames();
  old.resolve([{ level: 0, name: 'old', line: 1 }]);
  await first;
  current.resolve([{ level: 0, name: 'current', line: 9 }]);
  const frames = await second;
  assert.deepEqual(
    [...values.framesById.values()].map((frame) => frame.name),
    ['current']
  );
  assert.equal(await values.frames(), frames);
  values.clear();
  backend.stack.frames = async () => {
    throw new Error('stack unavailable');
  };
  await assert.rejects(values.frames(), /stack unavailable/);
  backend.stack.frames = async () => [{ level: 0, name: 'retry', line: 10 }];
  assert.equal((await values.frames())[0].name, 'retry');
});

test('concurrent pages of one scope enumerate and allocate each variable once', async () => {
  const { backend, values, released } = setup(),
    pending = deferred();
  let lists = 0,
    creates = 0;
  backend.variables.list = () => {
    lists++;
    return pending.promise;
  };
  backend.variables.create = async (expression) => {
    creates++;
    return row(expression);
  };
  const reference = values.handle({ kind: 'locals', frame: 0 });
  const first = values.variables(reference, 0, 1),
    second = values.variables(reference, 1, 1);
  pending.resolve([
    { name: 'a', value: '1', type: 'int', argument: false },
    { name: 'b', value: '2', type: 'int', argument: false },
    { name: 'arg', value: '3', type: 'int', argument: true }
  ]);
  assert.deepEqual(
    (await first).map((variable) => variable.name),
    ['a']
  );
  assert.deepEqual(
    (await second).map((variable) => variable.name),
    ['b']
  );
  assert.deepEqual([lists, creates], [1, 2]);
  await values.variables(reference, 0, 2);
  assert.deepEqual([lists, creates], [1, 2]);
  await values.expireVariables();
  assert.deepEqual(released, ['a', 'b']);
});

test('a late variable list cannot allocate objects or revive expired handles', async () => {
  const { backend, values } = setup(),
    pending = deferred();
  backend.variables.list = () => pending.promise;
  backend.variables.create = async () => assert.fail('an expired list allocated a variable');
  const reference = values.handle({ kind: 'locals', frame: 0 });
  const reading = assert.rejects(values.variables(reference, 0, 10), /过期/);
  await values.expireVariables();
  pending.resolve([{ name: 'old', value: '1', type: 'int', argument: false }]);
  await reading;
  assert.equal(values.handles.size, 0);
  assert.deepEqual(await values.variables(reference, 0, 10), []);
});

test('a root object created after resume is released before the stale request rejects', async () => {
  const { backend, values, released } = setup(),
    creating = deferred(),
    cleanup = deferred();
  backend.variables.create = () => creating.promise;
  backend.variables.release = async (ids) => {
    released.push(...ids);
    if (ids.length) await cleanup.promise;
  };
  let settled = false;
  const reading = assert.rejects(
    values.createVariable('old', 0).finally(() => {
      settled = true;
    }),
    /过期/
  );
  await values.expireVariables();
  creating.resolve(row('late', 1));
  await tick();
  assert.deepEqual(released, ['late']);
  assert.equal(settled, false);
  assert.equal(values.handles.size, 0);
  cleanup.resolve();
  await reading;
});

test('failure to release a late root surfaces the cleanup error without poisoning new locals', async () => {
  const { backend, values } = setup(),
    creating = deferred();
  backend.variables.list = async () => [{ name: 'old', value: '1', type: 'int', argument: false }];
  backend.variables.create = () => creating.promise;
  backend.variables.release = async (ids) => {
    if (ids.length) throw new Error('late root cleanup failed');
  };
  const reference = values.handle({ kind: 'locals', frame: 0 });
  const reading = assert.rejects(values.variables(reference, 0, 10), /late root cleanup failed/);
  await tick();
  await values.expireVariables();
  creating.resolve(row('late', 1));
  await reading;
  assert.equal(values.handles.size, 0);
  backend.variables.list = async () => [];
  const current = values.handle({ kind: 'locals', frame: 0 });
  assert.deepEqual(await values.variables(current, 0, 10), []);
});

test('late object children cannot repopulate cleared handles or overwrite the new stop', async () => {
  const { backend, values } = setup(),
    children = deferred();
  backend.variables.create = async () => row('parent', 1);
  backend.variables.children = () => children.promise;
  const parent = await values.createVariable('parent', 0);
  const reading = assert.rejects(values.variables(parent.variablesReference, 0, 10), /过期/);
  await values.expireVariables();
  const current = values.handle({ kind: 'registers', frame: 0 });
  children.resolve([row('child', 1)]);
  await reading;
  assert.deepEqual([...values.handles.keys()], [current]);
});

test('concurrent creation cannot bypass the root-object budget and overflow is cleaned immediately', async () => {
  const { backend, values, released } = setup(),
    pending = deferred();
  let serial = 0;
  backend.variables.create = async () => {
    const id = `root${serial++}`;
    await pending.promise;
    return row(id);
  };
  const requests = Array.from({ length: 513 }, () => values.createVariable('value', 0));
  const outcomes = Promise.allSettled(requests);
  pending.resolve();
  const results = await outcomes;
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 512);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /512/);
  assert.deepEqual(released, ['root512']);
  await values.expireVariables();
  assert.equal(released.length, 513);
});

test('expired register reads reject and unallocated references never contact the backend', async () => {
  const { backend, values } = setup(),
    registers = deferred();
  let reads = 0;
  backend.registers = () => {
    reads++;
    return registers.promise;
  };
  const reference = values.handle({ kind: 'registers', frame: 0 });
  const reading = assert.rejects(values.variables(reference, 0, 10), /过期/);
  values.clear();
  registers.resolve({ eax: 42 });
  await reading;
  assert.deepEqual(await values.variables(reference, 0, 10), []);
  assert.equal(reads, 1);
});

test('array paging bounds retained rows, reuses recent pages and reloads evicted leaves correctly', async () => {
  const { backend, values } = setup();
  let reads = 0;
  backend.variables.create = async () => row('array', 100000);
  backend.variables.children = async (_id, start, count) => {
    reads++;
    return Array.from({ length: count }, (_, index) => ({
      ...row(`element${start + index}`),
      value: String(start + index)
    }));
  };
  const parent = await values.createVariable('array', 0),
    reference = parent.variablesReference;
  for (let page = 0; page < 17; page++) await values.variables(reference, page * 256, 256);
  assert.equal(reads, 17);
  assert.equal((await values.variables(reference, 16 * 256, 256))[0].value, '4096');
  assert.equal(reads, 17, 'recent page should reuse the cached rows');
  assert.equal((await values.variables(reference, 0, 256))[0].value, '0');
  assert.equal(reads, 18, 'the oldest page must be evicted once 4096 retained rows are exceeded');
  assert.equal(values.handles.size, 1, 'reloading leaves must not allocate more object handles');
  await values.expireVariables();
  assert.deepEqual(await values.variables(reference, 0, 256), []);
});

test('many empty array pages cannot grow the cache without a bound', async () => {
  const { backend, values } = setup();
  let reads = 0;
  backend.variables.create = async () => row('array', 1);
  backend.variables.children = async () => {
    reads++;
    return [];
  };
  const parent = await values.createVariable('array', 0),
    reference = parent.variablesReference;
  for (let start = 0; start < 129; start++) await values.variables(reference, start, 1);
  await values.variables(reference, 128, 1);
  assert.equal(reads, 129);
  await values.variables(reference, 0, 1);
  assert.equal(reads, 130, 'empty pages still count toward the cache entry budget');
});
