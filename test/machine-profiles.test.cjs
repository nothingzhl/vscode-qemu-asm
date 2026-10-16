const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveProject } = require('../dist/project/config');

const root = path.resolve('workspace with spaces');
const parse = (config = {}, tools = {}, selection) =>
  resolveProject(root, 'kernel', config, tools, selection);
const configuration = () => ({
  machineProfiles: {
    normal: { memoryMiB: 64, cpuModel: 'qemu32', display: true },
    '低内存 环境': { memoryMiB: 16, display: false },
    inherited: {}
  },
  defaultMachineProfile: 'normal'
});

test('legacy project shape and QEMU resource arguments remain unchanged without profiles', () => {
  const args = ['-m', '32M', '-cpu', '486', '-smp', '1'];
  const result = parse({}, { qemuArgs: args });
  assert.equal(result.root, path.join(root, 'kernel'));
  assert.deepEqual(result.qemuArgs, args);
  assert.notEqual(result.qemuArgs, args);
  for (const field of [
    'machineProfiles',
    'defaultMachineProfile',
    'machineProfile',
    'displayMode',
    'displayModeSource'
  ])
    assert.equal(Object.hasOwn(result, field), false, field);
  assert.deepEqual(parse({ machineProfiles: {} }).machineProfiles, Object.create(null));
});

test('default profile resolves typed settings and overrides a disabled workspace display', () => {
  const result = parse(configuration(), { displayMode: 'off', qemuArgs: ['-m', '32M'] });
  assert.deepEqual(result.machineProfile, {
    name: 'normal',
    source: 'default',
    settings: { memoryMiB: 64, cpuModel: 'qemu32', display: true }
  });
  assert.equal(result.defaultMachineProfile, 'normal');
  assert.equal(result.displayMode, 'auto');
  assert.equal(result.displayModeSource, 'workspace');
  assert.deepEqual(result.qemuArgs, ['-m', '32M']);
});

test('launch and remembered selection each take precedence over the project default', () => {
  for (const source of ['launch', 'selected']) {
    const result = parse(configuration(), { displayMode: 'auto' }, { name: '低内存 环境', source });
    assert.deepEqual(result.machineProfile, {
      name: '低内存 环境',
      source,
      settings: { memoryMiB: 16, display: false }
    });
    assert.equal(result.displayMode, 'off');
  }
});

test('partial profiles inherit workspace values without synthesizing QEMU options', () => {
  const result = parse(
    configuration(),
    { displayMode: 'off', qemuArgs: ['-cpu', '486'] },
    {
      name: 'inherited',
      source: 'launch'
    }
  );
  assert.deepEqual(result.machineProfile.settings, {});
  assert.equal(result.displayMode, 'off');
  assert.equal(result.displayModeSource, 'workspace');
  assert.deepEqual(result.qemuArgs, ['-cpu', '486']);
  const defaults = parse({ machineProfiles: { empty: {} }, defaultMachineProfile: 'empty' });
  assert.equal(defaults.displayMode, undefined);
  assert.equal(defaults.displayModeSource, undefined);
});

test('profiles are not selected implicitly when no selection or default exists', () => {
  const result = parse({ machineProfiles: { only: { memoryMiB: 16 } } }, { displayMode: 'auto' });
  assert.equal(result.machineProfile, undefined);
  assert.equal(result.displayMode, 'auto');
  assert.equal(result.displayModeSource, 'workspace');
});

test('unknown or malformed selections fail instead of falling back to a valid default', () => {
  for (const name of ['missing', '', ' normal', null, 0, true, {}, ['normal']])
    assert.throws(() => parse(configuration(), {}, { name, source: 'launch' }), /方案/);
  assert.throws(() => parse(configuration(), {}, { name: 'normal', source: 'other' }), /来源/);
  assert.throws(() => parse({}, {}, { name: 'normal', source: 'selected' }), /不存在/);
});

test('all profiles and the default reference are validated even when another profile is selected', () => {
  const selected = { name: 'normal', source: 'launch' };
  assert.throws(
    () => parse({ ...configuration(), machineProfiles: { normal: {}, bad: { memoryMiB: 0 } } }, {}, selected),
    /bad.memoryMiB/
  );
  assert.throws(
    () => parse({ ...configuration(), defaultMachineProfile: 'missing' }, {}, selected),
    /不存在/
  );
  assert.throws(() => parse({ defaultMachineProfile: 'normal' }), /不存在/);
  for (const defaultMachineProfile of ['', null, 1])
    assert.throws(() => parse({ ...configuration(), defaultMachineProfile }), /defaultMachineProfile/);
});

test('profile containers and unknown fields reject malformed configuration and typos', () => {
  for (const machineProfiles of [null, false, 1, 'normal', []])
    assert.throws(() => parse({ machineProfiles }), /machineProfiles/);
  for (const profile of [null, false, 1, 'normal', []])
    assert.throws(() => parse({ machineProfiles: { bad: profile } }), /bad/);
  for (const key of ['memoryMB', 'cpu', 'displayMode', 'qemuArgs', 'constructor'])
    assert.throws(() => parse({ machineProfiles: { bad: { [key]: 1 } } }), /未知字段/);
});

test('profile names support Unicode and internal spaces while rejecting ambiguous names', () => {
  const names = ['低内存 环境', '🖥️ 调试', 'a'.repeat(64), '🧪'.repeat(64)];
  for (const name of names) {
    const result = parse({ machineProfiles: { [name]: {} }, defaultMachineProfile: name });
    assert.equal(result.machineProfile.name, name);
  }
  for (const name of [
    '',
    ' ',
    ' normal',
    'normal ',
    'a\nb',
    'a\tb',
    'a\0b',
    'a\x7fb',
    'a\x85b',
    'a'.repeat(65),
    '🧪'.repeat(65)
  ])
    assert.throws(() => parse({ machineProfiles: { [name]: {} } }), /方案名/);
});

test('memory is bounded to integral i386 MiB and partial profiles accept both endpoints', () => {
  for (const memoryMiB of [1, 4096])
    assert.equal(
      parse({ machineProfiles: { p: { memoryMiB } }, defaultMachineProfile: 'p' }).machineProfile.settings
        .memoryMiB,
      memoryMiB
    );
  for (const memoryMiB of [0, -1, 4097, 1.5, '64', null, true, undefined, NaN, Infinity])
    assert.throws(() => parse({ machineProfiles: { bad: { memoryMiB } } }), /memoryMiB/);
});

test('CPU accepts one model identifier and rejects feature options, whitespace and argument injection', () => {
  for (const cpuModel of ['486', 'qemu32', 'Cascadelake-Server-noTSX', 'model.name_1', 'a'.repeat(128)])
    assert.equal(
      parse({ machineProfiles: { p: { cpuModel } }, defaultMachineProfile: 'p' }).machineProfile.settings
        .cpuModel,
      cpuModel
    );
  for (const cpuModel of [
    '',
    ' qemu32',
    'qemu32 ',
    'qemu32,+sse',
    'qemu32 -m 1',
    '-m',
    'qemu32\0',
    'qemu32\n',
    'a'.repeat(129),
    null,
    1,
    undefined
  ])
    assert.throws(() => parse({ machineProfiles: { bad: { cpuModel } } }), /cpuModel/);
});

test('display uses strict booleans and validates workspace mode even with a profile override', () => {
  for (const display of [0, 1, 'false', null, undefined])
    assert.throws(() => parse({ machineProfiles: { bad: { display } } }), /display/);
  for (const displayMode of ['offf', '', false, null, 1])
    assert.throws(() => parse(configuration(), { displayMode }), /displayMode/);
  assert.equal(parse({}, { displayMode: 'auto' }).displayMode, 'auto');
  assert.equal(parse({}, { displayMode: 'off' }).displayMode, 'off');
});

test('prototype keys never resolve inherited profiles and own dangerous-looking names remain safe', () => {
  const inherited = Object.create({ inherited: { memoryMiB: 64 } });
  inherited.normal = {};
  assert.throws(
    () => parse({ machineProfiles: inherited }, {}, { name: 'inherited', source: 'launch' }),
    /不存在/
  );
  for (const name of ['constructor', 'toString', '__proto__'])
    assert.throws(() => parse({ machineProfiles: {} }, {}, { name, source: 'launch' }), /不存在/);
  const input = JSON.parse(
    '{"machineProfiles":{"__proto__":{"memoryMiB":16},"constructor":{"display":false}},"defaultMachineProfile":"__proto__"}'
  );
  const result = parse(input);
  assert.equal(Object.getPrototypeOf(result.machineProfiles), null);
  assert.equal(result.machineProfile.settings.memoryMiB, 16);
  assert.equal(result.machineProfiles.constructor.display, false);
  assert.equal({}.memoryMiB, undefined);
});

test('configuration, parsed profile catalogue, selected settings and later parses are isolated', () => {
  const input = configuration();
  const args = ['-m', '32M'];
  const first = parse(input, { qemuArgs: args });
  const second = parse(input, { qemuArgs: args });
  input.machineProfiles.normal.memoryMiB = 512;
  args[1] = '512M';
  assert.equal(first.machineProfiles.normal.memoryMiB, 64);
  assert.equal(first.machineProfile.settings.memoryMiB, 64);
  assert.deepEqual(first.qemuArgs, ['-m', '32M']);
  first.machineProfiles.normal.memoryMiB = 128;
  assert.equal(first.machineProfile.settings.memoryMiB, 64);
  first.machineProfile.settings.memoryMiB = 256;
  assert.equal(first.machineProfiles.normal.memoryMiB, 128);
  assert.equal(second.machineProfiles.normal.memoryMiB, 64);
  assert.equal(second.machineProfile.settings.memoryMiB, 64);
});
