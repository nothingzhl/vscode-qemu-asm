const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SourceMap, parseListing } = require('../dist/debug/listing');
const { SourceMaps } = require('../dist/debug/maps');

const fixturePath = path.join(__dirname, 'fixtures', 'debug-boot.asm');
const source = syncFs.readFileSync(fixturePath, 'utf8');
const listing = syncFs.readFileSync(path.join(__dirname, 'fixtures', 'debug-boot.lst'), 'utf8');
const stagePath = path.join(__dirname, 'fixtures', 'mixed-stage2.asm');
const stageSource = syncFs.readFileSync(stagePath, 'utf8');
const stageListing = syncFs.readFileSync(path.join(__dirname, 'fixtures', 'mixed-stage2.lst'), 'utf8');
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

test('ambiguous preprocessing, repeat instructions, sections and unsupported modes fail explicitly', () => {
  for (const statement of [
    '%include "other.asm"', '%macro m 0', '%if 1', 'section .text', '[section .text]', 'segment .text',
    'incbin "other.bin"', 'times 2 nop', 'times 2 mov ax, db', 'absolute 0', 'cpu 386',
    'bits 64', '[bits 64]', 'bits 8', 'org 0', 'org 0x7c00', 'org 0x7000+0xc00', 'mov ax, \\',
    'lock', '__?SECT?__', 'bare_label_without_colon'
  ]) {
    assert.throws(() => parseListing('', 'boot.asm', tinySource(statement)), /无法建立调试源码映射/, statement);
  }
  assert.throws(() => parseListing('', 'boot.asm', 'org 0x7c00\nnop\n'), /显式 BITS 16/);
  assert.throws(() => parseListing('', 'boot.asm', 'bits 16\nnop\n'), /显式 BITS 16/);
  assert.throws(() => parseListing('', 'boot.asm', 'bits 32\norg 0x7c00\nnop\n'), /显式声明 BITS 16/);
});

test('real NASM mixed stage listing retains each instruction mode and complete image span', () => {
  const map = parseListing(stageListing, stagePath, stageSource, { loadAddress: 0x8000, maxBytes: 4096 });
  assert.equal(map.origin, 0x8000);
  assert.equal(map.byteLength, 640);
  const jump = map.forLine(lineOf('jmp 0x08:protected_entry', stageSource));
  assert.equal(jump.bits, 16);
  assert.equal(jump.size, 5);
  assert.equal(map.forLine(lineOf('mov eax, 0x12345678', stageSource)).bits, 32);
  assert.equal(map.forLine(lineOf('mov eax, 0x12345678', stageSource)).size, 5);
  assert.equal(map.forLine(lineOf('call worker', stageSource)).bits, 32);
  assert.equal(map.forLine(lineOf('call worker', stageSource)).size, 5);
  assert.equal(map.forLine(lineOf('push ebp', stageSource)).size, 1);
  assert.equal(map.forLine(lineOf('mov ebp, esp', stageSource)).size, 2);
  assert.equal(map.forLine(lineOf('pop ebp', stageSource)).bits, 32);
  for (const item of ['bits 32', 'gdt:', 'dq 0', 'dd gdt', 'message db', 'times 640']) {
    assert.equal(map.forLine(lineOf(item, stageSource)), undefined, item);
  }
  assert.equal(map.forAddress(0x8000 + 639), undefined, 'padding must not become an instruction');
  assert.throws(() => parseListing(stageListing, stagePath, stageSource), /ORG 0x7c00/);
  assert.throws(() => parseListing(stageListing, stagePath, stageSource, { loadAddress: 0x8000 }), /512 字节/);
  assert.throws(() => parseListing(stageListing, stagePath, stageSource, { loadAddress: 0x8100, maxBytes: 4096 }), /ORG 0x8100/);
  assert.throws(() => parseListing(stageListing, stagePath, stageSource.replace('push ebp', 'push eax'), { loadAddress: 0x8000, maxBytes: 4096 }), /内容不同/);
  assert.throws(() => parseListing(stageListing, stagePath, stageSource.replace('bits 32', 'bits 64'), { loadAddress: 0x8000, maxBytes: 4096 }), /不支持 64 位/);
});

test('mode declarations can switch back to 16 bits and pure 32-bit stages need an explicit initial mode', () => {
  const text = tinySource('nop\nbits 32\nmov eax, ebx\nbits 16\nret');
  const input = tinyListing([
    row(3, 0, '90', 'nop'), row(4, undefined, '', 'bits 32'),
    row(5, 1, '89D8', 'mov eax, ebx'), row(6, undefined, '', 'bits 16'), row(7, 3, 'C3', 'ret')
  ]);
  const map = parseListing(input, 'boot.asm', text);
  assert.deepEqual(map.entries.map(entry => entry.bits), [16, 32, 16]);
  const pure = 'bits 32\norg 0x100000\nmov eax, ebx\n';
  const pureListing = [row(1, undefined, '', 'bits 32'), row(2, undefined, '', 'org 0x100000'), row(3, 0, '89D8', 'mov eax, ebx')].join('\n');
  assert.equal(parseListing(pureListing, 'kernel.asm', pure, { loadAddress: 0x100000, initialBits: 32 }).forLine(3).bits, 32);
  assert.throws(() => parseListing(pureListing, 'kernel.asm', pure, { loadAddress: 0x100000 }), /显式声明 BITS 16/);
});

test('automatic initial mode accepts either first BITS declaration and rejects instructions before it', () => {
  const options = { loadAddress: 0x8000, maxBytes: 4096, initialBits: 'auto' };
  const mixed = parseListing(stageListing, stagePath, stageSource, options);
  assert.equal(mixed.forLine(lineOf('jmp 0x08:protected_entry', stageSource)).bits, 16);
  assert.equal(mixed.forLine(lineOf('mov eax, 0x12345678', stageSource)).bits, 32);
  for (const instruction of ['nop', 'start: mov eax, ebx', 'rep movsb']) {
    const beforeBits = `org 0x8000\nheader db 0\n${instruction}\nbits 32\nhlt\n`;
    assert.throws(() => parseListing('', 'stage.asm', beforeBits, options), /首条可执行指令之前显式声明 BITS 16 或 BITS 32/, instruction);
  }
  assert.throws(() => parseListing('', 'stage.asm', 'org 0x8000\nheader db 0\n', options), /显式 BITS 16 或 BITS 32/);
  for (const declaration of ['bits 64', '[BITS 8]', 'bits MODE']) {
    assert.throws(() => parseListing('', 'stage.asm', `org 0x8000\n${declaration}\nnop\n`, options), /不支持 64 位代码|数字常量/);
  }
});

test('fixed load spans may cross 16-bit boundaries but must fit configured size and unsigned 32-bit addresses', () => {
  const text = 'bits 16\norg 0xffff\nnop\nhlt\n';
  const input = [row(1, undefined, '', 'bits 16'), row(2, undefined, '', 'org 0xffff'), row(3, 0, '90', 'nop'), row(4, 1, 'F4', 'hlt')].join('\n');
  const map = parseListing(input, 'stage.asm', text, { loadAddress: 0xffff, maxBytes: 2 });
  assert.equal(map.forLine(4).address, 0x10000);
  assert.equal(map.byteLength, 2);
  assert.throws(() => parseListing(input, 'stage.asm', text, { loadAddress: 0xffff, maxBytes: 1 }), /长度上限/);
  const topSource = text.replace('0xffff', '0xffffffff');
  const topListing = input.replace('org 0xffff', 'org 0xffffffff');
  assert.throws(() => parseListing(topListing, 'stage.asm', topSource, { loadAddress: 0xffffffff, maxBytes: 2 }), /32 位地址范围/);
  const last = parseListing(topListing.split('\n').slice(0, -1).join('\n'), 'last.asm', topSource.replace('hlt\n', ''), { loadAddress: 0xffffffff, maxBytes: 1 });
  assert.equal(last.forAddress(0xffffffff).line, 3);
  for (const options of [{ loadAddress: -1 }, { loadAddress: 0x100000000 }, { loadAddress: 1.5 }, { maxBytes: 0 }, { maxBytes: Infinity }, { initialBits: 64 }]) {
    assert.throws(() => parseListing('', 'stage.asm', '', options), /无法建立调试源码映射/);
  }
});

test('aggregate maps find each source and stage while rejecting overlapping code or data spans', () => {
  const boot = parseListing(listing, fixturePath, source);
  const stage = parseListing(stageListing, stagePath, stageSource, { loadAddress: 0x8000, maxBytes: 4096 });
  const maps = new SourceMaps([stage, boot]);
  assert.equal(maps.forSource(fixturePath), boot);
  assert.equal(maps.forSource(path.join(path.dirname(stagePath), '.', path.basename(stagePath))), stage);
  assert.equal(maps.forSource('missing.asm'), undefined);
  assert.equal(maps.forAddress(0x7c00).map, boot);
  assert.equal(maps.forAddress(stage.entries[0].address).map, stage);
  assert.equal(maps.forAddress(stage.entries[0].address).entry, stage.entries[0]);
  for (const address of [0x7dfe, 0x7f00, 0x8000 + 639, 0xf0000, -1, 1.5, 0x100000000]) assert.equal(maps.forAddress(address), undefined);
  const overlap = new SourceMap('overlap.asm', 0x7df0, [{ line: 1, address: 0x7e00, size: 1, text: 'nop' }]);
  assert.throws(() => new SourceMaps([boot, overlap]), /加载地址重叠/, 'boot data padding is occupied even without executable source');
  assert.throws(() => new SourceMaps([boot, boot]), /源码重复/);
  const adjacent = new SourceMap('adjacent.asm', 0x7e00, [{ line: 1, address: 0x7e00, size: 1, text: 'nop' }]);
  assert.equal(new SourceMaps([boot, adjacent]).forAddress(0x7e00).map, adjacent);
  const empty = new SourceMap('empty.asm', 0x7c01, []);
  assert.equal(new SourceMaps([boot, empty]).forAddress(0x7c04).map, boot);
  assert.equal(adjacent.forLine(1).bits, undefined, 'legacy manual SourceEntry objects remain accepted');
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

test('actual NASM independently builds mixed stage and accepts command-line constants without preprocessing source', { skip: !nasm }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm stage listing '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'stage2.bin');
  const list = path.join(root, 'stage2.lst');
  const result = spawnSync(nasm, ['-f', 'bin', stagePath, '-o', output, '-l', list], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const map = parseListing(await fs.readFile(list, 'utf8'), stagePath, stageSource, { loadAddress: 0x8000, maxBytes: 4096 });
  assert.equal((await fs.stat(output)).size, 640);
  assert.equal(map.forLine(lineOf('jmp 0x08:protected_entry', stageSource)).size, 5);
  assert.equal(map.forLine(lineOf('call worker', stageSource)).size, 5);
  const automatic = parseListing(await fs.readFile(list, 'utf8'), stagePath, stageSource, { loadAddress: 0x8000, maxBytes: 4096, initialBits: 'auto' });
  assert.deepEqual(automatic.entries, map.entries, 'auto must retain both actual NASM instruction modes');
  const bootSource = tinySource('mov al, STAGE2_SECTORS\nhlt');
  const bootPath = path.join(root, 'boot.asm');
  await fs.writeFile(bootPath, bootSource);
  const bootResult = spawnSync(nasm, ['-f', 'bin', '-D', 'STAGE2_SECTORS=2', bootPath, '-o', output, '-l', list], { encoding: 'utf8' });
  assert.equal(bootResult.status, 0, bootResult.stderr);
  const boot = parseListing(await fs.readFile(list, 'utf8'), bootPath, bootSource);
  assert.equal(boot.forLine(3).size, 2);
  assert.equal(boot.forLine(3).bits, 16);
});

test('actual NASM pure 32-bit stage detects its initial mode after ORG, comments and data', { skip: !nasm }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asm pure32 listing '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'kernel.asm');
  const output = path.join(root, 'kernel.bin');
  const list = path.join(root, 'kernel.lst');
  const text = "; BITS 64 here is a comment\n[ORG 100000h]\nheader db 'BITS 16;%', 0\n" +
    '[BITS 32] ; initial mode declared after data\nentry:\nmov eax, 0x12345678\ncall worker\nhlt\n' +
    'worker:\npush ebp\nmov ebp, esp\npop ebp\nret\n';
  await fs.writeFile(input, text);
  const result = spawnSync(nasm, ['-f', 'bin', input, '-o', output, '-l', list], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actualListing = await fs.readFile(list, 'utf8');
  const map = parseListing(actualListing, input, text, { loadAddress: 0x100000, initialBits: 'auto' });
  assert.equal(map.origin, 0x100000);
  assert.equal(map.byteLength, (await fs.stat(output)).size);
  assert(map.entries.every(entry => entry.bits === 32));
  assert.equal(map.forLine(lineOf('mov eax, 0x12345678', text)).size, 5);
  assert.equal(map.forLine(lineOf('call worker', text)).size, 5);
  assert.equal(map.forLine(lineOf('push ebp', text)).size, 1);
  assert.equal(map.forLine(lineOf('mov ebp, esp', text)).size, 2);
  assert.equal(map.forLine(lineOf('header db', text)), undefined);
  assert.equal(map.forAddress(0x100000), undefined);
  assert.throws(() => parseListing(actualListing, input, text, { loadAddress: 0x100000 }), /显式声明 BITS 16/, 'default API must still require initial 16-bit code');
});
