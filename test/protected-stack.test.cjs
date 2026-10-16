// White-box state fixtures install ownership as well as a backend.
function ownBackend(adapter, backend) { adapter.resources.owned = { backend }; return backend; }
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AssemblyDebugAdapter } = require('../dist/debug/adapter');
const { SourceMap } = require('../dist/debug/listing');
const { SourceMaps } = require('../dist/debug/maps');

// An expand-down SS is a conventional protected-mode stack whose valid offsets
// are above its limit. The limit protects the low memory below the stack.
function fixture(t, changes = {}) {
  const registers = {
    cr0: 0x11, cr2: 0, cr3: 0, cr4: 0, efer: 0, eflags: 2,
    cs: 8, cs_base: 0, cs_limit: 0xffffffff, cs_flags: 0xcf9b00,
    ss: 24, ss_base: 0, ss_limit: 0x7ffff, ss_flags: 0xc09700,
    ds: 16, ds_base: 0, ds_limit: 0xffffffff, ds_flags: 0xcf9300,
    es: 16, es_base: 0, es_limit: 0xffffffff, es_flags: 0xcf9300,
    fs: 16, fs_base: 0, fs_limit: 0xffffffff, fs_flags: 0xcf9300,
    gs: 16, gs_base: 0, gs_limit: 0xffffffff, gs_flags: 0xcf9300,
    eip: 0x8020, esp: 0x8ffec, ebp: 0x8ffec, eax: 0x11223344,
    ecx: 0, edx: 0, ebx: 0x11223344, esi: 0, edi: 0,
    ...changes
  };
  const memory = Buffer.alloc(0x90040);
  memory.set([0xe8, 0x0b, 0, 0, 0], 0x8000); // call outer; return 0x8005
  memory.set([0xe8, 0x0b, 0, 0, 0], 0x8010); // call nested; return 0x8015
  memory[0x8005] = memory[0x8015] = memory[0x8020] = 0x90;
  memory.writeUInt32LE(0x8fff8, 0x8ffec); // nested frame's saved EBP
  memory.writeUInt32LE(0x8015, 0x8fff0); // nested return EIP
  memory.writeUInt32LE(0x11223344, 0x8fff4); // nested argument
  memory.writeUInt32LE(0, 0x8fff8); // outermost EBP
  memory.writeUInt32LE(0x8005, 0x8fffc); // outer return EIP
  const reads = [];
  const runtime = {
    installed: [], resumes: 0,
    async registers() { return { ...registers }; },
    async readMemory(address, count) {
      reads.push({ address, count });
      assert(address >= 0 && address + count <= memory.length);
      return memory.subarray(address, address + count);
    },
    async setBreakpoints(addresses) { this.installed = [...addresses]; },
    async resume() { this.resumes++; },
    async dispose() {}
  };
  const map = new SourceMap('stage2.asm', 0x8000, [
    { line: 3, address: 0x8000, size: 5, text: 'call outer', bits: 32 },
    { line: 4, address: 0x8005, size: 1, text: 'nop', bits: 32 },
    { line: 10, address: 0x8010, size: 5, text: 'call nested', bits: 32 },
    { line: 11, address: 0x8015, size: 1, text: 'nop', bits: 32 },
    { line: 20, address: 0x8020, size: 1, text: 'nop', bits: 32 }
  ], 0x21);
  const adapter = new AssemblyDebugAdapter({ isTrusted: () => true, getProject: async () => { throw new Error('unused'); } });
  ownBackend(adapter, runtime);
  adapter.sources.map = map;
  adapter.sources.maps = new SourceMaps([map]);
  adapter.phase = 'stopped';
  let sequence = 1;
  t.after(() => adapter.dispose());
  async function request(command, args = {}) {
    const seq = sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { subscription.dispose(); reject(new Error(`Timed out: ${command}`)); }, 2000);
      const subscription = adapter.onDidSendMessage(message => {
        if (message.type !== 'response' || message.request_seq !== seq) return;
        clearTimeout(timer);
        subscription.dispose();
        resolve(message);
      });
      adapter.handleMessage({ seq, type: 'request', command, arguments: args });
    });
  }
  return { request, runtime, reads };
}

test('32-bit expand-down SS exposes real stack words, both EBP callers and stepOut', async t => {
  const c = fixture(t);
  const stack = await c.request('variables', { variablesReference: 2 });
  assert.equal(stack.success, true);
  assert.equal(stack.body.variables.length, 16);
  assert.deepEqual(stack.body.variables.slice(0, 5).map(slot => Number(slot.value)), [0x8fff8, 0x8015, 0x11223344, 0, 0x8005]);
  assert.equal(Number(stack.body.variables[0].memoryReference), 0x8ffec);
  assert.match(stack.body.variables[0].name, /ESP/);
  assert.equal(stack.body.variables[0].type, 'uint32（小端）');
  const trace = await c.request('stackTrace');
  assert.equal(trace.success, true);
  assert.deepEqual(trace.body.stackFrames.map(frame => Number(frame.instructionPointerReference)), [0x8020, 0x8015, 0x8005]);
  const out = await c.request('stepOut');
  assert.equal(out.success, true);
  assert.deepEqual(c.runtime.installed, [0x8015]);
  assert.equal(c.runtime.resumes, 1);
});

test('ESP below an expand-down SS limit cannot expose memory or infer EBP callers', async t => {
  // EBP still resembles a plausible valid frame, so an ESP range failure must
  // block unwinding before following any frame pointers from the stale stack.
  const c = fixture(t, { esp: 0x7fffc });
  const stack = await c.request('variables', { variablesReference: 2 });
  assert.equal(stack.success, true);
  assert.deepEqual(stack.body.variables, []);
  const trace = await c.request('stackTrace');
  assert.equal(trace.success, true);
  assert.deepEqual(trace.body.stackFrames.map(frame => Number(frame.instructionPointerReference)), [0x8020]);
  assert.deepEqual(c.reads, [], 'an invalid SS:ESP must not read stack or return-site code');
  const out = await c.request('stepOut');
  assert.equal(out.success, false);
  assert.deepEqual(c.runtime.installed, []);
  assert.equal(c.runtime.resumes, 0);
});
