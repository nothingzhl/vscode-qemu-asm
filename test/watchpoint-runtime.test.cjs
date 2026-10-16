const test = require('node:test');
const assert = require('node:assert/strict');
const { DebugRuntime, stoppedEvent } = require('../dist/debug/runtime');

function runtimeWithClient(reply = () => 'OK') {
  const runtime = new DebugRuntime({ qemuArgs: [] }, () => {});
  const commands = [];
  runtime.client = {
    async command(packet) { commands.push(packet); return reply(packet, commands.length); },
    close() {}, interrupt() { commands.push('interrupt'); }, async resume(step = false) { commands.push(step ? 's' : 'c'); }
  };
  return { runtime, commands };
}

test('watch stop fields take priority over step and preserve actual QEMU access type', () => {
  for (const [field, access] of [['watch', 'write'], ['rwatch', 'read'], ['awatch', 'readWrite']]) {
    assert.deepEqual(stoppedEvent(`T05${field}:12345678;thread:1;`, 'step'), {
      reason: 'data breakpoint', signal: 5, dataAddress: 0x12345678, dataAccess: access
    });
    assert.equal(stoppedEvent(`T05thread:1;${field}:0;`, 'pause').dataAddress, 0);
  }
  assert.deepEqual(stoppedEvent('S05', 'step'), { reason: 'step', signal: 5 });
  assert.deepEqual(stoppedEvent('T02thread:1;', 'breakpoint'), { reason: 'pause', signal: 2 });
  assert.deepEqual(stoppedEvent('T0bthread:1;', 'step'), { reason: 'exception', signal: 11 });
  assert.throws(() => stoppedEvent('T05watch:100000000;', 'step'), /无效/);
});

test('data watchpoint replacement uses distinct Z2/Z3/Z4 packets, deduplicates and removes owned points', async () => {
  const { runtime, commands } = runtimeWithClient();
  const points = [
    { address: 0x9001, size: 1, access: 'write' },
    { address: 0x9003, size: 2, access: 'read' },
    { address: 0x190007, size: 4, access: 'readWrite' }
  ];
  await runtime.setDataBreakpoints([...points, points[0]]);
  assert.deepEqual(commands, ['Z2,9001,1', 'Z3,9003,2', 'Z4,190007,4']);
  await runtime.setDataBreakpoints(points);
  assert.equal(commands.length, 3);
  await runtime.setDataBreakpoints([points[1]]);
  assert.deepEqual(commands.slice(3), ['z2,9001,1', 'z4,190007,4']);
  await runtime.setDataBreakpoints([]);
  assert.equal(commands.at(-1), 'z3,9003,2');
});

test('whole data-watchpoint batch validates before changing any installed watchpoint', async () => {
  const { runtime, commands } = runtimeWithClient();
  const old = { address: 0x9000, size: 1, access: 'write' };
  await runtime.setDataBreakpoints([old]);
  for (const point of [
    { address: -1, size: 1, access: 'write' },
    { address: 0x100000000, size: 1, access: 'write' },
    { address: 0xffffffff, size: 2, access: 'write' },
    { address: 0x9000, size: 8, access: 'write' },
    { address: 0x9000, size: 1.5, access: 'write' },
    { address: 0x9000, size: 1, access: 'execute' }
  ]) await assert.rejects(runtime.setDataBreakpoints([old, point]));
  await assert.rejects(runtime.setDataBreakpoints(Array(17).fill(old)), /16/);
  assert.deepEqual(commands, ['Z2,9000,1']);
  await runtime.setDataBreakpoints([{ address: 0xffffffff, size: 1, access: 'read' }]);
  assert.equal(commands.at(-1), 'Z3,ffffffff,1');
  runtime.running = true;
  await assert.rejects(runtime.setDataBreakpoints([]), /先暂停/);
});

test('partial install failure removes newly added watches and restores all previous watches', async () => {
  const { runtime, commands } = runtimeWithClient(packet => packet === 'Z4,a000,4' ? '' : 'OK');
  const old = [{ address: 0x9000, size: 2, access: 'write' }, { address: 0x9008, size: 1, access: 'read' }];
  await runtime.setDataBreakpoints(old);
  await assert.rejects(runtime.setDataBreakpoints([
    { address: 0x9010, size: 1, access: 'write' }, { address: 0xa000, size: 4, access: 'readWrite' }
  ]), /设置数据断点/);
  assert.deepEqual(commands.slice(2), [
    'z2,9000,2', 'z3,9008,1', 'Z2,9010,1', 'Z4,a000,4',
    'z2,9010,1', 'Z2,9000,2', 'Z3,9008,1'
  ]);
  const count = commands.length;
  await runtime.setDataBreakpoints(old);
  assert.equal(commands.length, count, 'restored set must match the actual remote set');
});

test('partial removal failure restores removed old watches before rejecting', async () => {
  const { runtime, commands } = runtimeWithClient(packet => packet === 'z3,9008,1' ? 'E01' : 'OK');
  const old = [{ address: 0x9000, size: 2, access: 'write' }, { address: 0x9008, size: 1, access: 'read' }];
  await runtime.setDataBreakpoints(old);
  await assert.rejects(runtime.setDataBreakpoints([]), /移除数据断点/);
  assert.deepEqual(commands.slice(2), ['z2,9000,2', 'z3,9008,1', 'Z2,9000,2']);
  const count = commands.length;
  await runtime.setDataBreakpoints(old);
  assert.equal(commands.length, count);
});

test('rollback failure terminates rather than retaining an unknown remote watchpoint set', async () => {
  let installing = true;
  const { runtime } = runtimeWithClient(packet => {
    if (!installing && packet.startsWith('Z')) return '';
    return 'OK';
  });
  await runtime.setDataBreakpoints([{ address: 0x9000, size: 1, access: 'write' }]);
  installing = false;
  let termination;
  runtime.once('terminated', event => { termination = event; });
  await assert.rejects(runtime.setDataBreakpoints([{ address: 0x9001, size: 1, access: 'write' }]), /无法恢复/);
  assert.match(termination.error, /无法恢复/);
  await assert.rejects(runtime.setDataBreakpoints([]), /已经结束/);
});

test('watchpoint hit during internal hardware-breakpoint step-off remains visible even with pause intent', async () => {
  const { runtime, commands } = runtimeWithClient();
  runtime.running = true;
  runtime.breakpointStep = { address: 0x7c00, step: false, pause: true, awaiting: false };
  let event;
  runtime.once('stopped', stopped => { event = stopped; });
  await runtime.afterBreakpointStep('T05watch:9001;', runtime.breakpointStep);
  assert.equal(event.reason, 'data breakpoint');
  assert.equal(event.dataAddress, 0x9001);
  assert.equal(runtime.running, false);
  assert.equal(runtime.breakpointStep, undefined);
  assert.deepEqual(commands, ['Z1,7c00,1'], 'internal continue must not swallow the data stop');
  assert.equal(runtime.steppedWatch, true);
});

test('one residual QEMU watch-step trap resumes without restoring the current source breakpoint early', async () => {
  const { runtime, commands } = runtimeWithClient();
  const registers = { eip: 0x7c03, ecx: 3, eflags: 2 };
  runtime.readRegisters = async () => ({ ...registers });
  runtime.running = true;
  const internal = runtime.breakpointStep = { address: 0x7c03, step: true, pause: false, awaiting: true };
  runtime.watchTrapCheck = { registers, step: true };
  let stops = 0;
  runtime.on('stopped', () => { stops++; });
  await runtime.handleStop('T05thread:1;');
  assert.deepEqual(commands, ['s']);
  assert.equal(stops, 0);
  assert.equal(runtime.breakpointStep, internal);
  assert.equal(runtime.running, true);
  assert.equal(runtime.watchTrapCheck, undefined, 'residual trap suppression is bounded to one reply');
  await runtime.handleStop('T05thread:1;');
  assert.deepEqual(commands, ['s', 'Z1,7c03,1']);
  assert.equal(stops, 1);
  assert.equal(runtime.running, false);
});

test('same-PC LOOP/REP register progress remains a real step and new watches are never drained', async () => {
  const registers = { eip: 0x7c03, ecx: 3, eflags: 2 };
  const { runtime, commands } = runtimeWithClient();
  runtime.nextStop = 'step';
  runtime.running = true;
  runtime.watchTrapCheck = { registers, step: true };
  runtime.readRegisters = async () => ({ ...registers, ecx: 2 });
  let event;
  runtime.on('stopped', stopped => { event = stopped; });
  await runtime.handleStop('T05thread:1;');
  assert.equal(event.reason, 'step');
  assert.deepEqual(commands, []);
  runtime.running = true;
  runtime.watchTrapCheck = { registers, step: true };
  await runtime.handleStop('T05watch:9000;');
  assert.equal(event.reason, 'data breakpoint');
  assert.equal(runtime.steppedWatch, true);
  assert.deepEqual(commands, []);
});

test('pause during residual-trap register refresh waits for the physical stop and prevents re-resume', async () => {
  const { runtime, commands } = runtimeWithClient();
  const registers = { eip: 0x7c03, ecx: 3 };
  let finishRead;
  const reading = new Promise(resolve => { finishRead = resolve; });
  runtime.readRegisters = async () => { await reading; return { ...registers }; };
  runtime.running = true;
  runtime.watchTrapCheck = { registers, step: false };
  let event;
  runtime.on('stopped', stopped => { event = stopped; });
  const handling = runtime.handleStop('T05thread:1;');
  const pausing = runtime.pause();
  assert.deepEqual(commands, [], 'a physically stopped CPU must not receive another Ctrl-C');
  finishRead();
  await Promise.all([handling, pausing]);
  assert.equal(event.reason, 'pause');
  assert.equal(runtime.running, false);
  assert.deepEqual(commands, [], 'pending pause must not be lost during the async register refresh');
  event = undefined;
  await runtime.handleStop('T02thread:1;');
  assert.equal(event, undefined, 'duplicate queued stop replies cannot emit another user stop');
});

test('an actual exception during internal step-off is preserved over pause intent', async () => {
  const { runtime } = runtimeWithClient();
  runtime.running = true;
  runtime.breakpointStep = { address: 0x7c00, step: false, pause: true, awaiting: false };
  let event;
  runtime.once('stopped', stopped => { event = stopped; });
  await runtime.afterBreakpointStep('T0bthread:1;', runtime.breakpointStep);
  assert.equal(event.reason, 'exception');
  assert.equal(event.signal, 11);
});

test('instruction breakpoint replacement restores the old remote set on partial install failure', async () => {
  const { runtime, commands } = runtimeWithClient(packet => packet === 'Z1,7c30,1' ? '' : 'OK');
  await runtime.setBreakpoints([0x7c00, 0x7c10]);
  await assert.rejects(runtime.setBreakpoints([0x7c20, 0x7c30]), /设置硬件断点/);
  assert.deepEqual(commands.slice(2), [
    'z1,7c00,1', 'z1,7c10,1', 'Z1,7c20,1', 'Z1,7c30,1',
    'z1,7c20,1', 'Z1,7c00,1', 'Z1,7c10,1'
  ]);
  const length = commands.length;
  await runtime.setBreakpoints([0x7c00, 0x7c10]);
  assert.equal(commands.length, length);
});

test('instruction breakpoint replacement stops the session if restoring the old remote set fails', async () => {
  let installed = false;
  const { runtime } = runtimeWithClient(packet => installed && packet.startsWith('Z') ? '' : 'OK');
  await runtime.setBreakpoints([0x7c00]);
  installed = true;
  await assert.rejects(runtime.setBreakpoints([0x7c10]), /无法恢复/);
  await assert.rejects(runtime.setBreakpoints([]), /已经结束/);
});
