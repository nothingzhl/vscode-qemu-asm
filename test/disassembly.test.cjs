const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decodeInstructions, disassemble } = require('../dist/debug/disassembly');

function registers(bits = 32, changes = {}) {
  return { cr0: 0x11, eflags: 2, cs: 8, cs_base: 0, cs_limit: 0xffffffff,
    cs_flags: bits === 32 ? 0xcf9b00 : 0x8f9b00, eip: 0x100000, ...changes };
}

function runtime(bytes, regs = registers(), start = regs.cs_base + regs.eip) {
  const calls = [];
  return {
    calls,
    async registers() { return regs; },
    async readMemory(address, size) {
      calls.push({ address, size });
      if (address < start || address + size > start + bytes.length) throw new Error('unmapped');
      return bytes.subarray(address - start, address - start + size);
    }
  };
}

test('16-bit decoding handles operand and address overrides and keeps linear addresses', () => {
  const decoded = decodeInstructions(Buffer.from('66b87856341267a178563412ea00800800', 'hex'), 16, 0x7c00);
  assert.deepEqual(decoded.map(item => [item.address, item.size, item.valid]), [[0x7c00, 6, true], [0x7c06, 6, true], [0x7c0c, 5, true]]);
  assert.equal(decoded[0].text, 'mov eax,0x12345678');
  assert.equal(decoded[1].text, 'mov ax,[dword 0x12345678]');
  assert.equal(decoded[2].text, 'jmp 0x0008:0x8000');
  assert.equal(decoded[0].bytes, '66b878563412');
});

test('32-bit source-free decoding preserves full addresses and relative call target', () => {
  const decoded = decodeInstructions(Buffer.from('5589e583ec08e80100000090c9c3', 'hex'), 32, 0x100000);
  assert.equal(decoded[1].text, 'mov ebp,esp');
  assert.equal(decoded[3].address, 0x100006);
  assert.equal(decoded[3].text, 'call 0x0010000c');
  assert.equal(decoded.at(-1).address, 0x10000d);
});

test('logical branch operands use CS-relative IP while row addresses stay linear', () => {
  const decoded = decodeInstructions(Buffer.from('eb02909090', 'hex'), 16, 0x7c10, 0x10);
  assert.equal(decoded[0].address, 0x7c10);
  assert.equal(decoded[0].text, 'jmp short 0x0014');
  const wide = decodeInstructions(Buffer.from('e80100000090c3', 'hex'), 32, 0x210000, 0x10000);
  assert.equal(wide[0].text, 'call 0x00010006');
  assert.equal(wide[0].address, 0x210000);
});

test('a 32-bit far-jump operand in 16-bit code keeps a full EIP target', () => {
  const decoded = decodeInstructions(Buffer.from('66ea200001000800', 'hex'), 16, 0x8000);
  assert.equal(decoded[0].text, 'jmp dword 0x0008:0x00010020');
  assert.equal(decoded[0].size, 8);
});

test('invalid and truncated encodings stop instead of inventing the next boundary', () => {
  for (const bytes of ['f00f', 'b834', 'f09090']) {
    const decoded = decodeInstructions(Buffer.from(bytes, 'hex'), 32, 0x100000);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].valid, false);
    assert.match(decoded[0].text, /无效|不完整/);
  }
  assert.throws(() => decodeInstructions(Buffer.alloc(4097), 32, 0), /4096/);
  assert.throws(() => decodeInstructions(Buffer.alloc(2), 32, 0xffffffff), /地址空间/);
  assert.throws(() => decodeInstructions(Buffer.alloc(0), 64, 0), /16 或 32/);
  assert.deepEqual(decodeInstructions(Buffer.alloc(0), 32, 0), []);
});

const nasm = process.env.NASM_PATH || ['/tmp/qemu-tools/usr/bin/nasm', '/usr/bin/nasm'].find(file => fs.existsSync(file));
test('actual NASM 16/32-bit encodings agree with decoder operands and boundaries', { skip: !nasm }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-disasm-nasm-'));
  try {
    for (const bits of [16, 32]) {
      const source = path.join(root, `code${bits}.asm`);
      const output = path.join(root, `code${bits}.bin`);
      fs.writeFileSync(source, `BITS ${bits}\nORG 0x10020\nmov eax,0x11223344\nmov ax,0x5566\njmp short done\nnop\ndone: ret\n`);
      const result = spawnSync(nasm, ['-f', 'bin', source, '-o', output], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const bytes = fs.readFileSync(output);
      const decoded = decodeInstructions(bytes, bits, 0x10020);
      assert.deepEqual(decoded.map(item => item.text.split(' ')[0]), ['mov', 'mov', 'jmp', 'nop', 'ret']);
      assert.equal(decoded[0].text, 'mov eax,0x11223344');
      assert.equal(decoded[1].text, 'mov ax,0x5566');
      assert.equal(decoded.at(-1).address + decoded.at(-1).size, 0x10020 + bytes.length);
      assert.ok(decoded.every(item => item.valid));
      assert.equal(decoded[0].size, bits === 16 ? 6 : 5);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime bitness follows cached CS.D, including protected16 EIP above 64 KiB', async () => {
  const bytes = Buffer.from('b8341266b878563412909090909090909090909090909090909090909090', 'hex');
  const r = runtime(bytes, registers(16, { eip: 0x10020 }));
  const result = await disassemble(r, { count: 2 });
  assert.equal(result.mode, 'protected16');
  assert.equal(result.bits, 16);
  assert.equal(result.address, 0x10020);
  assert.equal(result.pc, 0x10020);
  assert.equal(result.instructions[0].instruction, 'mov ax,0x1234');
  assert.equal(result.instructions[1].instruction, 'mov eax,0x12345678');
  assert.equal(result.nextAddress, 0x10029);
});

test('runtime applies nonzero CS base to formatter IP, never to displayed linear rows', async () => {
  const r = runtime(Buffer.from('eb02909090'.padEnd(30, '9'), 'hex'),
    { cr0: 0x10, cs: 0x7c0, cs_base: 0x7c00, cs_limit: 0xffff, cs_flags: 0x9b00, eip: 0x10 });
  const result = await disassemble(r, { count: 1 });
  assert.equal(result.mode, 'real16');
  assert.equal(result.instructions[0].address, '0x00007c10');
  assert.equal(result.instructions[0].instruction, 'jmp short 0x0014');
  await assert.rejects(disassemble(r, { address: 0x10, count: 1 }), /当前 CS/);
});

test('DAP byte and positive instruction offsets walk decoded boundaries exactly', async () => {
  const r = runtime(Buffer.concat([Buffer.from('905589e583ec0890c3', 'hex'), Buffer.alloc(100, 0x90)]));
  const result = await disassemble(r, { memoryReference: '0x00100000', offset: 1, instructionOffset: 2, instructionCount: 2 });
  assert.equal(result.address, 0x100001);
  assert.deepEqual(result.instructions.map(item => item.address), ['0x00100004', '0x00100007']);
  assert.equal(result.instructions[0].instruction, 'sub esp,0x8');
  assert.equal(result.instructions[0].instructionBytes, '83ec08');
});

test('unknown reverse boundaries use explicit invalid rows, followed by the real anchor', async () => {
  const r = runtime(Buffer.alloc(100, 0x90));
  const result = await disassemble(r, { instructionOffset: -2, instructionCount: 4 });
  assert.equal(result.instructions.length, 4);
  assert.deepEqual(result.instructions.slice(0, 2).map(item => item.address), ['0x000ffffe', '0x000fffff']);
  for (const item of result.instructions.slice(0, 2)) {
    assert.equal(item.presentationHint, 'invalid');
    assert.equal(item.instructionBytes, '');
    assert.equal(item.size, 0);
    assert.match(item.instruction, /未知前驱指令边界/);
  }
  assert.equal(result.instructions[2].address, '0x00100000');
  assert.equal(result.instructions[2].instruction, 'nop');
});

test('a known stopped-PC chain supplies verified predecessor instructions', async () => {
  const r = runtime(Buffer.concat([Buffer.from('5589e583ec0890c3', 'hex'), Buffer.alloc(100, 0x90)]));
  const result = await disassemble(r, { address: 0x100006, instructionOffset: -2, count: 4 });
  assert.deepEqual(result.instructions.map(item => item.address), ['0x00100001', '0x00100003', '0x00100006', '0x00100007']);
  assert.ok(result.instructions.every(item => !item.presentationHint));
});

test('a reference inside a preceding instruction never becomes a guessed predecessor', async () => {
  const r = runtime(Buffer.concat([Buffer.from('b87856341290', 'hex'), Buffer.alloc(100, 0x90)]));
  const result = await disassemble(r, { address: 0x100002, instructionOffset: -1, count: 2 });
  assert.equal(result.instructions[0].presentationHint, 'invalid');
  assert.match(result.instructions[0].instruction, /未知前驱/);
});

test('request validation rejects malformed counts and arithmetic wrap before memory reads', async () => {
  const r = runtime(Buffer.alloc(100, 0x90));
  for (const args of [{ count: 257 }, { count: 0 }, { count: 1.5 }, { address: '10h' }, { address: -1 },
    { address: 0xffffffff, offset: 1 }, { address: 0, offset: -1 }, { instructionOffset: -257 },
    { bits: 32 }, { offset: '1' }, [], null]) {
    await assert.rejects(disassemble(r, args));
  }
  assert.equal(r.calls.length, 0);
});

test('paging and unsupported execution modes are rejected before decoding', async () => {
  for (const changes of [{ cr0: 0x80000011 }, { eflags: 1 << 17 }, { efer: 1 << 10 }, { smm: 1 }]) {
    const r = runtime(Buffer.alloc(100, 0x90), registers(32, changes));
    await assert.rejects(disassemble(r, { count: 1 }));
    assert.equal(r.calls.length, 0);
  }
});

test('unmapped tails return bounded partial decoding and exact native instruction count', async () => {
  const r = runtime(Buffer.from('5589e590c3', 'hex'));
  const result = await disassemble(r, { count: 16 });
  assert.equal(result.instructions.length, 16);
  assert.equal(result.instructions[0].instruction, 'push ebp');
  assert.ok(result.instructions.some(item => item.presentationHint === 'invalid'));
  assert.ok(r.calls.length <= 13);
  assert.ok(r.calls.every(call => call.size <= 4096));
  const exact = runtime(Buffer.from('66ea200001000800', 'hex'), registers(16, { eip: 0x8000 }));
  const jump = await disassemble(exact, { count: 1 });
  assert.equal(jump.instructions[0].instruction, 'jmp dword 0x0008:0x00010020');
  assert.equal(jump.instructions[0].presentationHint, undefined);
});

test('architectural segment translation wraps while each memory read stays linear and bounded', async () => {
  const r = runtime(Buffer.alloc(32, 0x90), registers(32, { cs_base: 0x1000, eip: 0xfffffff0 }), 0xff0);
  const result = await disassemble(r, { count: 1 });
  assert.equal(result.pc, 0xff0);
  assert.equal(result.instructions[0].address, '0x00000ff0');
  assert.equal(result.instructions[0].instruction, 'nop');
  assert.equal(r.calls[0].address, 0xff0);
  assert.ok(r.calls[0].size <= 16);
});

test('segment and address-space ends never wrap reads or fabricate valid instructions', async () => {
  const r = runtime(Buffer.from('90', 'hex'), registers(32, { cs_base: 0xfffffff0, cs_limit: 0xf, eip: 0xf }));
  const result = await disassemble(r, { count: 3, instructionOffset: -1 });
  assert.equal(r.calls[0].size, 1);
  assert.equal(result.instructions.length, 3);
  assert.equal(result.instructions[1].address, '0xffffffff');
  assert.equal(result.instructions[1].instruction, 'nop');
  assert.equal(result.instructions[2].presentationHint, 'invalid');
  assert.equal(result.nextAddress, 0x100000000);
  const zero = runtime(Buffer.alloc(32, 0x90), registers(32, { eip: 0 }));
  const start = await disassemble(zero, { instructionOffset: -2, count: 3 });
  assert.ok(start.instructions.slice(0, 2).every(item => item.address === '0x00000000' && item.presentationHint === 'invalid'));
});
