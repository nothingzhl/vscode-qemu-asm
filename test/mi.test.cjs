const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { MiClient, miQuote, parseMiRecord } = require('../dist/debug/mi');

function fake(t, respond, timeout = 500) {
  const script = `const readline=require('node:readline');process.stdout.write('(gdb)\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=/^(\\d+)(.*)$/.exec(line);(${respond.toString()})(m[1],m[2]);});`;
  const client = new MiClient(spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }), timeout);
  t.after(() => client.dispose());
  return client;
}

test('MI parser handles tuples, both list forms, repeated keys, tokens and async records', () => {
  const parsed = parseMiRecord('25^done,stack=[frame={level="0",func="main"},frame={level="1",args=[{name="x",value="2"}]}],x="1",x="2",v=["a"],v="b",v="c"');
  assert.equal(parsed.token, 25);
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.class, 'done');
  assert.deepEqual(parsed.results.stack, [{ frame: { level: '0', func: 'main' } }, { frame: { level: '1', args: [{ name: 'x', value: '2' }] } }]);
  assert.deepEqual(parsed.results.x, ['1', '2']);
  assert.deepEqual(parsed.results.v, [['a'], 'b', 'c']);
  assert.equal(parseMiRecord('*stopped,reason="breakpoint-hit"').type, 'exec');
  assert.equal(parseMiRecord('=thread-created,id="1"').type, 'notify');
  assert.equal(parseMiRecord('(gdb) ').type, 'prompt');
  assert.equal(parseMiRecord('plain startup output'), undefined);
  const proto = parseMiRecord('^done,__proto__={polluted="no"}').results;
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(proto, '__proto__'), true);
});

test('MI C strings round-trip UTF-8, octal paths, quotes, delimiters and controls', () => {
  for (const value of ['C:\\带 空格,目录\\kernel.c', '路径/"引号"\\\\\r\n\t\0', 'plain-value']) {
    const quote = miQuote(value);
    assert.equal(/[\r\n\0]/.test(quote), false);
    assert.equal(parseMiRecord('~' + quote).text, value);
  }
  assert.equal(parseMiRecord('~"\\344\\270\\255\\346\\226\\207/path"').text, '中文/path');
  assert.equal(parseMiRecord('~"literal中文\\n\\x41"').text, 'literal中文\nA');
});

test('MI parser rejects malformed, incomplete, too deep and oversized records', () => {
  for (const line of ['^done,a={x="1"', '^done,x="unterminated', '^done,x="\\q"', '~"hi"junk', '^done,=foo', '9007199254740992^done']) assert.throws(() => parseMiRecord(line), /MI/);
  assert.throws(() => parseMiRecord('^done,x=' + '['.repeat(70) + '"x"' + ']'.repeat(70)), /超限/);
  assert.throws(() => parseMiRecord('~"' + 'x'.repeat(4 * 1024 * 1024) + '"'), /过大/);
});

test('MI transport tokenizes requests, separates stderr, assembles fragments and emits asynchronous stops', async t => {
  const client = fake(t, (token, command) => {
    process.stderr.write('stderr-only\n');
    process.stdout.write('~"console\\n"\n@"target\\n"\n');
    const result = token + '^done,value="' + command + '"\n';
    process.stdout.write(result.slice(0, 3));
    setTimeout(() => { process.stdout.write(result.slice(3)); process.stdout.write('*stopped,reason="breakpoint-hit",bkptno="1"\n'); }, 5);
  });
  const stderr = once(client, 'stderr');
  const records = [];
  client.on('record', record => records.push(record));
  const results = await Promise.all([client.command('-first'), client.command('-second')]);
  assert.equal(results[0].results.value, '-first');
  assert.equal(results[1].results.value, '-second');
  assert.equal(results[0].console, 'console\ntarget\n');
  assert.match((await stderr)[0], /stderr-only/);
  assert.equal(records.some(record => record.type === 'exec' && record.results.bkptno === '1'), true);
});

test('MI transactions keep physical-mode change/read/restore atomic against ordinary requests', async t => {
  const order = [];
  const client = fake(t, (token, command) => { setTimeout(() => process.stdout.write(token + '^done,value="' + command + '"\n'), 5); });
  client.on('record', record => { if (record.type === 'result') order.push(record.results.value); });
  const physical = client.transaction(async execute => {
    await execute('-physical-on');
    try { await execute('-physical-read'); }
    finally { await execute('-physical-off'); }
  });
  await Promise.all([physical, client.command('-virtual-read')]);
  assert.deepEqual(order, ['-physical-on', '-physical-read', '-physical-off', '-virtual-read']);
});

test('MI errors reject their command while timeout and mismatched tokens close the connection', async t => {
  const errorClient = fake(t, (token) => process.stdout.write(token + '^error,msg="bad expression"\n'));
  await assert.rejects(errorClient.command('-bad'), /bad expression/);
  await assert.rejects(errorClient.command('-bad\n-exec-run'), /单条命令/);
  const timeoutClient = fake(t, () => {}, 50);
  await assert.rejects(timeoutClient.command('-never'), /超时/);
  await assert.rejects(timeoutClient.command('-after'), /关闭/);
  const mismatch = fake(t, token => process.stdout.write((Number(token) + 1) + '^done\n'));
  await assert.rejects(mismatch.command('-wrong'), /编号/);
});

test('MI dispose is idempotent and safe when a termination listener disposes recursively', async t => {
  const client = fake(t, () => {});
  let calls = 0;
  client.on('terminated', () => { calls++; void client.dispose(); });
  const first = client.dispose();
  assert.equal(client.dispose(), first);
  await first;
  assert.equal(calls, 1);
});
