const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CSourceDebugAdapter, isSafeCExpression } = require('../dist/debug/cAdapter');

// These exercise protocol ownership and stop-generation decisions. Real GCC,
// GDB, QEMU and VS Code tests run separately; this transport is deliberately
// controlled so pauses, rollbacks and stale UI requests are reproducible.
function client(t, options = {}) {
  const adapter = new CSourceDebugAdapter({ isTrusted: () => true, getProject: async () => { throw new Error('unused project'); }, ...options });
  const messages = []; adapter.onDidSendMessage(message => messages.push(message)); let sequence = 1;
  t.after(() => adapter.dispose());
  return { adapter, messages,
    request(command, args = {}) {
      const seq = sequence++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listener.dispose(); reject(new Error(`timeout ${command}`)); }, 2000);
        const listener = adapter.onDidSendMessage(message => {
          if (message.type !== 'response' || message.request_seq !== seq) return;
          clearTimeout(timer); listener.dispose(); resolve(message);
        });
        adapter.handleMessage({ type: 'request', seq, command, arguments: args });
      });
    },
    async settled() { await new Promise(resolve => setImmediate(resolve)); await adapter.channel.queue; }
  };
}
class ControlledGdb extends EventEmitter {
  commands = []; serial = 1; vars = 1; running = false; disposals = 0;
  sourceFile = path.join(os.tmpdir(), 'C files, spaces', 'kernel.c');
  pauseStop = { reason: 'signal-received', 'signal-name': 'SIGINT', frame: { addr: '0xc0000020', func: 'kernel_main', line: '8' } };
  failAddress;
  async launch() { this.emit('stopped', { reason: 'entry' }); }
  async mi(command) {
    this.commands.push(command);
    if (command.startsWith('-exec-')) { this.running = true; return { type: 'result', class: 'running', results: {} }; }
    assert.equal(this.running, false, `read/control while running: ${command}`);
    let results = {};
    if (command.startsWith('-break-insert')) {
      if (this.failAddress && command.includes(this.failAddress)) throw new Error('hardware insertion rejected');
      const line = Number(/--line (\d+)$/.exec(command)?.[1] ?? 7);
      results = { bkpt: { number: String(this.serial++), addr: `0x${(0xc0000000 + line * 4).toString(16)}`, line: String(line + 1), fullname: this.sourceFile } };
    } else if (command.startsWith('-break-watch')) results = { wpt: { number: String(this.serial++) } };
    else if (command.startsWith('-stack-list-frames')) results = { stack: [{ frame: { level: '0', addr: '0xc0000020', func: 'nested', fullname: this.sourceFile, line: '8' } }, { frame: { level: '1', addr: '0xc0000040', func: 'kernel_main', fullname: this.sourceFile, line: '16' } }] };
    else if (command.startsWith('-stack-list-variables')) results = { variables: [{ name: 'local', type: 'int', value: '42' }, { name: 'arg', type: 'int', arg: '1', value: '5' }, { name: 'pair', type: 'struct Pair' }] };
    else if (command.startsWith('-var-create')) {
      const expression = JSON.parse(command.slice(command.indexOf(' - * ') + 5));
      const frame = Number(/--frame (\d+)/.exec(command)[1]);
      results = { name: `var${this.vars++}`, exp: expression, value: expression === 'pair' ? '{...}' : String(frame === 1 ? 99 : expression === 'arg' ? 5 : 42), numchild: expression === 'pair' ? '2' : '0', type: expression === 'pair' ? 'struct Pair' : 'int' };
    } else if (command.startsWith('-var-list-children')) results = { children: [{ child: { name: 'var3.left', exp: 'left', numchild: '0', value: '17', type: 'int' } }, { child: { name: 'var3.right', exp: 'right', numchild: '0', value: '20', type: 'int' } }] };
    else if (command.startsWith('-var-info-path-expression')) results = { path_expr: command.includes('left') ? '(pair).left' : '(pair).right' };
    else if (command.startsWith('-data-evaluate-expression')) results = { value: command.includes('sizeof') ? '4' : '0xc0001000' };
    return { type: 'result', class: 'done', results };
  }
  async registers() { assert.equal(this.running, false); return { eax: 42, eip: 0xc0000020, esp: 0x90000, ebp: 0x90010, cs: 8, ss: 16, eflags: 2, cr0: 1, cs_flags: 0x00cf9b00, ss_flags: 0x00cf9300, cs_base: 0, cs_limit: 0xffffffff, ss_base: 0, ss_limit: 0xffffffff }; }
  async readMemory(_address, count) { assert.equal(this.running, false); return Buffer.alloc(count); }
  async readPhysicalMemory(_address, count) { assert.equal(this.running, false); return Buffer.alloc(count); }
  async resume() { this.running = true; }
  async pause() { this.stop(this.pauseStop); }
  stop(event) { this.running = false; this.emit('stopped', event); }
  async dispose() { this.disposals++; this.running = false; }
}
async function configured(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'c adapter unit ')), elf = path.join(root, 'kernel.elf');
  await fs.writeFile(elf, Buffer.alloc(52)); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = new ControlledGdb();
  runtime.sourceFile = path.join(root, 'C files, spaces', 'kernel.c');
  const c = client(t, { getProject: async () => ({ root, debug: { elf, gdb: 'unused', entry: 'kernel_main' } }), runtimeFactory: () => runtime, buildProject: async () => ({ units: [], imageBytes: 512 }) });
  assert.equal((await c.request('launch')).success, true);
  assert.equal((await c.request('configurationDone')).success, true);
  runtime.stop({ reason: 'breakpoint-hit', bkptno: '1', frame: { addr: '0xc000001c', func: 'kernel_main', line: '8' } });
  await c.settled(); assert.equal(c.messages.filter(message => message.event === 'stopped').at(-1).body.reason, 'entry');
  return { ...c, runtime };
}

test('C expression whitelist permits reads and rejects mutation/calls/injected GDB syntax', () => {
  for (const expression of ['local', '$eax', 'pair.left', 'cursor->right', 'values[2]', 'values[index + 1]', '*cursor', '&pair.left', '(*cursor).left', 'left + right * 2', '(left << 2) | 1', 'x == y', 'x != y', '  pair.left  ']) assert.equal(isSafeCExpression(expression), true, expression);
  for (const expression of ['', 'x = 4', 'x += 4', '++x', 'x++', 'x--', '--x', 'func()', 'p->method()', 'values[func()]', 'x; set $pc=1', 'x, y', '"x"', '(int)x', 'sizeof(x)', 'x /* comment */', 'x\n-exec-continue', '({x=1;})', 'x @ 100']) assert.equal(isSafeCExpression(expression), false, expression);
});
test('untrusted C launch and stale UI reads never read a project or target', async t => {
  let reads = 0;
  const c = client(t, { isTrusted: () => false, getProject: async () => { reads++; throw new Error('must not read'); } });
  for (const command of ['launch', 'stackTrace', 'scopes', 'variables', 'evaluate', 'qemuAsm.inspectMemory', 'qemuAsm.inspectPaging', 'disassemble', 'setInstructionBreakpoints', 'dataBreakpointInfo']) {
    const response = await c.request(command); assert.equal(response.success, false); assert.match(response.message, /信任/);
  }
  assert.equal(reads, 0); await c.adapter.dispose(); await c.adapter.dispose(); assert.equal(c.messages.filter(message => message.event === 'terminated').length, 1);
});
test('source breakpoint reports actual DWARF line and uses separate source/line options for commas', async t => {
  const c = await configured(t);
  const source = c.runtime.sourceFile;
  await fs.mkdir(path.dirname(source)); await fs.writeFile(source, 'int kernel_main(void) { return 0; }\n');
  const realSource = await fs.realpath(source);
  c.runtime.sourceFile = process.platform === 'win32' ? realSource.toLowerCase() : realSource;
  const response = await c.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: 20 }, { line: 21, condition: 'x' }, { line: 0 }] });
  assert.equal(response.success, true); assert.equal(response.body.breakpoints[0].line, 21); assert.equal(response.body.breakpoints[0].verified, true);
  assert.equal(response.body.breakpoints[0].source.path, c.runtime.sourceFile);
  assert.equal(response.body.breakpoints[1].verified, false); assert.equal(response.body.breakpoints[2].verified, false);
  assert(c.runtime.commands.some(command => command === `-break-insert -h --source ${JSON.stringify(c.runtime.sourceFile)} --line 20`));
  assert(!c.runtime.commands.some(command => command.includes('--line 21')));
});
test('caller scopes and evaluation use the selected DWARF frame; children expose correct expressions', async t => {
  const c = await configured(t), frames = (await c.request('stackTrace')).body.stackFrames;
  const current = (await c.request('scopes', { frameId: frames[0].id })).body.scopes;
  const caller = (await c.request('scopes', { frameId: frames[1].id })).body.scopes;
  assert(current.some(scope => /寄存器/.test(scope.name))); assert(caller.every(scope => !/寄存器/.test(scope.name)));
  const locals = (await c.request('variables', { variablesReference: current[0].variablesReference })).body.variables;
  assert.deepEqual(locals.map(variable => variable.name), ['local', 'pair']);
  const parameters = (await c.request('variables', { variablesReference: current[1].variablesReference })).body.variables;
  assert.equal(parameters[0].name, 'arg'); assert.equal(parameters[0].value, '5');
  const children = (await c.request('variables', { variablesReference: locals.find(variable => variable.name === 'pair').variablesReference })).body.variables;
  assert.equal(children[0].evaluateName, '(pair).left'); assert.equal(children[0].value, '17');
  const value = await c.request('evaluate', { frameId: frames[1].id, expression: 'local' }); assert.equal(value.body.result, '99');
  const info = await c.request('dataBreakpointInfo', { variablesReference: current[0].variablesReference, name: 'local' }); assert.equal(info.body.dataId, 'qemu-mem:c0001000:4');
});
test('continued/stopped invalidates all previous frame and variable handles', async t => {
  const c = await configured(t), frames = (await c.request('stackTrace')).body.stackFrames, scopes = (await c.request('scopes', { frameId: frames[0].id })).body.scopes;
  const locals = (await c.request('variables', { variablesReference: scopes[0].variablesReference })).body.variables;
  const object = locals.find(variable => variable.name === 'pair').variablesReference;
  assert.equal((await c.request('next')).success, true);
  assert.deepEqual((await c.request('variables', { variablesReference: object })).body.variables, []);
  assert.deepEqual((await c.request('stackTrace')).body.stackFrames, []);
  c.runtime.stop({ reason: 'end-stepping-range', frame: { addr: '0xc0000024', func: 'nested', line: '9' } }); await c.settled();
  assert.deepEqual((await c.request('variables', { variablesReference: object })).body.variables, []);
  assert.equal((await c.request('evaluate', { frameId: frames[0].id, expression: 'local' })).success, false);
  const nextFrames = (await c.request('stackTrace')).body.stackFrames; assert.notEqual(nextFrames[0].id, frames[0].id);
});
test('delayed native scopes and evaluations after F11 never reuse an expired frame or notify the user', async t => {
  const c = await configured(t), previousFrames = (await c.request('stackTrace')).body.stackFrames;
  await c.request('scopes', { frameId: previousFrames[1].id });
  assert.equal((await c.request('stepIn')).success, true);
  assert(c.runtime.commands.includes('-exec-step'));
  c.runtime.stop({ reason: 'end-stepping-range', frame: { addr: '0xc0000024', func: 'nested', line: '9' } }); await c.settled();

  const before = [...c.runtime.commands], nextHandle = c.adapter.values.handleSerial;
  for (const frame of previousFrames) {
    const scopes = await c.request('scopes', { frameId: frame.id });
    assert.equal(scopes.success, true); assert.deepEqual(scopes.body.scopes, []);
  }
  for (const context of ['hover', 'watch', 'variables', 'repl', undefined]) {
    const evaluation = await c.request('evaluate', { frameId: previousFrames[1].id, expression: 'local', ...(context ? { context } : {}) });
    assert.equal(evaluation.success, false); assert.match(evaluation.message, /调用栈帧已过期/);
    assert.equal(evaluation.body.error.showUser, false);
  }
  assert.deepEqual(c.runtime.commands, before, 'expired reads must not request new frames or create GDB variables');
  assert.equal(c.adapter.values.handleSerial, nextHandle); assert.equal(c.adapter.values.handles.size, 0);

  const currentFrames = (await c.request('stackTrace')).body.stackFrames;
  assert.notEqual(currentFrames[0].id, previousFrames[0].id);
  const currentScopes = (await c.request('scopes', { frameId: currentFrames[0].id })).body.scopes;
  assert(currentScopes.some(scope => /寄存器/.test(scope.name)));
  assert.equal((await c.request('evaluate', { frameId: currentFrames[0].id, expression: 'local', context: 'watch' })).body.result, '42');
  assert.equal((await c.request('evaluate', { frameId: currentFrames[1].id, expression: 'local', context: 'repl' })).body.result, '99');
  const reads = c.runtime.commands.length;
  assert.deepEqual((await c.request('scopes', { frameId: previousFrames[0].id })).body.scopes, []);
  assert.equal(c.runtime.commands.length, reads, 'new cached frames must not make an old ID valid again');
});
test('native and panel instruction ownership share installation and preserve remaining owner', async t => {
  const c = await configured(t), address = 0xc0000020;
  const native = (await c.request('setInstructionBreakpoints', { breakpoints: [{ instructionReference: '0xc0000020' }] })).body.breakpoints[0];
  const custom = (await c.request('qemuAsm.instructionBreakpoints', { action: 'add', address })).body.breakpoints[0];
  assert.equal(custom.id, native.id); assert.equal(custom.origin, 'both');
  const inserts = c.runtime.commands.filter(command => command.includes('"*0xC0000020"')).length;
  assert.equal(inserts, 1);
  await c.request('setInstructionBreakpoints', { breakpoints: [] });
  assert.equal((await c.request('qemuAsm.instructionBreakpoints', { action: 'list' })).body.breakpoints[0].origin, 'custom');
  await c.request('continue'); c.runtime.stop({ reason: 'breakpoint-hit', bkptno: '2', frame: { addr: '0xc0000020', func: 'nested' } }); await c.settled();
  assert.deepEqual(c.messages.filter(message => message.event === 'stopped').at(-1).body.hitBreakpointIds, [native.id]);
  await c.request('qemuAsm.instructionBreakpoints', { action: 'remove', address });
  assert(c.runtime.commands.includes('-break-delete 2'));
});
test('failed hardware insertion rolls back additions and retains the previous panel configuration', async t => {
  const c = await configured(t);
  await c.request('setInstructionBreakpoints', { breakpoints: [{ instructionReference: '0xc0000020' }] });
  c.runtime.failAddress = '*0xC0000040';
  const failed = await c.request('setInstructionBreakpoints', { breakpoints: [{ instructionReference: '0xc0000030' }, { instructionReference: '0xc0000040' }] });
  assert.equal(failed.success, false);
  const list = (await c.request('qemuAsm.instructionBreakpoints', { action: 'list' })).body.breakpoints;
  assert.deepEqual(list.map(point => point.address), [0xc0000020]); assert(c.runtime.commands.includes('-break-delete 3'));
  assert(!c.runtime.commands.includes('-break-delete 2'));
});
test('natural exception while internally pausing for source edits is reported without continuing', async t => {
  const c = await configured(t);
  c.runtime.pauseStop = { reason: 'signal-received', 'signal-name': 'SIGSEGV', 'signal-meaning': 'Segmentation fault', frame: { addr: '0xc0000020' } };
  await c.request('continue'); const resumes = c.runtime.commands.filter(command => command === '-exec-continue').length;
  const response = await c.request('setBreakpoints', { source: { path: '/tmp/kernel.c' }, breakpoints: [{ line: 9 }] });
  await c.settled();
  assert.equal(response.success, true); assert.equal(c.runtime.running, false);
  assert.equal(c.runtime.commands.filter(command => command === '-exec-continue').length, resumes);
  assert.equal(c.messages.filter(message => message.event === 'stopped').at(-1).body.reason, 'exception');
});
test('restart retains source/machine configurations while expiring old handles and data hit', async t => {
  const c = await configured(t), frames = (await c.request('stackTrace')).body.stackFrames;
  await c.request('setBreakpoints', { source: { path: '/tmp/kernel.c' }, breakpoints: [{ line: 9 }] });
  await c.request('qemuAsm.instructionBreakpoints', { action: 'add', address: 0xc0000020 });
  await c.request('qemuAsm.watchpoints', { action: 'add', address: 0xc0001000, size: 4, access: 'write' });
  const previousSerial = c.runtime.serial;
  assert.equal((await c.request('restart')).success, true); assert.equal(c.runtime.disposals, 1);
  assert(c.runtime.serial > previousSerial + 2, 'source, instruction, watch and entry bindings are reinstalled');
  c.runtime.stop({ reason: 'breakpoint-hit', bkptno: String(c.runtime.serial - 1), frame: { addr: '0xc000001c' } }); await c.settled();
  assert.equal((await c.request('evaluate', { frameId: frames[0].id, expression: 'local' })).success, false);
  assert.equal((await c.request('qemuAsm.watchpoints', { action: 'list' })).body.breakpoints.length, 1);
});
test('failed deletion closes the target instead of leaving partially tracked hardware breakpoints', async t => {
  const c = await configured(t);
  await c.request('setInstructionBreakpoints', { breakpoints: [{ instructionReference: '0xc0000020' }, { instructionReference: '0xc0000030' }] });
  const original = c.runtime.mi.bind(c.runtime);
  c.runtime.mi = async command => { if (command === '-break-delete 2 3') throw new Error('partial deletion'); return original(command); };
  const response = await c.request('setInstructionBreakpoints', { breakpoints: [] });
  assert.equal(response.success, false); assert.match(response.message, /会话已关闭/); assert.equal(c.runtime.disposals, 1);
  assert.equal(c.messages.filter(message => message.event === 'terminated').length, 1);
});
test('numeric ELF entry is an address breakpoint and never a function linespec', async t => {
  const c = await configured(t); c.adapter.project.debug.entry = '0xc0000080';
  c.adapter.phase = 'configuring';
  const response = await c.request('configurationDone');
  assert.equal(response.success, true); assert(c.runtime.commands.includes('-break-insert -h "*0xC0000080"'));
});
test('trust revocation while a display opens prevents starting GDB or QEMU', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'c display trust ')), elf = path.join(root, 'kernel.elf');
  await fs.writeFile(elf, Buffer.alloc(52)); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let trusted = true, starts = 0, disposals = 0;
  const c = client(t, { isTrusted: () => trusted, getProject: async () => ({ root, debug: { elf, gdb: 'unused', entry: 'kernel_main' } }), buildProject: async () => ({ units: [], imageBytes: 512 }), createDisplay: async () => { trusted = false; return { args: [], connect: async () => {}, dispose: async () => { disposals++; } }; }, runtimeFactory: () => { starts++; return new ControlledGdb(); } });
  const response = await c.request('launch'); assert.equal(response.success, false); assert.match(response.message, /信任/);
  assert.equal(starts, 0); assert.equal(disposals, 1); assert(!c.messages.some(message => message.event === 'initialized'));
});
test('DWARF frame with file but no positive line never acquires a fabricated C source location', async t => {
  const c = await configured(t), original = c.runtime.mi.bind(c.runtime);
  c.runtime.mi = async command => command.startsWith('-stack-list-frames') ? { type: 'result', class: 'done', results: { stack: [{ frame: { level: '0', addr: '0xc0000020', func: 'partially_described', fullname: '/tmp/kernel.c', line: '0' } }] } } : original(command);
  const frame = (await c.request('stackTrace')).body.stackFrames[0];
  assert.equal(frame.source, undefined); assert.equal(frame.line, 1); assert.equal(frame.instructionPointerReference, '0xC0000020');
});

test('disposing C DAP waits for a late display allocation and never launches its backend', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'c late allocation '));
  const elf = path.join(root, 'kernel.elf');
  await fs.writeFile(elf, Buffer.alloc(52));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let open, entered;
  const displayReady = new Promise(resolve => { open = resolve; });
  const allocating = new Promise(resolve => { entered = resolve; });
  let launched = 0, backendClosed = 0, displayClosed = 0;
  const c = client(t, {
    getProject: async () => ({ root, debug: { elf } }),
    buildProject: async () => ({ units: [], imageBytes: 512 }),
    createDisplay: async () => { entered(); await displayReady; return { args: [], async connect() {}, async dispose() { displayClosed++; } }; },
    backendFactory: () => ({ async launch() { launched++; }, async dispose() { backendClosed++; } })
  });
  const launching = c.request('launch');
  await allocating;
  let stopped = false;
  const stopping = c.adapter.dispose().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  open();
  const [response] = await Promise.all([launching, stopping]);
  assert.equal(response.success, false);
  assert.match(response.message, /取消/);
  assert.equal(launched, 0);
  assert.equal(backendClosed, 1);
  assert.equal(displayClosed, 1);
  assert.equal(c.messages.filter(message => message.event === 'terminated').length, 1);
});
