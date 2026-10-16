const test = require('node:test');
const assert = require('node:assert/strict');
const { DapChannel } = require('../dist/integration/dap/channel');

function harness(dispatch, cleanup = async () => {}) {
  const messages = [];
  const channel = new DapChannel(dispatch, cleanup, ['variables']);
  channel.onDidSendMessage((message) => messages.push(message));
  const request = (command, args, seq = 1) =>
    channel.handleMessage({
      type: 'request',
      seq,
      command,
      ...(args === undefined ? {} : { arguments: args })
    });
  return { channel, messages, request };
}

test('failed launch cleanup reports its error and leaves the request queue usable', async () => {
  const commands = [];
  const h = harness(
    async (request) => {
      commands.push(request.command);
      if (request.command === 'launch') throw new Error('launch failed');
    },
    async () => {
      throw new Error('owned cleanup failed');
    }
  );
  h.request('launch');
  await h.channel.queue;
  h.request('threads', undefined, 2);
  await h.channel.queue;
  assert.deepEqual(commands, ['launch', 'threads']);
  assert.match(h.messages[0].message, /launch failed/);
  assert.equal(h.messages[0].success, false);
  assert.match(h.messages[1].body.output, /owned cleanup failed/);
  assert.equal(h.messages[1].body.category, 'stderr');
});

test('stopped-event failure waits for cleanup and survives cleanup rejection', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness(
    async () => {},
    async () => {
      await gate;
      throw new Error('cleanup failed');
    }
  );
  let finished = false;
  const stopping = h.channel.fail(new Error('register read failed')).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await stopping;
  assert.match(h.messages[0].body.output, /register read failed/);
  assert.match(h.messages[1].body.output, /cleanup failed/);
});

test('serialization preserves request order across asynchronous failures', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const commands = [];
  const h = harness(async (request) => {
    commands.push(request.command);
    if (request.command === 'first') {
      await gate;
      throw new Error('first failed');
    }
  });
  h.request('first');
  h.request('second', undefined, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, ['first']);
  release();
  await h.channel.queue;
  assert.deepEqual(commands, ['first', 'second']);
});

test('inline read failures stay in their views; control failures request user visibility', async () => {
  const h = harness(async () => {
    throw new Error('read failed');
  });
  h.request('variables');
  h.request('continue', undefined, 2);
  await h.channel.queue;
  assert.equal(h.messages[0].body.error.showUser, false);
  assert.equal(h.messages[1].body.error.showUser, true);
  assert.deepEqual(
    h.messages.map((message) => message.seq),
    [1, 2]
  );
});

test('invalid envelopes and messages arriving after close never dispatch', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
  });
  for (const message of [
    null,
    undefined,
    {},
    { type: 'event' },
    { type: 'request', seq: NaN, command: 'launch' },
    { type: 'request', seq: 1, command: '' }
  ])
    h.channel.handleMessage(message);
  h.channel.close();
  h.request('launch');
  await h.channel.queue;
  assert.equal(calls, 0);
});

test('invalid argument containers fail before dispatch without blocking a later valid request', async () => {
  const commands = [];
  const h = harness(async (request) => {
    commands.push(request.command);
  });
  h.request('variables', []);
  h.request('variables', null, 2);
  h.request('variables', {}, 3);
  await h.channel.queue;
  assert.deepEqual(commands, ['variables']);
  assert.equal(h.messages.length, 2);
  assert(h.messages.every((message) => !message.success && /参数必须是对象/.test(message.message)));
});
