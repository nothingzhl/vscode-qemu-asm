const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CODE_VIRTUAL = 0xc0000000;
const CODE_PHYSICAL = 0x200000;
const STACK_VIRTUAL = 0xc0201000;
const PD = 0x100000;
const HIGH_PT = 0x102000;

// Disposable compiler input for actual integration tests, never an installed
// teaching template. The kernel runs at a different virtual/physical address.
const source = `typedef struct Sample { int left; int right; } Sample;
volatile int global_result;

static void output(const char *text) {
  volatile unsigned short *screen = (volatile unsigned short *)0xb8000;
  while (*text) {
    unsigned char value = (unsigned char)*text++;
    *screen++ = 0x0a00 | value;
    __asm__ volatile ("outb %0, %1" : : "a" (value), "Nd" ((unsigned short)0x3f8));
  }
}

__attribute__((noinline)) int adjust(int seed) {
  int adjustment = seed + 2;
  return adjustment; /* ADJUST_READY */
}

__attribute__((noinline)) int compute(Sample *sample, int *values, int count) {
  Sample snapshot = *sample;
  int delta = adjust(values[0] + values[1]); /* CALL_ADJUST */
  int total = snapshot.left + snapshot.right; /* IN_NESTED */
  if (count == 3) total += delta; /* NESTED_SUM */
  return total; /* NESTED_READY */
}

void kernel_main(void) {
  Sample sample = { 17, 20 };
  int values[3] = { 1, 2, 3 };
  int *cursor = values;
  int result = 0;
  output("C SOURCE DEBUG - PROTECTED32 + PAGING");
  __asm__ volatile ("nop"); /* KERNEL_READY */
  result = compute(&sample, cursor, 3); /* CALL_NESTED */
  global_result = result; /* AFTER_NESTED */
  global_result = result; /* SAME_VALUE */
  int observed = global_result; /* READ_RESULT */
  global_result = observed; /* ACCESS_STORE */
  output("CDEBUG:42 - C SOURCE + PAGING"); /* C_OUTPUT */
  for (;;) __asm__ volatile ("nop"); /* C_DONE */
}
`;

const builder = `const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: __dirname });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited ' + result.status);
}
(async () => {
  await fs.mkdir(path.join(__dirname, 'build'), { recursive: true });
  run(process.env.CC || 'gcc', ['-m32', '-march=i386', '-ffreestanding', '-fno-pie', '-fno-pic', '-fno-stack-protector', '-fno-asynchronous-unwind-tables', '-fno-unwind-tables', '-O0', '-g3', '-gdwarf-4', '-fno-omit-frame-pointer', '-c', 'kernel.c', '-o', 'build/kernel.o']);
  run(process.env.LD || 'ld', ['-m', 'elf_i386', '-T', 'kernel.ld', 'build/kernel.o', '-o', 'build/kernel.elf']);
  run(process.env.OBJCOPY || 'objcopy', ['-O', 'binary', 'build/kernel.elf', 'build/kernel.bin']);
  run(process.env.NASM_PATH || 'nasm', ['-f', 'bin', 'loader.asm', '-o', 'build/loader.bin']);
  const loader = await fs.readFile(path.join(__dirname, 'build/loader.bin'));
  const sectors = Math.ceil(loader.length / 512);
  if (!sectors || sectors > 17) throw new Error('Test loader exceeds first-track budget');
  run(process.env.NASM_PATH || 'nasm', ['-f', 'bin', '-DLOADER_SECTORS=' + sectors, 'boot.asm', '-o', 'build/boot.bin']);
  const image = Buffer.alloc(1474560);
  (await fs.readFile(path.join(__dirname, 'build/boot.bin'))).copy(image);
  loader.copy(image, 512);
  await fs.writeFile(path.join(__dirname, 'build/os.img'), image);
  console.log('C source test fixture built; kernel ELF32, high virtual code and stack');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

const linker = `OUTPUT_FORMAT(elf32-i386)
OUTPUT_ARCH(i386)
ENTRY(kernel_main)
SECTIONS {
  . = 0xc0000000;
  .text : AT(0x200000) { *(.text*) }
  .rodata : { *(.rodata*) }
  .data : { *(.data*) }
  .bss : { *(.bss*) *(COMMON) }
  /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) }
}
`;

const boot = `bits 16
org 0x7c00
cli
xor ax, ax
mov ds, ax
mov es, ax
mov ss, ax
mov sp, 0x7c00
mov [drive], dl
mov ax, 3
int 0x10
mov bx, 0x8000
mov ah, 2
mov al, LOADER_SECTORS
mov ch, 0
mov cl, 2
mov dh, 0
mov dl, [drive]
int 0x13
jc failed
jmp 0:0x8000
failed: hlt
jmp failed
drive: db 0
times 510-($-$$) db 0
dw 0xaa55
`;

const loader = `bits 16
org 0x8000
cli
xor ax, ax
mov ds, ax
in al, 0x92
or al, 2
out 0x92, al
mov dx, 0x3f9
xor al, al
out dx, al
mov dx, 0x3fb
mov al, 0x80
out dx, al
mov dx, 0x3f8
mov al, 1
out dx, al
mov dx, 0x3f9
xor al, al
out dx, al
mov dx, 0x3fb
mov al, 3
out dx, al
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
mov ecx, 1024
identity_loop:
stosd
add eax, 0x1000
loop identity_loop
mov dword [0x100000], 0x101003
mov dword [0x100000+768*4], 0x102003
mov edi, 0x102000
mov eax, 0x200003
mov ecx, 32
high_loop:
stosd
add eax, 0x1000
loop high_loop
mov dword [0x102000+512*4], 0x230003
mov dword [0x102000+513*4], 0x231003
mov edi, 0x200000
xor eax, eax
mov ecx, 0x20000/4
rep stosd
mov esi, payload
mov edi, 0x200000
mov ecx, payload_end-payload
rep movsb
mov eax, 0x100000
mov cr3, eax
mov eax, cr0
or eax, 0x80010000
mov cr0, eax
mov esp, 0xc0201000
xor ebp, ebp
mov eax, KERNEL_ENTRY
call eax
halt: hlt
jmp halt
payload:
incbin "build/kernel.bin"
payload_end:
`;

async function fixture(root, options = {}) {
  await fs.mkdir(root, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, 'kernel.c'), source),
    fs.writeFile(path.join(root, 'kernel.ld'), linker),
    fs.writeFile(path.join(root, 'builder.cjs'), builder.replace('-gdwarf-4', '-gdwarf-' + (options.dwarfVersion || 4)).replace("'-O0', '-g3'", options.sourcePrefix ? "'-fdebug-prefix-map=' + __dirname + '=' + " + JSON.stringify(options.sourcePrefix) + ", '-O0', '-g3'" : "'-O0', '-g3'").replace("'-f', 'bin', 'loader.asm'", "'-f', 'bin', '-DKERNEL_ENTRY=' + entry(), 'loader.asm'").replace("function run(command, args) {", `function entry() {
  const r = spawnSync(process.env.NM || 'nm', ['-n', 'build/kernel.elf'], { cwd: __dirname, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('nm failed');
  const match = /^([0-9a-f]+) T kernel_main$/m.exec(r.stdout);
  if (!match) throw new Error('kernel_main missing');
  return '0x' + match[1];
}
function run(command, args) {`)),
    fs.writeFile(path.join(root, 'boot.asm'), boot),
    fs.writeFile(path.join(root, 'loader.asm'), loader)
  ]);
  const configuration = {
    image: 'build/os.img',
    build: { command: process.execPath, args: ['builder.cjs'] },
    debug: { elf: 'build/kernel.elf', gdbPath: process.env.GDB_PATH || 'gdb', entry: 'kernel_main', ...(options.sourcePrefix ? { sourceMap: { [options.sourcePrefix]: root } } : {}) }
  };
  const configPath = path.join(root, 'qemu-asm.json');
  await fs.writeFile(configPath, JSON.stringify(configuration, null, 2) + '\n');
  await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(root, '.vscode', 'launch.json'), JSON.stringify({ version: '0.2.0', configurations: [{ name: 'Actual C source kernel', type: 'qemu-asm', request: 'launch', stopOnEntry: true }] }, null, 2));
  return {
    root, source: path.join(root, 'kernel.c'), text: source, configPath, configuration,
    image: path.join(root, 'build/os.img'), elf: path.join(root, 'build/kernel.elf'),
    line(marker) {
      const index = source.split('\n').findIndex(line => line.includes(marker));
      if (index < 0) throw new Error('Missing C fixture marker ' + marker);
      return index + 1;
    },
    async build() {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['builder.cjs'], { cwd: root, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('C fixture builder exited ' + code)));
      });
    }
  };
}

module.exports = { fixture, source, CODE_VIRTUAL, CODE_PHYSICAL, STACK_VIRTUAL, PD, HIGH_PT };
