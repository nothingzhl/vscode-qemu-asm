const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configureGdb } = require('../dist/backends/gdb/configure');
const { CapabilityLedger } = require('../dist/dependencies/capabilities');

const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags', 'cs', 'ss', 'ds', 'es', 'fs', 'gs'];
const missingSetting = new Error('Undefined show command: "debuginfod enabled".  Try "help show".');
function setup(fail) {
  const commands = [];
  const ledger = new CapabilityLedger({ sessionId: 'settings' });
  const client = { async command(command) {
    commands.push(command);
    const error = fail?.(command);
    if (error) throw error;
    return { type: 'result', class: 'done', results: command === '-data-list-register-names' ? { 'register-names': names } : {} };
  } };
  return {
    commands, ledger,
    run: () => configureGdb(client, { elf: '/tmp/kernel.elf', gdb: 'gdb' }, { host: '127.0.0.1', port: 1234 }, ledger, () => {})
  };
}

test('GDB 9.2 absent debuginfod setting does not block unrelated MI/source capabilities', async () => {
  const fixture = setup(command => command === '-gdb-show debuginfod enabled' ? missingSetting : undefined);
  assert.deepEqual(await fixture.run(), names);
  assert(!fixture.commands.includes('-gdb-set debuginfod enabled off'));
  assert(fixture.commands.includes('-gdb-set may-call-functions off'));
  const report = fixture.ledger.snapshot();
  const mi = report.entries.find(item => item.id === 'gdb.mi');
  assert.equal(mi.state, 'supported');
  assert.equal(mi.evidence, 'protocol');
  assert.equal(mi.details.debuginfod, 'unsupported');
  assert.equal(mi.details.debuginfodReason, missingSetting.message);
  assert.equal(report.entries.find(item => item.id === 'qemu.physicalMemory').state, 'unknown');
});

test('GDB with debuginfod disables it before loading any ELF or connecting a target', async () => {
  const fixture = setup();
  await fixture.run();
  const off = fixture.commands.indexOf('-gdb-set debuginfod enabled off');
  assert(off >= 0);
  assert(off < fixture.commands.findIndex(command => command.startsWith('-file-exec-and-symbols')));
  assert(off < fixture.commands.findIndex(command => command.startsWith('-target-select')));
  const mi = fixture.ledger.snapshot().entries.find(item => item.id === 'gdb.mi');
  assert.equal(mi.details.debuginfod, 'disabled');
});

for (const [name, command, error] of [
  ['broken channel during the probe', '-gdb-show debuginfod enabled', new Error('GDB/MI 会话已关闭')],
  ['unexpected probe error', '-gdb-show debuginfod enabled', new Error('Permission denied')],
  ['failed debuginfod disabling', '-gdb-set debuginfod enabled off', new Error('Invalid value')],
  ['failed auto-load disabling', '-gdb-set auto-load off', new Error('Permission denied')],
  ['failed inferior function call guard', '-gdb-set may-call-functions off', new Error('Undefined set command')]
]) test(name + ' still aborts initialization before ELF/target side effects', async () => {
  const fixture = setup(value => value === command ? error : undefined);
  await assert.rejects(fixture.run(), value => value === error);
  assert(!fixture.commands.some(value => value.startsWith('-file-exec-and-symbols')));
  assert(!fixture.commands.some(value => value.startsWith('-target-select')));
  assert.equal(fixture.ledger.snapshot().entries.find(item => item.id === 'gdb.mi').state, 'unknown');
});
