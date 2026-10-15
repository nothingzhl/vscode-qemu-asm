const test = require('node:test');
const assert = require('node:assert/strict');
const { cpuMode, instructionAddress, stackAddress, stackWidth, monitorRegisters } = require('../dist/debug/runtime');

function protectedRegisters(changes = {}) {
  return {
    cr0: 0x11, eflags: 2, cs: 8, cs_base: 0, cs_limit: 0xffffffff, cs_flags: 0xcf9b00,
    ss: 16, ss_base: 0, ss_limit: 0xffffffff, ss_flags: 0xcf9300, eip: 0x10020, esp: 0x1fff8,
    ...changes
  };
}

test('CPU transition keeps the cached 16-bit CS until the protected far jump', () => {
  const before = { cr0: 0x10, cs: 0x7c0, cs_base: 0x7c00, cs_limit: 0xffff, cs_flags: 0x9b00, eip: 0x10 };
  assert.equal(cpuMode(before), 'real16');
  assert.equal(instructionAddress(before), 0x7c10);
  assert.equal(instructionAddress({ ...before, eip: 0x12340010 }), 0x7c10);
  const transition = { ...before, cr0: 0x11 };
  assert.equal(cpuMode(transition), 'protected16');
  assert.equal(instructionAddress(transition), 0x7c10);
  const flat32 = protectedRegisters();
  assert.equal(cpuMode(flat32), 'protected32');
  assert.equal(instructionAddress(flat32), 0x10020);
  assert.equal(instructionAddress(protectedRegisters({ cs_base: 0x200000 })), 0x210020);
  assert.equal(instructionAddress(protectedRegisters({ cs_base: 0xfffffff0, eip: 0x20 })), 0x10);
});

test('16-bit protected code preserves full EIP after an operand-size overridden far jump', () => {
  const registers = protectedRegisters({ cr0: 0x11, cs: 8, cs_base: 0, cs_limit: 0xffffffff, cs_flags: 0x8f9b00, eip: 0x10020 });
  assert.equal(cpuMode(registers), 'protected16');
  assert.equal(instructionAddress(registers), 0x10020);
});

test('stack address width follows SS.B independently of CS.D', () => {
  const wideCodeNarrowStack = protectedRegisters({ ss: 0, ss_base: 0x2000, ss_limit: 0xffff, ss_flags: 0x9300, esp: 0x12340020 });
  assert.equal(stackWidth(wideCodeNarrowStack), 2);
  assert.equal(stackAddress(wideCodeNarrowStack), 0x2020);
  assert.equal(stackAddress(wideCodeNarrowStack, 0xffff0010), 0x2010);
  const wideStack = protectedRegisters({ ss_base: 0x100000 });
  assert.equal(stackWidth(wideStack), 4);
  assert.equal(stackAddress(wideStack), 0x11fff8);
  assert.equal(stackAddress(wideStack, 0x1fffc), 0x11fffc);
  assert.equal(stackWidth(protectedRegisters({ cs_flags: 0x9b00 })), 4);
  assert.equal(stackAddress({ cr0: 0, ss: 0x700, esp: 0x12345678 }), 0xc678);
});

test('CPU mode rejects paging, VM86, SMM, long mode and malformed code descriptors', () => {
  assert.throws(() => cpuMode(protectedRegisters({ cr0: 0x80000011 })), /分页/);
  assert.throws(() => cpuMode(protectedRegisters({ eflags: 1 << 17 })), /8086/);
  assert.throws(() => cpuMode(protectedRegisters({ smm: 1 })), /SMM/);
  assert.throws(() => cpuMode(protectedRegisters({ efer: 1 << 10 })), /LMA/);
  assert.throws(() => cpuMode(protectedRegisters({ cs_flags: 0xaf9b00 })), /CS.L/);
  for (const flags of [0xcf1b00, 0xcf9300, 0xcf8900]) {
    assert.throws(() => cpuMode(protectedRegisters({ cs_flags: flags })), /可执行代码段/);
  }
  assert.throws(() => cpuMode(protectedRegisters({ cs_flags: undefined })), /CS 段缓存/);
  assert.throws(() => cpuMode(protectedRegisters({ cr0: 0, ds: 0, ds_base: 0x100000 })), /unreal/);
  assert.throws(() => stackAddress(protectedRegisters({ ss_flags: undefined })), /SS 段缓存/);
});

test('monitor exposes control registers and keeps protected segment bases and flags', () => {
  const text = ['ES', 'CS', 'SS', 'DS', 'FS', 'GS'].map(name => `${name} =0008 00100000 ffffffff 00cf9b00\r\n`).join('') +
    'CR0=00000011 CR2=12345000 CR3=00400000 CR4=00000020\r\nEFER=0000000000000100\r\n';
  const registers = monitorRegisters(text);
  assert.equal(registers.cr0, 0x11);
  assert.equal(registers.cr2, 0x12345000);
  assert.equal(registers.cr3, 0x400000);
  assert.equal(registers.cr4, 0x20);
  assert.equal(registers.efer, 0x100);
  assert.equal(registers.cs_base, 0x100000);
  assert.equal(registers.cs_flags, 0xcf9b00);
});
