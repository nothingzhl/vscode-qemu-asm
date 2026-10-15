const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GdbRuntime, validateDebugElf, gdbPathQuote } = require('../dist/debug/gdbRuntime');
const { parseMiRecord } = require('../dist/debug/mi');

function runtime(t, respond) {
  const calls = [];
  const instance = new GdbRuntime({ root: '.', qemuArgs: [] }, () => {});
  let queue = Promise.resolve();
  let disposed = false;
  const fake = {
    transaction(operation) {
      const task = queue.then(() => operation(async command => { calls.push(command); return respond(command, instance); }));
      queue = task.catch(() => {});
      return task;
    },
    async dispose() { disposed = true; },
  };
  instance.client = fake;
  t.after(() => instance.dispose());
  return { instance, calls, get disposed() { return disposed; } };
}

function packetPayload(command) {
  const outer = command.slice('-interpreter-exec console '.length);
  const consoleCommand = parseMiRecord('~' + outer).text;
  return consoleCommand.slice('maintenance packet '.length);
}
function reply(value) { return { type: 'result', class: 'done', results: {}, console: `sending: dummy\nreceived: "${value}"\n` }; }

test('GDB physical memory bypasses caches and restores virtual mode before concurrent virtual reads', async t => {
  const values = { 'qqemu.PhyMemMode': '0', 'Qqemu.PhyMemMode:1': 'OK', 'm1000,4': '01020304', 'Qqemu.PhyMemMode:0': 'OK' };
  const { instance, calls } = runtime(t, async command => {
    if (command.startsWith('-data-read-memory-bytes')) return { results: { memory: [{ begin: '0x2000', contents: '05060708' }] } };
    await new Promise(resolve => setImmediate(resolve));
    return reply(values[packetPayload(command)]);
  });
  const [physical, virtual] = await Promise.all([instance.readPhysicalMemory(0x1000, 4), instance.readMemory(0x2000, 4)]);
  assert.equal(physical.toString('hex'), '01020304');
  assert.equal(virtual.toString('hex'), '05060708');
  assert.deepEqual(calls.slice(0, 4).map(packetPayload), ['qqemu.PhyMemMode', 'Qqemu.PhyMemMode:1', 'm1000,4', 'Qqemu.PhyMemMode:0']);
  assert.match(calls[4], /-data-read-memory-bytes/);
});

test('GDB physical memory restores after read or switch failure; unsupported mode never switches', async t => {
  for (const fail of ['read', 'switch', 'unsupported']) {
    const { instance, calls } = runtime(t, command => {
      const payload = packetPayload(command);
      if (payload === 'qqemu.PhyMemMode') return reply(fail === 'unsupported' ? '' : '0');
      if (payload === 'Qqemu.PhyMemMode:1') return reply(fail === 'switch' ? 'E22' : 'OK');
      if (payload.startsWith('m')) return reply('E14');
      return reply('OK');
    });
    await assert.rejects(instance.readPhysicalMemory(0x1000, 4), fail === 'unsupported' ? /不支持/ : fail === 'switch' ? /无法启用/ : /不完整/);
    const packets = calls.map(packetPayload);
    assert.equal(packets.includes('Qqemu.PhyMemMode:0'), fail !== 'unsupported');
    assert.equal(packets.includes('Qqemu.PhyMemMode:1'), fail !== 'unsupported');
  }
});

test('GDB physical restore failure terminates and disposes the uncertain address mode', async t => {
  const fake = runtime(t, command => {
    const payload = packetPayload(command);
    return reply(payload === 'qqemu.PhyMemMode' ? '0' : payload.startsWith('m') ? 'aabbccdd' : payload.endsWith(':1') ? 'OK' : 'E22');
  });
  let terminated = 0;
  fake.instance.on('terminated', () => terminated++);
  await assert.rejects(fake.instance.readPhysicalMemory(0, 4), /无法恢复虚拟地址模式/);
  await fake.instance.dispose();
  assert.equal(terminated, 1);
  assert.equal(fake.disposed, true);
  await assert.rejects(fake.instance.readMemory(0, 4), /已经结束/);
});

test('GDB memory rejects holes, bounds and running CPU; failed memory does not corrupt state', async t => {
  const { instance, calls } = runtime(t, () => ({ results: { memory: [{ begin: '0x1001', contents: 'aabb' }] } }));
  await assert.rejects(instance.readMemory(0x1000, 2), /不连续/);
  for (const args of [[-1, 1], [0xffffffff, 2], [0, 65537], [0, -1]]) await assert.rejects(instance.readMemory(...args), /内存/);
  assert.equal(calls.length, 1);
  instance.running = true;
  await assert.rejects(instance.readPhysicalMemory(0, 4), /先暂停/);
  assert.equal(calls.length, 1);
});

test('GDB exec state is set before command and a fast stop stays stopped after its result', async t => {
  const { instance } = runtime(t, (_, self) => {
    assert.equal(self.isRunning(), true);
    self.record({ type: 'exec', class: 'stopped', results: { reason: 'end-stepping-range' } });
    return { type: 'result', class: 'running', results: {} };
  });
  await instance.mi('-exec-next');
  assert.equal(instance.isRunning(), false);
});

test('GDB filters one unchanged residual watch SIGTRAP and preserves same-PC register progress', async t => {
  const trap = { reason: 'signal-received', 'signal-name': 'SIGTRAP' };
  for (const changed of [false, true]) {
    const { instance, calls } = runtime(t, () => ({ type: 'result', class: 'running', results: {} }));
    instance.watchResume = { command: '-exec-next', registers: { eip: 0x1000, eax: 1, ecx: 3 } };
    instance.readRegisters = async () => ({ eip: 0x1000, eax: 1, ecx: changed ? 2 : 3 });
    let visible = 0;
    instance.on('stopped', () => visible++);
    await instance.handleStop(trap);
    assert.deepEqual(calls, changed ? [] : ['-exec-next']);
    assert.equal(visible, changed ? 1 : 0);
    if (!changed) {
      // 不能反复吞掉后续的 SIGTRAP，第二次必须交付给用户。
      await instance.handleStop(trap);
      assert.equal(visible, 1);
      assert.equal(calls.length, 1);
    }
  }
});

test('GDB residual watch filtering respects pause requested during the register read', async t => {
  const { instance, calls } = runtime(t, () => { throw new Error('pause must not resume'); });
  instance.watchResume = { command: '-exec-continue', registers: { eip: 0x1000, eax: 1 } };
  instance.readRegisters = async () => { instance.pauseRequested = true; return { eip: 0x1000, eax: 1 }; };
  let visible = 0;
  instance.on('stopped', () => visible++);
  await instance.handleStop({ reason: 'signal-received', 'signal-name': 'SIGTRAP' });
  assert.equal(visible, 1);
  assert.equal(calls.length, 0);
});

test('GDB pause during residual-trap inspection waits for stop without interrupting an already stopped CPU', async t => {
  const { instance, calls } = runtime(t, () => { throw new Error('already physically stopped'); });
  instance.running = true;
  instance.physicalStopped = true;
  instance.watchResume = { command: '-exec-continue', registers: { eip: 0x1000, eax: 1 } };
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  instance.readRegisters = async () => { enter(); await gate; return { eip: 0x1000, eax: 1 }; };
  const handling = instance.handleStop({ reason: 'signal-received', 'signal-name': 'SIGTRAP' });
  await entered;
  const paused = instance.pause();
  release();
  await Promise.all([handling, paused]);
  assert.equal(instance.isRunning(), false);
  assert.equal(calls.length, 0);
});

function elf() {
  const names = Buffer.from('\0.shstrtab\0.debug_info\0.debug_line\0');
  const header = Buffer.alloc(52);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]).copy(header);
  header.writeUInt16LE(2, 16); header.writeUInt16LE(3, 18); header.writeUInt16LE(52, 40);
  header.writeUInt32LE(52, 32); header.writeUInt16LE(40, 46); header.writeUInt16LE(4, 48); header.writeUInt16LE(1, 50);
  const sections = Buffer.alloc(160);
  for (const [index, name, offset, size] of [[1, 1, 212, names.length], [2, 11, 212 + names.length, 1], [3, 23, 213 + names.length, 1]]) {
    const pos = index * 40; sections.writeUInt32LE(name, pos); sections.writeUInt32LE(1, pos + 4); sections.writeUInt32LE(offset, pos + 16); sections.writeUInt32LE(size, pos + 20);
  }
  return Buffer.concat([header, sections, names, Buffer.from([1, 1])]);
}

test('ELF validation requires little-endian i386 ET_EXEC and bounded nonempty DWARF sections', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdb elf validation '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'kernel.elf');
  await fs.writeFile(file, elf());
  await validateDebugElf(file);
  for (const mutate of [b => { b[4] = 2; }, b => { b[5] = 2; }, b => b.writeUInt16LE(62, 18), b => b.writeUInt16LE(3, 16), b => b.writeUInt32LE(0xffffffff, 32), b => b.writeUInt32LE(0, 52 + 2 * 40 + 20)]) {
    const bytes = elf(); mutate(bytes); await fs.writeFile(file, bytes);
    await assert.rejects(validateDebugElf(file), /ELF|DWARF|ET_EXEC/);
  }
  await assert.rejects(validateDebugElf(dir), /ELF32/);
});

test('GDB CLI path quoting preserves Unicode and escapes CLI delimiters without line injection', () => {
  assert.equal(gdbPathQuote('C:\\源,"码" path'), '"C:\\\\源,\\"码\\" path"');
  for (const value of ['a\nb', 'a\rb', 'a\0b', 'a\tb']) assert.throws(() => gdbPathQuote(value), /控制字符/);
});
