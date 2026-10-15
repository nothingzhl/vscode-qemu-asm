const fs = require('node:fs/promises');
const path = require('node:path');
const core = require('../dist/core');

const HIGH_CODE = 0xc0000000;
const HIGH_CALL = HIGH_CODE + 5;
const HIGH_WRITE = HIGH_CODE + 10;
const HIGH_READ = HIGH_CODE + 12;
const HIGH_AFTER_READ = HIGH_CODE + 14;
const HIGH_DATA = 0xc0100000;
const HIGH_READONLY = 0xc0101000;
const HIGH_MISSING = 0xc0102000;
const HIGH_STACK = 0xc0201000;
const HIGH_GDT = 0xc0300000;
const CODE_PHYSICAL = 0x200000;
const DATA_PHYSICAL = 0x210000;
const PD = 0x100000;
const LOW_PT = 0x101000;
const HIGH_PT = 0x102000;
const BIG_VIRTUAL = 0x80000000;
const BIG_PHYSICAL = 0x400000;

// This firmware is exclusively a disposable integration fixture. It does not
// add another teaching template to the extension. Page structures deliberately
// lack an identity mapping, and the copied high code has no NASM source entry.
const source = `bits 16
org 0x8000
cli
xor ax, ax
mov ds, ax
in al, 0x92
or al, 2
out 0x92, al
lgdt [gdt_pointer]
mov eax, cr0
or eax, 1
mov cr0, eax
jmp 0x08:protected_entry
align 8
gdt: dq 0
dq 0x00cf9a000000ffff
dq 0x00cf92000000ffff
gdt_end:
gdt_pointer: dw gdt_end-gdt-1
dd gdt
high_gdt_pointer: dw gdt_end-gdt-1
dd 0xc0300000
bits 32
protected_entry:
mov ax, 0x10
mov ds, ax
mov es, ax
mov ss, ax
mov esp, 0x90000
xor ebp, ebp
cld
mov edi, 0x100000
xor eax, eax
mov ecx, 0x3000/4
rep stosd
mov edi, 0x101000
mov eax, 3
mov ecx, 256
identity_loop:
stosd
add eax, 0x1000
loop identity_loop
mov dword [0x100000], 0x101003
mov dword [0x100000+512*4], 0x400083
mov dword [0x100000+768*4], 0x102007
mov dword [0x101000+512*4], 0x220003
mov dword [0x102000], 0x200003
mov dword [0x102000+256*4], 0x210007
mov dword [0x102000+257*4], 0x211005
mov dword [0x102000+512*4], 0x230003
mov dword [0x102000+513*4], 0x231003
mov dword [0x102000+768*4], 0x240003
mov esi, payload
mov edi, 0x200000
mov ecx, payload_end-payload
rep movsb
mov esi, gdt
mov edi, 0x240000
mov ecx, gdt_end-gdt
rep movsb
mov dword [0x210000], 0
mov dword [0x210ffc], 0x11223344
mov dword [0x211000], 0x55667788
mov dword [0x220000], 0xaabbccdd
mov dword [0x400120], 0x99887766
mov eax, cr4
or eax, 0x10
mov cr4, eax
mov eax, 0x100000
mov cr3, eax
before_paging:
nop
mov eax, cr0
or eax, 0x80010000
mov cr0, eax
lgdt [high_gdt_pointer]
mov esp, 0xc0201000
mov edi, 0xb8000
mov esi, message
mov ah, 0x0a
screen_loop:
lodsb
test al, al
jz screen_done
stosw
jmp screen_loop
screen_done:
mov edi, 0xc0100000
jmp 0x08:0xc0000000
payload:
db 0xb8,0x40,0,0,0
db 0xe8,7,0,0,0
db 0xff,0x07
db 0x8b,0x1f
db 0x90
db 0xeb,0xf9
db 0x40,0xc3
payload_end:
message: db 'PAGING ACTIVE - VIRTUAL DEBUG',0
times 1024-($-$$) db 0
`;

async function fixture(root, options = {}) {
  await core.createProject(root, 'protected');
  const sourcePath = path.join(root, 'stage2.asm');
  let text = source;
  if (options.remapSource) {
    text = text.replace('mov eax, 0x100000\nmov cr3, eax', `mov esi, 0x8000
mov edi, 0x250000
mov ecx, 1024
rep movsb
mov dword [0x101000+8*4], 0x250003
mov byte [0x250000+remap_probe-0x8000], 0xe8
mov dword [0x250000+remap_probe-0x8000+1], 0xc0000011-remap_probe-5
mov eax, 0x100000
mov cr3, eax`);
    text = text.replace('lgdt [high_gdt_pointer]', `lgdt [high_gdt_pointer]
mov eax, 0x40
remap_probe:
nop
nop
nop
nop
nop`);
  }
  await fs.writeFile(sourcePath, text);
  return {
    root, source: sourcePath, text,
    line(instruction) {
      const line = text.split('\n').findIndex(line => line.trim() === instruction) + 1;
      if (!line) throw new Error(`Missing paging fixture instruction ${instruction}`);
      return line;
    }
  };
}

module.exports = { fixture, source, HIGH_CODE, HIGH_CALL, HIGH_WRITE, HIGH_READ, HIGH_AFTER_READ,
  HIGH_DATA, HIGH_READONLY, HIGH_MISSING, HIGH_STACK, HIGH_GDT, CODE_PHYSICAL, DATA_PHYSICAL,
  PD, LOW_PT, HIGH_PT, BIG_VIRTUAL, BIG_PHYSICAL };
