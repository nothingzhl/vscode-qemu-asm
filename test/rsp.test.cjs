const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { RspClient, decodePayload, registerLayout, decodeRegisters } = require('../dist/debug/rsp');
const { realModeAddress, monitorRegisters, validateRealModeRegisters } = require('../dist/debug/runtime');

function packet(payload) {
  const bytes = Buffer.from(payload, 'latin1');
  return Buffer.concat([Buffer.from('$'), bytes, Buffer.from('#' + bytes.reduce((sum, byte) => (sum + byte) & 255, 0).toString(16).padStart(2, '0'))]);
}

test('RSP handles fragmented packets, monitor output, checksum retries and asynchronous stops', async t => {
  const sockets = new Set();
  let badChecksumSent = false;
  let interruptSignal = '02';
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', data => {
      input += data.toString('latin1');
      while (input.length) {
        if (input[0] === '-') {
          input = input.slice(1);
          if (badChecksumSent) { badChecksumSent = false; socket.write(packet('retry-ok')); }
          continue;
        }
        if (input.charCodeAt(0) === 3) { input = input.slice(1); socket.write(packet(`T${interruptSignal}thread:1;`)); continue; }
        if (input[0] !== '$') { input = input.slice(1); continue; }
        const end = input.indexOf('#');
        if (end < 0 || input.length < end + 3) break;
        const request = input.slice(1, end);
        input = input.slice(end + 3);
        socket.write('+');
        if (request === 'g') {
          const reply = packet('00112233');
          socket.write(reply.subarray(0, 3));
          setImmediate(() => socket.write(reply.subarray(3)));
        } else if (request === 'monitor') {
          socket.write(Buffer.concat([packet('O' + Buffer.from('CR0=00000010\n').toString('hex')), packet('OK')]));
        } else if (request === 'retry') {
          badChecksumSent = true;
          socket.write('$wrong#00');
        } else if (request === 'c') {
          setTimeout(() => socket.write(packet('T05thread:1;')), 15);
        } else if (request === 'empty') socket.write(packet(''));
        else if (request === 'fail') socket.write(packet('E22'));
        else if (request.startsWith('hex:')) socket.write(packet(request.slice(4)));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const client = await RspClient.connect(server.address().port);
  t.after(() => client.close());
  assert.deepEqual(await Promise.all([client.command('g'), client.command('monitor')]), ['00112233', 'CR0=00000010\n']);
  assert.equal(await client.command('retry'), 'retry-ok');
  assert.equal(await client.command('empty'), '');
  await assert.rejects(client.command('fail'), /E22/);
  for (const hex of ['e8', 'ef', 'efbeadde', 'E8', 'E8A1']) assert.equal(await client.command('hex:' + hex), hex);
  const stopped = once(client, 'stop');
  await client.resume();
  assert.equal((await stopped)[0], 'T05thread:1;');
  const paused = once(client, 'stop');
  client.interrupt();
  assert.equal((await paused)[0], 'T02thread:1;');
  // Ctrl-C 可能和自然断点并发；必须保留目标返回的 SIGTRAP，而非把它改写成 SIGINT。
  interruptSignal = '05';
  const breakpointDuringPause = once(client, 'stop');
  client.interrupt();
  assert.equal((await breakpointDuringPause)[0], 'T05thread:1;');
});

test('RSP request timeout rejects and closes the connection', async t => {
  const sockets = [];
  const server = net.createServer(socket => sockets.push(socket));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { sockets.forEach(socket => socket.destroy()); server.close(); });
  const client = await RspClient.connect(server.address().port, '127.0.0.1', 1000, 40);
  t.after(() => client.close());
  await assert.rejects(client.command('never-respond'), /超时/);
  await assert.rejects(client.command('g'), /关闭/);
});

test('RSP decodes escaped bytes and run-length encoding', () => {
  assert.equal(decodePayload(Buffer.from([0x30, 0x2a, 0x20, 0x7d, 0x04])), '0000$');
  assert.throws(() => decodePayload(Buffer.from('* ')), /无效/);
  assert.throws(() => decodePayload(Buffer.from('}')), /不完整/);
});

test('target XML defines register byte offsets and rejects unsafe layouts', () => {
  const xml = '<feature><reg name="eax" bitsize="32" regnum="0"/><!-- <reg name="commented_out" bitsize="32"/> --><reg bitsize="80" name="st0"/><reg name="cr0" bitsize="32"/></feature>';
  const layout = registerLayout(xml);
  assert.deepEqual(layout.map(value => [value.name, value.offset]), [['eax', 0], ['st0', 4], ['cr0', 14]]);
  const bytes = Buffer.alloc(18);
  bytes.writeUInt32LE(0x12345678, 0);
  bytes.writeUInt32LE(0x10, 14);
  assert.deepEqual(decodeRegisters(bytes.toString('hex'), layout), { eax: 0x12345678, cr0: 0x10 });
  assert.throws(() => decodeRegisters('0000', layout), /长度不足/);
  assert.throws(() => decodeRegisters('xx', layout), /无效/);
  assert.throws(() => registerLayout('<reg name="a" bitsize="32"/><reg name="b" bitsize="32" regnum="9"/>'), /不连续/);
});

test('real-mode address maps segmented boot PCs and rejects protected mode', () => {
  assert.equal(realModeAddress({ cs: 0, eip: 0x7c00, cr0: 0x10 }), 0x7c00);
  assert.equal(realModeAddress({ cs: 0x7c0, eip: 7, cr0: 0 }), 0x7c07);
  assert.throws(() => realModeAddress({ cs: 8, eip: 0x7c00, cr0: 1 }), /实模式/);
  assert.equal(realModeAddress({ cs: 0xf000, cs_base: 0xffff0000, cs_limit: 0xffff, cs_flags: 0x9b00, eip: 0xfff0, cr0: 0x60000010 }), 0xfffffff0);
  assert.throws(() => realModeAddress({ cs: 0, cs_base: 0x100000, eip: 0x7c00, cr0: 0 }), /unreal/);
  assert.throws(() => validateRealModeRegisters({ cs: 0, cs_flags: 1 << 22 }), /big-real/);
  assert.throws(() => validateRealModeRegisters({ ss: 0, ss_limit: 0xffffffff }), /big-real/);
  assert.throws(() => validateRealModeRegisters({ smm: 1 }), /SMM/);
});

test('monitor registers parses real QEMU segment caches and requires all segments', () => {
  const text = 'EIP=00007c00 EFL=00000002 SMM=0\r\n' + ['ES', 'CS', 'SS', 'DS', 'FS', 'GS'].map(name => `${name} =0000 00000000 0000ffff 00009300\r\n`).join('') + 'CR0=60000010 CR2=00000000\r\n';
  const registers = monitorRegisters(text);
  assert.equal(registers.cr0, 0x60000010);
  assert.equal(registers.cs_base, 0);
  assert.equal(registers.ss_limit, 0xffff);
  assert.equal(registers.ds_flags, 0x9300);
  validateRealModeRegisters({ ...registers, eip: 0x7c00, eflags: 2 });
  assert.throws(() => monitorRegisters('CR0=60000010\r\n'), /段缓存/);
});
