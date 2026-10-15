const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AssemblyDapAdapter } = require('../dist/integration/dap/assemblyAdapter');
const { SourceDapAdapter } = require('../dist/integration/dap/sourceAdapter');
const { SourceMap } = require('../dist/domain/source/map');
const turn = () => new Promise((resolve) => setImmediate(resolve));

function harness(Adapter) {
  const messages = [];
  const backend = Object.assign(new EventEmitter(), {
    launch: async () => {},
    dispose: async () => {
      throw new Error('owned cleanup failed');
    },
    breakpoints: {}
  });
  let builderDisposals = 0;
  const adapter = new Adapter({
    isTrusted: () => true,
    getProject: async () => ({ debug: { elf: __filename } }),
    createResources: async () => ({ backend }),
    builder: {
      build: async () => {},
      stop: async () => {},
      dispose: async () => {
        builderDisposals++;
      }
    },
    sources: { load: async () => [new SourceMap(__filename, 0x7c00, [])] },
    decoder: {}
  });
  adapter.onDidSendMessage((message) => messages.push(message));
  return { adapter, backend, messages, builderDisposals: () => builderDisposals };
}

for (const Adapter of [AssemblyDapAdapter, SourceDapAdapter]) {
  test(`${Adapter.name}: stop failure still terminates after cleanup and preserves requests`, async () => {
    const h = harness(Adapter);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    h.backend.dispose = async () => {
      await gate;
      throw new Error('owned cleanup failed');
    };
    h.adapter.resources.owned = { backend: h.backend };
    const stopping = h.adapter.channel.fail(new Error('stopped handler failed'));
    await turn();
    assert.equal(
      h.messages.some((message) => message.event === 'terminated'),
      false
    );
    release();
    await stopping;
    assert.equal(h.messages.filter((message) => message.event === 'terminated').length, 1);
    assert(h.messages.some((message) => /owned cleanup failed/.test(message.body?.output)));
    h.adapter.handleMessage({ type: 'request', seq: 1, command: 'threads' });
    await h.adapter.channel.queue;
    assert(h.messages.some((message) => message.request_seq === 1 && message.success));
    await assert.rejects(h.adapter.dispose(), /owned cleanup failed/);
    assert.equal(h.builderDisposals(), 1);
  });

  test(`${Adapter.name}: disposal attempts the builder even when backend cleanup fails`, async () => {
    const h = harness(Adapter);
    h.adapter.resources.owned = { backend: h.backend };
    await assert.rejects(h.adapter.dispose(), /owned cleanup failed/);
    assert.equal(h.builderDisposals(), 1);
    assert.equal(h.messages.filter((message) => message.event === 'terminated').length, 1);
  });

  test(`${Adapter.name}: natural exit reports cleanup failure without an unhandled rejection`, async () => {
    const h = harness(Adapter);
    await h.adapter.prepare({});
    h.backend.emit('terminated', {});
    await turn();
    await turn();
    assert.equal(h.messages.filter((message) => message.event === 'terminated').length, 1);
    assert(
      h.messages.some(
        (message) => message.body?.category === 'stderr' && /owned cleanup failed/.test(message.body.output)
      )
    );
    await assert.rejects(h.adapter.dispose(), /owned cleanup failed/);
    assert.equal(h.builderDisposals(), 1);
  });
}
