const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DebugRuntime } = require('../dist/debug/runtime');
const { GdbRuntime } = require('../dist/debug/gdbRuntime');
const { MiClient, parseMiRecord } = require('../dist/debug/mi');
const { localHost } = require('../dist/platform/host');

const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
const validMonitor = ['ES', 'CS', 'SS', 'DS', 'FS', 'GS'].map(name => `${name} =0000 00000000 0000ffff 00009300`).join('\n') + '\nCR0=00000010\n';
function project() {
  return { root: process.cwd(), image: path.resolve('capability guest.img'), nasm: process.execPath, qemu: process.execPath, qemuArgs: ['-m', '32M'], debug: { gdb: process.execPath, elf: path.resolve('capability guest.elf') } };
}
const entry = (runtime, id) => runtime.capabilities.snapshot().entries.find(item => item.id === id);
function miReply(value) { return { type: 'result', class: 'done', results: {}, console: `received: "${value}"\n` }; }

/** Samples exercise each existing transport; they do not replace real QEMU integration. */
function fixture(t, backend, options = {}) {
  const instance = backend === 'rsp' ? new DebugRuntime(project(), () => {}) : new GdbRuntime(project(), () => {});
  const packets = [];
  let closed = false;
  const command = async payload => {
    packets.push(payload);
    if (options.respond) {
      const result = await options.respond(payload);
      if (result !== undefined) return result;
    }
    if (payload === 'qqemu.PhyMemMode') return options.query ?? '0';
    if (payload === 'Qqemu.PhyMemMode:1') return options.enable ?? 'OK';
    if (payload === 'Qqemu.PhyMemMode:0') return options.restore ?? 'OK';
    if (payload.startsWith('m')) return options.read ?? Buffer.alloc(parseInt(payload.split(',')[1], 16), 0x5a).toString('hex');
    throw new Error(`Unexpected sample packet: ${payload}`);
  };
  const fake = backend === 'rsp' ? {
    transaction: operation => operation(command), command,
    close() { closed = true; },
  } : {
    transaction: operation => operation(async request => {
      const consoleCommand = parseMiRecord('~' + request.slice('-interpreter-exec console '.length)).text;
      return miReply(await command(consoleCommand.slice('maintenance packet '.length)));
    }),
    async dispose() { closed = true; },
  };
  instance.client = fake;
  t.after(() => instance.dispose());
  return { instance, options, packets, get closed() { return closed; } };
}

test('runtime capability scopes are independent and describe only their selected backend tools', async t => {
  const config = project();
  const asm = new DebugRuntime(config, () => {});
  const c = new GdbRuntime(config, () => {});
  const restarted = new DebugRuntime(config, () => {});
  t.after(() => Promise.all([asm.dispose(), c.dispose(), restarted.dispose()]));
  const a = asm.capabilities.snapshot();
  const b = c.capabilities.snapshot();
  assert.equal(a.scope.backend, 'nasm-rsp');
  assert.equal(b.scope.backend, 'c-gdb-mi');
  assert.equal(a.scope.targetId, config.image);
  assert.deepEqual(a.scope.host, localHost.identity);
  assert.deepEqual(a.scope.machine, ['-m', '32M']);
  assert.deepEqual(Object.keys(a.scope.tools).sort(), ['nasm', 'qemu']);
  assert.deepEqual(Object.keys(b.scope.tools).sort(), ['gdb', 'qemu']);
  assert.notEqual(a.scope.sessionId, b.scope.sessionId);
  assert.notEqual(a.scope.sessionId, restarted.capabilities.snapshot().scope.sessionId);
  for (const report of [a, b]) assert(report.entries.every(item => item.state === 'unknown' && item.evidence === 'not-checked'));
  config.qemuArgs.push('-cpu', 'qemu32');
  assert.deepEqual(asm.capabilities.snapshot().scope.machine, ['-m', '32M']);
});

test('actual tool binding copies launch entries and becomes immutable after an observation', async t => {
  const f = fixture(t, 'rsp');
  const launched = { qemu: path.resolve('actual tool path', 'qemu') };
  f.instance.capabilities.bindTools(launched);
  launched.qemu = 'changed externally';
  assert.equal(f.instance.capabilities.snapshot().scope.tools.qemu, path.resolve('actual tool path', 'qemu'));
  await f.instance.readPhysicalMemory(0, 1);
  assert.throws(() => f.instance.capabilities.bindTools({ qemu: 'different target' }), /新的能力报告/);
});

test('GDB runtime disposal cancels before a prompt and waits for startup process cleanup', { timeout: 2000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gdb startup cancellation '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A valid read-only ELF fixture lets launch reach MI startup without a compiler.
  const strings = Buffer.from('\0.shstrtab\0.debug_info\0.debug_line\0');
  const header = Buffer.alloc(52);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]).copy(header);
  header.writeUInt16LE(2, 16); header.writeUInt16LE(3, 18); header.writeUInt16LE(52, 40);
  header.writeUInt32LE(52, 32); header.writeUInt16LE(40, 46); header.writeUInt16LE(4, 48); header.writeUInt16LE(1, 50);
  const sections = Buffer.alloc(160);
  for (const [index, name, offset, size] of [[1, 1, 212, strings.length], [2, 11, 212 + strings.length, 1], [3, 23, 213 + strings.length, 1]]) {
    const position = index * 40;
    sections.writeUInt32LE(name, position); sections.writeUInt32LE(1, position + 4);
    sections.writeUInt32LE(offset, position + 16); sections.writeUInt32LE(size, position + 20);
  }
  const elf = path.join(root, 'kernel.elf');
  await fs.writeFile(elf, Buffer.concat([header, sections, strings, Buffer.from([1, 1])]));
  const instance = new GdbRuntime({ ...project(), root, debug: { elf, gdb: process.execPath } }, () => {});
  let disposed = 0;
  const processBoundary = {
    start() { return { child: {}, ready: Promise.resolve(), done: new Promise(() => {}), tool: { executable: process.execPath } }; },
    async dispose() { disposed++; },
  };
  instance.machine = {
    async start() { const run = processBoundary.start(); await run.ready; return { executable: run.tool.executable, debugEndpoint: {host: '127.0.0.1',port: 1234}, exited: run.done }; },
    dispose: () => processBoundary.dispose(),
  };
  const originalStart = MiClient.start;
  let entered, signal, aborted, releaseCleanup;
  const starting = new Promise(resolve => { entered = resolve; });
  const aborting = new Promise(resolve => { aborted = resolve; });
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  MiClient.start = async (_executable, _args, _cwd, timeout, cancellation) => {
    assert.equal(timeout, 15000);
    assert(cancellation instanceof AbortSignal);
    signal = cancellation;
    entered();
    return new Promise((_resolve, reject) => cancellation.addEventListener('abort', async () => {
      aborted();
      await cleanup;
      reject(new Error('GDB 启动已取消'));
    }, { once: true }));
  };
  t.after(async () => { MiClient.start = originalStart; releaseCleanup(); await instance.dispose(); });
  const launching = instance.launch();
  const rejected = assert.rejects(launching, /启动已取消/);
  await starting;
  assert.equal(instance.client, undefined);
  let finished = false;
  const stopping = instance.dispose().then(() => { finished = true; });
  await aborting;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'runtime stop returned before the pending GDB startup cleaned its process');
  releaseCleanup();
  await stopping;
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(disposed, 1);
  assert.equal(entry(instance, 'gdb.mi').state, 'unknown');
});

for (const backend of ['rsp', 'mi']) {
  test(`${backend} physical support remains unknown for zero bytes and until a successful restore`, async t => {
    let release, restoring;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { restoring = resolve; });
    const f = fixture(t, backend, { respond: async packet => {
      if (packet === 'Qqemu.PhyMemMode:0') { restoring(); await gate; return 'OK'; }
    } });
    assert.deepEqual(await f.instance.readPhysicalMemory(0, 0), Buffer.alloc(0));
    assert.deepEqual(f.packets, []);
    assert.equal(entry(f.instance, 'qemu.physicalMemory').state, 'unknown');
    const reading = f.instance.readPhysicalMemory(0x1000, 4);
    await entered;
    assert.equal(entry(f.instance, 'qemu.physicalMemory').state, 'unknown');
    release();
    assert.deepEqual(await reading, Buffer.alloc(4, 0x5a));
    const observed = entry(f.instance, 'qemu.physicalMemory');
    assert.equal(observed.state, 'supported');
    assert.equal(observed.evidence, 'protocol');
    assert.equal(observed.details.bytesRead, 4);
    assert.equal(entry(f.instance, 'decoder').state, 'unknown');
    assert.equal(entry(f.instance, 'qemu.display').state, 'unknown');
  });

  test(`${backend} target memory access failures do not imply protocol incompatibility`, async t => {
    const f = fixture(t, backend, { read: 'E14' });
    await assert.rejects(f.instance.readPhysicalMemory(0x1000, 4), /不完整/);
    assert.equal(entry(f.instance, 'qemu.physicalMemory').state, 'unknown');
    assert.equal(f.packets.at(-1), 'Qqemu.PhyMemMode:0');
    delete f.options.read;
    await f.instance.readPhysicalMemory(0x1000, 4);
    assert.equal(entry(f.instance, 'qemu.physicalMemory').state, 'supported');
    f.options.read = 'E14';
    await assert.rejects(f.instance.readPhysicalMemory(0x2000, 4), /不完整/);
    assert.equal(entry(f.instance, 'qemu.physicalMemory').state, 'supported');
  });

  test(`${backend} physical protocol and mode failures retain concrete unsupported evidence`, async t => {
    for (const [options, reason] of [[{ query: '' }, /不支持/], [{ enable: 'E22' }, /物理内存/], [{ restore: 'E22' }, /恢复虚拟地址模式/]]) {
      const f = fixture(t, backend, options);
      await assert.rejects(f.instance.readPhysicalMemory(0, 4));
      const observed = entry(f.instance, 'qemu.physicalMemory');
      assert.equal(observed.state, 'unsupported');
      assert.equal(observed.evidence, 'protocol');
      assert.match(observed.reason, reason);
      assert.equal(f.packets.includes('Qqemu.PhyMemMode:1'), options.query !== '');
      if (options.restore) assert.equal(f.closed, true);
    }
  });

  test(`${backend} segment evidence requires monitor parsing and CPU mode validation`, async t => {
    const f = fixture(t, backend);
    let monitor = validMonitor;
    const values = names.map((_, index) => ({ number: String(index), value: '0x0' }));
    if (backend === 'rsp') {
      f.instance.layout = names.map((name, index) => ({ name, bits: 32, offset: index * 4, number: index }));
      f.instance.client.command = async request => request === 'g' ? Buffer.alloc(names.length * 4).toString('hex') : monitor;
    } else {
      f.instance.registerNames = names;
      f.instance.client.transaction = operation => operation(async request => request === '-data-list-register-values x' ? { results: { 'register-values': values } } : { console: monitor });
    }
    await f.instance.registers();
    assert.equal(entry(f.instance, 'qemu.segmentRegisters').state, 'supported');
    assert.equal(entry(f.instance, 'qemu.segmentRegisters').details.mode, 'real16');
    monitor = validMonitor.replace(/^CS =.*\n/m, '');
    await assert.rejects(f.instance.registers(), /CS 段缓存/);
    assert.equal(entry(f.instance, 'qemu.segmentRegisters').state, 'unsupported');
    monitor = validMonitor.replace('CR0=00000010', 'CR0=80000011 CR3=00001000 CR4=00000020');
    await assert.rejects(f.instance.registers(), /PAE/);
    assert.match(entry(f.instance, 'qemu.segmentRegisters').reason, /PAE/);
    assert.equal(entry(f.instance, 'gdb.mi').state, 'unknown', 'a sampled register read is not a GDB initialization test');
  });
}
