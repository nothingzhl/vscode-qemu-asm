const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { inflateSync } = require('node:zlib');
const { QmpClient } = require('../dist/display/qmp');
const { QemuScreen, ppmToPng } = require('../dist/display/screen');

function decodePng(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const parts = [];
  let header;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const bytes = png.subarray(offset + 4, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    assert.equal(png.readUInt32BE(offset + 8 + length), (crc ^ 0xffffffff) >>> 0, `${type} CRC`);
    if (type === 'IHDR') header = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4), raw: inflateSync(Buffer.concat(parts)) };
}

async function serverAt(t, port, handle) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('{"QMP":{"version":{},"capabilities":[]}}\r');
    setImmediate(() => socket.write('\n'));
    let input = '';
    socket.on('data', data => {
      input += data.toString('utf8');
      let end;
      while ((end = input.indexOf('\n')) >= 0) {
        const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
        const reply = (value = {}) => socket.write(JSON.stringify({ return: value, id: request.id }) + '\r\n');
        if (request.execute === 'qmp_capabilities') reply();
        else handle(request, reply, socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server;
}

test('P6 conversion preserves leading whitespace pixels, header comments, PNG dimensions and CRC', () => {
  const pixels = Buffer.from([10, 13, 32, 255, 0, 35]);
  for (const header of ['P6\n# comment\n2\t1\n255\n', 'P6\r\n2 1\r\n# colors\r\n255\r\n']) {
    const frame = ppmToPng(Buffer.concat([Buffer.from(header), pixels]));
    assert.deepEqual([frame.width, frame.height], [2, 1]);
    assert.deepEqual(decodePng(frame.png), { width: 2, height: 1, raw: Buffer.concat([Buffer.from([0]), pixels]) });
  }
  assert.throws(() => ppmToPng(Buffer.from('P6\n999999999999999999 1\n255\n')), /尺寸过大/);
  assert.throws(() => ppmToPng(Buffer.from('P6\n4096 4096\n255\n')), /尺寸过大/);
  assert.throws(() => ppmToPng(Buffer.from('P6\n1 1\n65535\n')), /颜色深度/);
  assert.throws(() => ppmToPng(Buffer.from('P6\n1 1\n255\n\0\0')), /长度不符/);
  assert.throws(() => ppmToPng(Buffer.from('P3\n1 1\n255\n')), /P6/);
});

test('QMP matches concurrent replies by id and accepts fragmented greetings and asynchronous events', async t => {
  const waiting = [];
  const server = await serverAt(t, 0, (request, reply, socket) => {
    waiting.push({ request, reply });
    if (waiting.length === 2) {
      socket.write('{"event":"RESUME","data":{}}\r\n');
      waiting[1].reply('second'); waiting[0].reply('first');
    }
  });
  const client = await QmpClient.connect(server.address().port);
  t.after(() => client.close());
  const event = once(client, 'event');
  assert.deepEqual(await Promise.all([client.command('first'), client.command('second')]), ['first', 'second']);
  assert.equal((await event)[0].event, 'RESUME');
});

test('QMP timeout closes all pending commands and abort releases a greeting wait', async t => {
  const server = await serverAt(t, 0, () => {});
  const client = await QmpClient.connect(server.address().port, 1000, 30);
  t.after(() => client.close());
  const pending = [client.command('one'), client.command('two')];
  const result = await Promise.allSettled(pending);
  assert.ok(result.every(item => item.status === 'rejected' && /超时/.test(item.reason.message)));
  await assert.rejects(client.command('three'), /关闭/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(QmpClient.connect(server.address().port, 1000, 30, abort.signal), /取消/);
});

test('screen serializes captures, survives uninitialized VGA, restricts keyboard and disposes its own files', async t => {
  const screen = await QemuScreen.create();
  t.after(() => screen.dispose());
  const port = Number(screen.args[1].match(/127\.0\.0\.1:(\d+)/)[1]);
  assert.ok(screen.args[1].endsWith(',server=on,wait=off'));
  let active = 0; let maximum = 0; let captures = 0; let filename;
  const keys = [];
  await serverAt(t, port, (request, reply, socket) => {
    if (request.execute === 'send-key') { keys.push(request.arguments.keys); reply(); return; }
    assert.equal(request.execute, 'screendump');
    captures++;
    filename = request.arguments.filename;
    if (captures === 1) {
      socket.write(JSON.stringify({ id: request.id, error: { class: 'GenericError', desc: 'There is no console to dump' } }) + '\n');
      return;
    }
    active++; maximum = Math.max(maximum, active);
    setTimeout(async () => {
      await fs.writeFile(filename, Buffer.concat([Buffer.from('P6\n1 1\n255\n'), Buffer.from([10, 13, 32])]));
      active--; reply();
    }, 20);
  });
  const statuses = [];
  screen.on('status', status => statuses.push(status.state));
  const frame = once(screen, 'frame');
  await screen.connect();
  const first = (await frame)[0];
  assert.equal(first.width, 1);
  const frames = await Promise.all([screen.capture(), screen.capture()]);
  assert.equal(maximum, 1);
  assert.equal(frames.length, 2);
  await screen.sendKey('ctrl-alt-delete');
  assert.deepEqual(keys[0], ['ctrl', 'alt', 'delete'].map(data => ({ type: 'qcode', data })));
  for (const key of ['quit', 'ctrl-ctrl', '', 'a;b', 'ctrl-alt-delete-ret-a']) await assert.rejects(screen.sendKey(key), /不支持/);
  const cleanup = screen.dispose();
  assert.equal(screen.dispose(), cleanup);
  await cleanup;
  await assert.rejects(fs.stat(path.dirname(filename)), { code: 'ENOENT' });
  await assert.rejects(screen.capture(), /未连接/);
  assert.deepEqual(statuses, ['connecting', 'connected', 'stopped']);
});

test('disposing while QMP is starting cancels retries and removes the temporary directory', async () => {
  const screen = await QemuScreen.create();
  const connected = screen.connect();
  const result = connected.catch(error => error);
  await screen.dispose();
  assert.ok(await result instanceof Error);
  await assert.rejects(fs.stat(screen.directory), { code: 'ENOENT' });
});

test('permanent screen capture failure stops polling and reports a single error', async t => {
  const screen = await QemuScreen.create();
  t.after(() => screen.dispose());
  const port = Number(screen.args[1].match(/127\.0\.0\.1:(\d+)/)[1]);
  let captures = 0;
  await serverAt(t, port, (request, reply, socket) => {
    captures++;
    socket.write(JSON.stringify({ id: request.id, error: { class: 'GenericError', desc: 'Permission denied writing screenshot' } }) + '\n');
  });
  const statuses = [];
  const failure = new Promise(resolve => screen.on('status', status => {
    statuses.push(status.state);
    if (status.state === 'error') resolve(status);
  }));
  await screen.connect();
  assert.match((await failure).message, /Permission denied/);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(captures, 1);
  assert.equal(statuses.filter(state => state === 'error').length, 1);
});
