const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { RspClient } = require('../dist/debug/rsp');
const { DebugRuntime } = require('../dist/debug/runtime');

function packet(payload) {
  const bytes = Buffer.from(payload, 'latin1');
  const checksum = bytes.reduce((sum, byte) => (sum + byte) & 255, 0).toString(16).padStart(2, '0');
  return Buffer.concat([Buffer.from('$'), bytes, Buffer.from('#' + checksum)]);
}

async function fixture(t, options = {}) {
  let mode = options.mode ?? 0;
  const commands = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', data => {
      input += data.toString('latin1');
      while (input.length) {
        if (input.charCodeAt(0) === 3) { commands.push('interrupt'); input = input.slice(1); continue; }
        if (input[0] !== '$') { input = input.slice(1); continue; }
        const end = input.indexOf('#');
        if (end < 0 || input.length < end + 3) return;
        const request = input.slice(1, end);
        input = input.slice(end + 3);
        commands.push(request);
        socket.write('+');
        let reply;
        if (request === 'qqemu.PhyMemMode') reply = options.queryResponse ?? String(mode);
        else if (request === 'Qqemu.PhyMemMode:1') { mode = 1; reply = options.enableResponse ?? 'OK'; }
        else if (request === 'Qqemu.PhyMemMode:0') {
          reply = options.restoreResponse ?? 'OK';
          if (reply === 'OK') mode = 0;
        } else if (request[0] === 'm') {
          const size = parseInt(request.split(',')[1], 16);
          if (mode && options.readTimeout) continue;
          reply = mode && options.readResponse !== undefined ? options.readResponse : Buffer.alloc(size, mode ? 0x22 : 0x11).toString('hex');
        } else if (request === 'c' || request === 's') continue;
        else reply = mode ? 'physical' : 'virtual';
        socket.write(packet(reply));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const client = await RspClient.connect(server.address().port, '127.0.0.1', 1000, options.timeout ?? 1000);
  t.after(() => client.close());
  const runtime = new DebugRuntime({}, () => {});
  runtime.client = client;
  return { runtime, client, commands, mode: () => mode };
}

test('physical read atomically queries, changes mode, reads all chunks and restores before other requests or execution', async t => {
  const { runtime, client, commands, mode } = await fixture(t);
  const physical = runtime.readPhysicalMemory(0x2000, 513);
  const virtual = runtime.readMemory(0x2000, 1);
  const registers = client.command('g');
  const resume = client.resume();
  const interrupt = client.interrupt();
  assert.deepEqual(await physical, Buffer.alloc(513, 0x22));
  assert.deepEqual(await virtual, Buffer.from([0x11]));
  assert.equal(await registers, 'virtual');
  await Promise.all([resume, interrupt]);
  assert.equal(await client.command('after'), 'virtual');
  assert.deepEqual(commands, [
    'qqemu.PhyMemMode', 'Qqemu.PhyMemMode:1', 'm2000,200', 'm2200,1', 'Qqemu.PhyMemMode:0',
    'm2000,1', 'g', 'c', 'interrupt', 'after'
  ]);
  assert.equal(mode(), 0);
});

test('concurrent physical reads remain separate transactions and always leave virtual mode', async t => {
  const { runtime, commands, mode } = await fixture(t, { mode: 1 });
  const results = await Promise.all([runtime.readPhysicalMemory(0x1000, 1), runtime.readPhysicalMemory(0x2000, 1)]);
  assert.deepEqual(results, [Buffer.from([0x22]), Buffer.from([0x22])]);
  assert.deepEqual(commands, [
    'qqemu.PhyMemMode', 'Qqemu.PhyMemMode:1', 'm1000,1', 'Qqemu.PhyMemMode:0',
    'qqemu.PhyMemMode', 'Qqemu.PhyMemMode:1', 'm2000,1', 'Qqemu.PhyMemMode:0'
  ]);
  assert.equal(mode(), 0);
});

test('unsupported physical memory protocol fails without changing memory mode', async t => {
  const { runtime, commands, mode } = await fixture(t, { queryResponse: '' });
  await assert.rejects(runtime.readPhysicalMemory(0, 1), /不支持物理内存/);
  assert.deepEqual(await runtime.readMemory(0, 1), Buffer.from([0x11]));
  assert.deepEqual(commands, ['qqemu.PhyMemMode', 'm0,1']);
  assert.equal(mode(), 0);
});

for (const options of [{ readResponse: 'E14' }, { readResponse: 'aa' }, { enableResponse: 'E22' }]) {
  test('failed physical read or mode switch restores virtual mode: ' + JSON.stringify(options), async t => {
    const { runtime, client, commands, mode } = await fixture(t, options);
    await assert.rejects(runtime.readPhysicalMemory(0x1000, 4), /E14|不完整|E22/);
    assert.equal(commands.at(-1), 'Qqemu.PhyMemMode:0');
    assert.equal(await client.command('g'), 'virtual');
    assert.equal(mode(), 0);
  });
}

test('failed restoration closes connection before queued register and execution requests', async t => {
  const { runtime, client, commands } = await fixture(t, { restoreResponse: 'E22' });
  const physical = runtime.readPhysicalMemory(0, 1);
  const registers = client.command('g');
  const resume = client.resume();
  const results = await Promise.allSettled([physical, registers, resume]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /无法恢复虚拟地址模式/);
  for (const result of results.slice(1)) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /关闭/);
  }
  assert.deepEqual(commands, ['qqemu.PhyMemMode', 'Qqemu.PhyMemMode:1', 'm0,1', 'Qqemu.PhyMemMode:0']);
});

test('timeout during physical mode closes the connection and does not resume execution', async t => {
  const { runtime, client, commands } = await fixture(t, { readTimeout: true, timeout: 40 });
  const results = await Promise.allSettled([runtime.readPhysicalMemory(0, 1), client.resume()]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /无法恢复虚拟地址模式/);
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(commands, ['qqemu.PhyMemMode', 'Qqemu.PhyMemMode:1', 'm0,1']);
});

test('physical memory validation and stopped-state checks precede any packet', async t => {
  const { runtime, commands } = await fixture(t);
  assert.deepEqual(await runtime.readPhysicalMemory(0, 0), Buffer.alloc(0));
  for (const [address, count] of [[-1, 1], [0x100000000, 1], [0xffffffff, 2], [0, 65537], [0, -1], [0, 1.5]]) {
    await assert.rejects(runtime.readPhysicalMemory(address, count), /地址|长度/);
  }
  runtime.running = true;
  await assert.rejects(runtime.readPhysicalMemory(0, 1), /先暂停/);
  assert.deepEqual(commands, []);
});

test('RSP transaction serializes its own concurrent commands and rejects escaped callbacks', async t => {
  const { client, commands } = await fixture(t);
  let escaped;
  assert.deepEqual(await client.transaction(async command => {
    escaped = command;
    return Promise.all([command('first'), command('second')]);
  }), ['virtual', 'virtual']);
  await assert.rejects(escaped('late'), /事务已经结束/);
  assert.deepEqual(commands, ['first', 'second']);
});
