const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../dist/core');
const runtimeModule = require('../dist/debug/runtime');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');
const { SourceMap } = require('../dist/debug/listing');

// Unit regressions for queue/lifecycle decisions only. These controlled runtimes
// do not replace the separate real NASM/QEMU and VS Code host integration tests.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function client(t, options = {}) {
  const adapter = new AssemblyDebugAdapter({ isTrusted: () => true, getProject: async () => { throw new Error('unused project'); }, ...options });
  const messages = [];
  const listener = adapter.onDidSendMessage(message => messages.push(message));
  let sequence = 1;
  t.after(async () => { await adapter.dispose(); listener.dispose(); });
  return {
    adapter, messages,
    request(command, args = {}) {
      const seq = sequence++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Timed out: ${command}`)); }, 2000);
        const subscription = adapter.onDidSendMessage(message => {
          if (message.type !== 'response' || message.request_seq !== seq) return;
          clearTimeout(timer); subscription.dispose(); resolve(message);
        });
        adapter.handleMessage({ seq, type: 'request', command, arguments: args });
      });
    },
    async settled() { await turn(); await adapter.queue; }
  };
}

class ControlledRuntime extends EventEmitter {
  running = false;
  resumes = 0;
  pauses = 0;
  disposals = 0;
  installed = [];
  address = 0x7c00;
  pauseEvent = { reason: 'pause', signal: 2 };
  async launch() { this.emit('stopped', { reason: 'entry' }); }
  async registers() {
    assert.equal(this.running, false, 'register access must not race a resume');
    return { cs: 0, ss: 0, eip: this.address, esp: 0x7bfa, ebp: 0, eflags: 2 };
  }
  async setBreakpoints(addresses) {
    assert.equal(this.running, false, 'breakpoint changes require a stopped CPU');
    this.installed = [...addresses];
  }
  async resume() {
    assert.equal(this.running, false);
    this.resumes++; this.running = true;
  }
  async pause() {
    this.pauses++;
    if (this.running) this.stop(this.pauseEvent);
  }
  stop(event) { this.running = false; this.emit('stopped', event); }
  async dispose() { this.disposals++; this.running = false; }
}

async function configured(t) {
  const fixture = path.join(__dirname, 'fixtures', 'debug-boot.asm');
  const listing = await fs.readFile(path.join(__dirname, 'fixtures', 'debug-boot.lst'), 'utf8');
  const runtime = new ControlledRuntime();
  // Only the process/build boundaries are replaced; prepare(), listener setup,
  // source-map parsing, DAP requests and the adapter's queue execute unchanged.
  t.mock.method(core, 'build', async (_project, _processes, _log, _cancelled, listingPath) => {
    await fs.writeFile(listingPath, listing);
    return { units: [{ source: fixture, loadAddress: 0x7c00, lba: 0, size: 512, listingPath }], imageBytes: 512 };
  });
  t.mock.method(runtimeModule, 'DebugRuntime', function () { return runtime; });
  const c = client(t, { getProject: async () => ({ source: fixture }) });
  assert.equal((await c.request('launch')).success, true);
  assert.equal((await c.request('configurationDone')).success, true);
  runtime.stop({ reason: 'breakpoint', signal: 5 });
  await c.settled();
  assert.equal(c.messages.filter(message => message.event === 'stopped').at(-1).body.reason, 'entry');
  return { ...c, runtime, fixture };
}

test('concurrent finish/dispose callers all wait for the same owned-runtime cleanup', async t => {
  const c = client(t);
  const gate = deferred();
  let cleaned = false;
  let disposals = 0;
  c.adapter.runtime = { dispose: async () => { disposals++; await gate.promise; cleaned = true; } };
  c.adapter.phase = 'stopped';
  const finishing = c.adapter.finish();
  let returned = false;
  const disposing = c.adapter.dispose().then(() => { returned = true; });
  const disposingAgain = c.adapter.dispose();
  try {
    await turn();
    assert.equal(returned, false, 'dispose must not return while earlier finish still owns a live runtime');
    assert.equal(cleaned, false);
    assert.equal(c.messages.filter(message => message.event === 'terminated').length, 0);
  } finally { gate.resolve(); }
  await Promise.all([finishing, disposing, disposingAgain]);
  assert.equal(disposals, 1);
  assert.equal(cleaned, true);
  assert.equal(c.messages.filter(message => message.event === 'terminated').length, 1);
});

test('restart during termination waits for cleanup and cannot create a new session', async t => {
  let reads = 0;
  const c = client(t, { getProject: async () => { reads++; throw new Error('must not relaunch'); } });
  const gate = deferred();
  c.adapter.runtime = { dispose: () => gate.promise };
  c.adapter.phase = 'stopped';
  const finishing = c.adapter.finish();
  let response;
  const restarting = c.request('restart').then(result => { response = result; return result; });
  try {
    await turn();
    assert.equal(response, undefined, 'restart must await already-running termination cleanup');
  } finally { gate.resolve(); }
  const result = await restarting;
  await finishing;
  assert.equal(result.success, false);
  assert.match(result.message, /已结束/);
  assert.equal(reads, 0);
  assert.equal(c.messages.filter(message => message.event === 'initialized').length, 0);
  assert.equal(c.messages.filter(message => message.event === 'terminated').length, 1);
});

test('a natural stop ahead of a queued breakpoint update stays stopped until the user resumes', async t => {
  const c = await configured(t);
  assert.equal((await c.request('continue')).success, true);
  const resumed = c.runtime.resumes;
  const baseline = c.messages.length;
  const gate = deferred();
  c.adapter.queue = gate.promise;
  const updating = c.request('setBreakpoints', { source: { path: c.fixture }, breakpoints: [{ line: 4 }] });
  c.runtime.stop({ reason: 'breakpoint', signal: 5 });
  // The physical stop must become visible before the queued request executes.
  const physicalStopPhase = c.adapter.phase;
  gate.resolve();
  assert.equal((await updating).success, true);
  await c.settled();
  assert.equal(physicalStopPhase, 'stopped');
  assert.equal(c.runtime.resumes, resumed);
  assert.equal(c.runtime.running, false);
  assert.equal(c.adapter.phase, 'stopped');
  const events = c.messages.slice(baseline).filter(message => message.type === 'event');
  assert.equal(events.some(message => message.event === 'continued' || message.event === 'terminated'), false);
  assert.equal(events.find(message => message.event === 'stopped').body.reason, 'breakpoint');
});

test('a natural breakpoint while internally pausing is reported instead of auto-resumed', async t => {
  const c = await configured(t);
  assert.equal((await c.request('continue')).success, true);
  c.runtime.pauseEvent = { reason: 'breakpoint', signal: 5 };
  const resumed = c.runtime.resumes;
  const baseline = c.messages.length;
  const result = await c.request('setBreakpoints', { source: { path: c.fixture }, breakpoints: [{ line: 4 }] });
  await c.settled();
  assert.equal(result.success, true);
  assert.equal(c.runtime.pauses, 1);
  assert.equal(c.runtime.resumes, resumed);
  assert.equal(c.runtime.running, false);
  assert.equal(c.messages.slice(baseline).find(message => message.event === 'stopped').body.reason, 'breakpoint');
  assert.equal(c.messages.slice(baseline).some(message => message.event === 'terminated'), false);
});

test('an ordinary internal pause updates breakpoints and resumes without a user-visible stop', async t => {
  const c = await configured(t);
  assert.equal((await c.request('continue')).success, true);
  const resumed = c.runtime.resumes;
  const baseline = c.messages.length;
  const result = await c.request('setBreakpoints', { source: { path: c.fixture }, breakpoints: [{ line: 4 }] });
  await c.settled();
  assert.equal(result.success, true);
  assert.equal(c.runtime.resumes, resumed + 1);
  assert.equal(c.runtime.running, true);
  assert.equal(c.messages.slice(baseline).some(message => message.event === 'stopped' || message.event === 'terminated'), false);
});

test('a stale stack refresh queued behind continue returns no expired frames or register reads', async t => {
  const c = await configured(t);
  assert.equal((await c.request('continue')).success, true);
  const resumes = c.runtime.resumes;
  const result = await c.request('stackTrace', { threadId: 1 });
  assert.equal(result.success, true);
  assert.deepEqual(result.body, { stackFrames: [], totalFrames: 0 });
  const scopes = await c.request('scopes', { frameId: 1 });
  assert.equal(scopes.success, true);
  assert.deepEqual(scopes.body.scopes, []);
  const variables = await c.request('variables', { variablesReference: 1 });
  assert.equal(variables.success, true);
  assert.deepEqual(variables.body.variables, []);
  const watch = await c.request('evaluate', { expression: 'eax', context: 'watch' });
  assert.equal(watch.success, true);
  assert.match(watch.body.result, /未暂停/);
  assert.equal(c.runtime.resumes, resumes);
  assert.equal(c.runtime.running, true);
});

function stackRuntime(returnAddress, previousBP, opcode) {
  return {
    installed: [], resumes: 0,
    async registers() { return { cs: 0, ss: 0, eip: 0x7c20, esp: 0x7bfa, ebp: 0x7bfc }; },
    async readMemory(address, count) {
      if (address === 0x7bfc) {
        const words = Buffer.alloc(4); words.writeUInt16LE(previousBP); words.writeUInt16LE(returnAddress, 2); return words;
      }
      return Buffer.from(opcode).subarray(0, count);
    },
    async setBreakpoints(addresses) { this.installed = [...addresses]; },
    async resume() { this.resumes++; },
    async dispose() {}
  };
}

test('BP candidates inside an instruction, after a non-CALL or with an invalid saved BP cannot drive stepOut', async t => {
  for (const candidate of [
    { address: 0x7c01, previous: 0, opcode: [0xe8, 0] },
    { address: 0x7c03, previous: 0, opcode: [0x90, 0] },
    { address: 0x7c03, previous: 0x7bfc, opcode: [0xe8, 0] },
    { address: 0x7c03, previous: 0x7b00, opcode: [0xe8, 0] },
    { address: 0x7c03, previous: 0xfffd, opcode: [0xe8, 0] }
  ]) {
    const c = client(t);
    c.adapter.phase = 'stopped';
    c.adapter.map = new SourceMap('boot.asm', 0x7c00, [
      { line: 3, address: 0x7c00, size: 3, text: 'call worker' },
      { line: 4, address: 0x7c03, size: 2, text: 'mov ax, bx' },
      { line: 8, address: 0x7c20, size: 1, text: 'ret' }
    ]);
    const runtime = c.adapter.runtime = stackRuntime(candidate.address, candidate.previous, candidate.opcode);
    const trace = await c.request('stackTrace');
    assert.equal(trace.success, true);
    assert.equal(trace.body.stackFrames.length, 1, JSON.stringify(candidate));
    const result = await c.request('stepOut');
    assert.equal(result.success, false, JSON.stringify(candidate));
    assert.match(result.message, /没有可验证的 BP/);
    assert.deepEqual(runtime.installed, []);
    assert.equal(runtime.resumes, 0);
  }
});

test('a valid 16-bit near-CALL BP chain allows stepOut to its exact return instruction', async t => {
  const c = client(t);
  c.adapter.phase = 'stopped';
  c.adapter.map = new SourceMap('boot.asm', 0x7c00, [
    { line: 3, address: 0x7c00, size: 3, text: 'call worker' },
    { line: 4, address: 0x7c03, size: 1, text: 'nop' },
    { line: 8, address: 0x7c20, size: 1, text: 'ret' }
  ]);
  const runtime = c.adapter.runtime = stackRuntime(0x7c03, 0, [0xe8, 0]);
  const trace = await c.request('stackTrace');
  assert.equal(trace.body.stackFrames.length, 2);
  assert.equal(trace.body.stackFrames[1].instructionPointerReference, '0x7C03');
  assert.equal((await c.request('stepOut')).success, true);
  assert.deepEqual(runtime.installed, [0x7c03]);
  assert.equal(runtime.resumes, 1);
});
