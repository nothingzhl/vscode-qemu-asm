const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseListing } = require('../dist/debug/listing');

const fixturePath = path.join(__dirname, 'fixtures', 'debug-boot.asm');
const source = syncFs.readFileSync(fixturePath, 'utf8');
const listing = syncFs.readFileSync(path.join(__dirname, 'fixtures', 'debug-boot.lst'), 'utf8');
const lineOf = (text, input = source) => input.split('\n').findIndex(line => line.includes(text)) + 1;
// A small fixture builder is also used for deliberately malformed listing rows.
function row(line, offset, bytes, text = '') {
  return `${String(line).padStart(6)} ${offset === undefined ? '        ' : offset.toString(16).toUpperCase().padStart(8, '0')} ${bytes.padEnd(24)}${text}`;
}
function tinySource(body) { return `bits 16\norg 0x7c00\n${body}\n`; }
function tinyListing(bodyRows) { return [row(1, undefined, '', 'bits 16'), row(2, undefined, '', 'org 0x7c00'), ...bodyRows].join('\n'); }

test('real NASM boot listing maps far jump, call, push/pop and exact executable lines', () => {
  const map = parseListing(listing, fixturePath, source);
  assert.equal(map.sourcePath, fixturePath);
  assert.equal(map.origin, 0x7c00);
  const jump = map.forLine(lineOf('jmp 0x0000:boot'));
  assert.equal(jump.address, 0x7c00);
  assert.equal(jump.size, 5); // NASM displays the offset relocation as EA[0500]0000.
  assert.equal(map.forAddress(0x7c04), jump);
  for (const instruction of ['call worker', 'push bp', 'push ax', 'pop ax', 'pop bp', 'ret']) {
    assert(map.forLine(lineOf(instruction)), `${instruction} must be executable`);
  }
  for (const text of ['bits 16', 'org 0x7c00', '; 用于', 'boot:', 'worker:', 'message db', 'times 510', 'dw 0xaa55']) {
    assert.equal(map.forLine(lineOf(text)), undefined, `${text} must not accept a breakpoint`);
  }
  assert.equal(map.forLine(999), undefined);
  assert.equal(map.forAddress(0xf0000), undefined, 'BIOS must not map to the last source instruction');
  assert.equal(map.forAddress(0x7bff), undefined);
  assert.equal(map.forAddress(0x7dfe), undefined, 'boot signature is data');
  const last = map.entries.at(-1);
  assert.equal(map.forAddress(last.address + last.size), undefined, 'following message data is not executable');
});

test('instruction continuations are one mapping; zero-length alignment has no breakpoint', () => {
  const text = tinySource('mov dword [eax + ecx*4 + 0x12345678], 0x12345678\nalign 1\nnop');
  const input = tinyListing([
    row(3, 0, '6766C7848878563412-', text.split('\n')[2]),
    row(3, 9, '78563412'),
    row(4, undefined, '', 'align 1'),
    row(5, 13, '90', 'nop')
  ]);
  const map = parseListing(input, 'boot.asm', text);
  assert.equal(map.forLine(3).size, 13);
  assert.equal(map.forAddress(0x7c0c).line, 3);
  assert.equal(map.forLine(4), undefined);
  assert.equal(map.forAddress(0x7c0d).line, 5);
});

test('listing data continuations, repetitions, reservations and alignment stay unmapped', () => {
  const text = tinySource("db 'a;b:c', 0\ntimes 2 dw 0\nresb 16\nalign 16\nnop");
  const map = parseListing(tinyListing([
    row(3, 0, '613B623A6300', "db 'a;b:c', 0"),
    row(4, 6, '0000<rep 2h>', 'times 2 dw 0'),
    row(5, 10, '<res 10h>', 'resb 16'),
    row(5, undefined, '******************', ' warning: zeroing'),
    row(6, 26, '90<rep 6h>', 'align 16'),
    row(7, 32, '90', 'nop')
  ]), 'boot.asm', text);
  assert.equal(map.entries.length, 1);
  assert.equal(map.forLine(7).address, 0x7c20);
  assert.equal(map.forAddress(0x7c10), undefined);
});

test('ambiguous preprocessing, repeat instructions, sections and modes fail explicitly', () => {
  for (const statement of [
    '%include "other.asm"', '%macro m 0', '%if 1', 'section .text', '[section .text]', 'segment .text',
    'incbin "other.bin"', 'times 2 nop', 'times 2 mov ax, db', 'absolute 0', 'cpu 386',
    'bits 32', '[bits 32]', 'org 0', 'org 0x7c00', 'org 0x7000+0xc00', 'mov ax, \\',
    'lock', '__?SECT?__', 'bare_label_without_colon'
  ]) {
    assert.throws(() => parseListing('', 'boot.asm', tinySource(statement)), /无法建立调试源码映射/, statement);
  }
  assert.throws(() => parseListing('', 'boot.asm', 'org 0x7c00\nnop\n'), /显式 BITS 16/);
  assert.throws(() => parseListing('', 'boot.asm', 'bits 16\nnop\n'), /显式 BITS 16/);
});

test('literal origin/bits accept NASM bracket syntax and quoted percent/semicolon data', () => {
  const text = "[BITS 0x10]\r\n[ORG 7c00h]\r\nmsg db '%;中文', 0\r\nnop\r\n";
  const input = [
    row(1, undefined, '', '[BITS 0x10]'), row(2, undefined, '', '[ORG 7c00h]'),
    row(3, 0, '253BE4B8ADE6968700', "msg db '%;中文', 0"), row(4, 9, '90', 'nop')
  ].join('\r\n');
  const map = parseListing(input, '中文.asm', text);
  assert.equal(map.origin, 0x7c00);
  assert.equal(map.forLine(3), undefined);
  assert.equal(map.forLine(4).address, 0x7c09);
});

test('stale, incomplete, duplicate and disjoint listings cannot invent source locations', () => {
  const text = tinySource('nop\nhlt');
  const rows = [row(3, 0, '90', 'nop'), row(4, 1, 'F4', 'hlt')];
  assert.throws(() => parseListing(tinyListing(rows), 'boot.asm', text.replace('hlt', 'ret')), /内容不同/);
  assert.throws(() => parseListing(tinyListing(rows.slice(0, 1)), 'boot.asm', text), /缺少/);
  for (const offset of [0, 2]) {
    assert.throws(() => parseListing(tinyListing([rows[0], row(4, offset, 'F4', 'hlt')]), 'boot.asm', text), /地址重复或不连续/);
  }
  assert.throws(() => parseListing(tinyListing([row(3, 0, '90-', 'nop'), row(3, 0, '90')]), 'boot.asm', tinySource('nop')), /地址重复/);
  assert.throws(() => parseListing(tinyListing([row(3, 0, '90<rep 10h>', 'nop')]), 'boot.asm', tinySource('nop')), /超过一条/);
  assert.throws(() => parseListing(tinyListing([row(3, 0, 'ZZ', 'nop')]), 'boot.asm', tinySource('nop')), /机器码字段/);
});

const nasm = [process.env.NASM_PATH, 'nasm'].filter(Boolean)
  .find(candidate => spawnSync(candidate, ['-v'], { encoding: 'utf8' }).status === 0);
test('actual NASM handles Chinese/spaced source paths, tabs, continuation and alignment', { skip: !nasm }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm listing 中文 '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, '中文 boot.asm');
  const output = path.join(root, 'boot.img');
  const list = path.join(root, 'boot.lst');
  const text = tinySource(
    '\tjmp 0x0000:start\nstart:\n\tmov dword [eax + ecx*4 + 0x12345678], 0x12345678\n' +
    '\talign 1\n\tcall work\n\thlt\nwork:\n\tpush ax\n\tpop ax\n\tret\n' +
    "message db '中文;字符串%', 0\ntimes 510-($-$$) db 0\ndw 0xaa55"
  );
  await fs.writeFile(input, text);
  const result = spawnSync(nasm, ['-f', 'bin', input, '-o', output, '-l', list], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const map = parseListing(await fs.readFile(list, 'utf8'), input, text);
  assert.equal((await fs.stat(output)).size, 512);
  assert.equal(map.forLine(lineOf('mov dword', text)).size, 13);
  assert.equal(map.forLine(lineOf('align 1', text)), undefined);
  assert.equal(map.forLine(lineOf('jmp 0x0000:start', text)).size, 5);
  assert.equal(map.forLine(lineOf('push ax', text)).text, '\tpush ax');
  assert.equal(map.forLine(lineOf('message db', text)), undefined);
});
