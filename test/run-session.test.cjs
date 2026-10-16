const test = require('node:test');
const assert = require('node:assert/strict');
const { RunSession } = require('../dist/application/runSession');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function resources() {
  const exited = deferred(),
    calls = [];
  return {
    calls,
    exited,
    machine: {
      async start() {
        calls.push('start');
        return { executable: '/vm', exited: exited.promise };
      },
      async dispose() {
        calls.push('machine.dispose');
      }
    },
    display: {
      async connect() {
        calls.push('connect');
      },
      async dispose() {
        calls.push('display.dispose');
      }
    }
  };
}

test('stop waits for a pending machine start even when teardown fails', async () => {
  const session = new RunSession(),
    owner = resources(),
    starting = deferred();
  owner.machine.start = () => {
    owner.calls.push('start');
    return starting.promise;
  };
  owner.machine.dispose = () => {
    owner.calls.push('machine.dispose');
    throw new Error('teardown failed');
  };
  const launch = assert.rejects(
    session.start(async () => owner),
    /teardown failed/
  );
  await tick();
  let settled = false;
  const stop = assert.rejects(
    session.stop().finally(() => {
      settled = true;
    }),
    /teardown failed/
  );
  await tick();
  assert.equal(settled, false, 'stop must not finish while the in-flight start can still publish a VM');
  starting.resolve({ executable: '/vm', exited: owner.exited.promise });
  await Promise.all([launch, stop]);
  assert.deepEqual(owner.calls, ['start', 'machine.dispose', 'display.dispose']);
});

test('a factory rejection is reported and does not block the next run', async () => {
  const session = new RunSession(),
    owner = resources();
  await assert.rejects(
    session.start(async () => {
      throw new Error('allocation failed');
    }),
    /allocation failed/
  );
  await session.start(async () => owner);
  await session.stop();
  assert.deepEqual(owner.calls, ['start', 'connect', 'machine.dispose', 'display.dispose']);
});

test('machine startup failure waits for both resources before rejecting', async () => {
  const session = new RunSession(),
    owner = resources(),
    cleanup = deferred();
  owner.machine.start = async () => {
    throw new Error('VM startup failed');
  };
  owner.display.dispose = async () => {
    await cleanup.promise;
    owner.calls.push('display.dispose');
  };
  let settled = false;
  const launch = assert.rejects(
    session
      .start(async () => owner)
      .finally(() => {
        settled = true;
      }),
    /VM startup failed/
  );
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(owner.calls, ['machine.dispose']);
  cleanup.resolve();
  await launch;
  assert.deepEqual(owner.calls, ['machine.dispose', 'display.dispose']);
  await session.stop();
});

test('stop during display connection cannot return a successful run or double-dispose it', async () => {
  const session = new RunSession(),
    owner = resources(),
    connection = deferred();
  owner.display.connect = () => {
    owner.calls.push('connect');
    return connection.promise;
  };
  const launch = assert.rejects(
    session.start(async () => owner),
    /取消/
  );
  await tick();
  let stopped = false;
  const stopping = session.stop().then(() => {
    stopped = true;
  });
  await tick();
  assert.equal(stopped, false);
  connection.resolve();
  await Promise.all([launch, stopping]);
  assert.deepEqual(owner.calls, ['start', 'connect', 'machine.dispose', 'display.dispose']);
});

test('process exit failure releases both resources and permits a fresh run', async () => {
  const session = new RunSession(),
    first = resources(),
    next = resources();
  await session.start(async () => first);
  first.exited.reject(new Error('process crashed'));
  await tick();
  await session.start(async () => next);
  await session.stop();
  assert.deepEqual(first.calls, ['start', 'connect', 'machine.dispose', 'display.dispose']);
  assert.deepEqual(next.calls, ['start', 'connect', 'machine.dispose', 'display.dispose']);
});

test('a synchronous resource factory cannot reenter start or bypass its stop barrier', async () => {
  const session = new RunSession(),
    owner = resources();
  let nested, stopping;
  const launch = assert.rejects(
    session.start(() => {
      nested = assert.rejects(
        session.start(async () => assert.fail('second factory ran')),
        /先停止/
      );
      stopping = session.stop();
      return Promise.resolve(owner);
    }),
    /取消/
  );
  await launch;
  await Promise.all([nested, stopping]);
  assert.deepEqual(owner.calls, ['machine.dispose', 'display.dispose']);
});

test('late resource cleanup failure reaches every stop after the complete resource pair settles', async () => {
  const session = new RunSession(),
    allocation = deferred(),
    cleanup = deferred(),
    owner = resources();
  const failure = new Error('late VM teardown failed');
  owner.machine.dispose = () => {
    owner.calls.push('machine.dispose');
    throw failure;
  };
  owner.display.dispose = async () => {
    await cleanup.promise;
    owner.calls.push('display.dispose');
  };
  const launch = assert.rejects(
    session.start(() => allocation.promise),
    (error) => error === failure
  );
  const first = session.stop(),
    second = session.stop();
  assert.equal(first, second, 'concurrent stops share the late resource cleanup result');
  let settled = false;
  const stopping = assert.rejects(
    first.finally(() => {
      settled = true;
    }),
    (error) => error === failure
  );
  allocation.resolve(owner);
  await tick();
  assert.equal(settled, false, 'the display must finish teardown before a VM cleanup error is reported');
  await assert.rejects(
    session.start(async () => assert.fail('a new factory ran during cleanup')),
    /先停止/
  );
  cleanup.resolve();
  await Promise.all([launch, stopping]);
  assert.deepEqual(owner.calls, ['machine.dispose', 'display.dispose']);
});

test('normal cancellation releases late resources and stop succeeds without starting the VM', async () => {
  const session = new RunSession(),
    allocation = deferred(),
    owner = resources();
  const launch = assert.rejects(
    session.start(() => allocation.promise),
    /取消/
  );
  const stopping = session.stop();
  allocation.resolve(owner);
  await Promise.all([launch, stopping]);
  assert.deepEqual(owner.calls, ['machine.dispose', 'display.dispose']);
  const next = resources();
  await session.start(async () => next);
  await session.stop();
  assert.deepEqual(next.calls, ['start', 'connect', 'machine.dispose', 'display.dispose']);
});

test('factory failure during stop belongs to start and is not misreported as a cleanup error', async () => {
  const session = new RunSession(),
    allocation = deferred();
  const failure = new Error('factory failed');
  const launch = assert.rejects(
    session.start(() => allocation.promise),
    (error) => error === failure
  );
  const stopping = session.stop();
  allocation.reject(failure);
  await Promise.all([launch, stopping]);
});

test('late teardown rejection propagates even without an Error object', async () => {
  const session = new RunSession(),
    allocation = deferred(),
    owner = resources();
  owner.machine.dispose = () => Promise.reject(undefined);
  const starting = session.start(() => allocation.promise),
    stopping = session.stop();
  const outcomes = Promise.allSettled([starting, stopping]);
  allocation.resolve(owner);
  assert.deepEqual(await outcomes, [
    { status: 'rejected', reason: undefined },
    { status: 'rejected', reason: undefined }
  ]);
  assert.deepEqual(owner.calls, ['display.dispose']);
});
