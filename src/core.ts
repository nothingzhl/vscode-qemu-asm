import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const MARKER = 'QEMU_ASM_BOOT_OK';
export const example = `bits 16
org 0x7c00
cli
xor ax, ax
mov ds, ax
mov ss, ax
mov sp, 0x7c00
xor bp, bp
cld
; VGA 文本模式，右侧模拟显示器显示实际 BIOS 输出
mov ax, 0x0003
int 0x10
; COM1: 115200 baud, 8N1, FIFO enabled
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
mov dx, 0x3fa
mov al, 0xc7
out dx, al
mov dx, 0x3fc
mov al, 0x0b
out dx, al
mov si, message
next:
lodsb
test al, al
jz done
mov bl, al
call write_char
jmp next
; BP 栈帧：暂停在此函数可查看返回地址与栈内存
write_char:
push bp
mov bp, sp
push ax
wait_tx:
mov dx, 0x3fd
in al, dx
test al, 0x20
jz wait_tx
mov dx, 0x3f8
mov al, bl
out dx, al
; 同时通过 BIOS 显示字符，串口日志仍可用于无界面验证
push bx
push si
mov al, bl
mov ah, 0x0e
xor bh, bh
int 0x10
pop si
pop bx
pop ax
pop bp
ret
done:
hlt
jmp done
message db '${MARKER}', 13, 10, 0
times 510-($-$$) db 0
dw 0xaa55
`;
export const PROTECTED_MARKER = 'PROTECTED_MODE_OK';
export const protectedBootExample = `bits 16
org 0x7c00
; BIOS 只装入本扇区；构建器把 stage2 放在 LBA 1，并给出扇区数。
cli
xor ax, ax
mov ds, ax
mov es, ax
mov ss, ax
mov sp, 0x7c00
cld
mov [boot_drive], dl
mov ax, 0x0003
int 0x10
sti
mov bx, 0x8000
mov ah, 0x02
mov al, STAGE2_SECTORS
mov ch, 0
mov cl, 2
mov dh, 0
mov dl, [boot_drive]
int 0x13
jc disk_error
cli
jmp 0x0000:0x8000
disk_error:
cli
hlt
jmp disk_error
boot_drive db 0
times 510-($-$$) db 0
dw 0xaa55
`;
export const protectedStageExample = `bits 16
org 0x8000
cli
xor ax, ax
mov ds, ax
cld
; COM1 初始化后可以在无界面集成验证中观察保护模式成功标记。
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
mov dx, 0x3fa
mov al, 0xc7
out dx, al
mov dx, 0x3fc
mov al, 0x0b
out dx, al
lgdt [gdt_descriptor]
mov eax, cr0
or eax, 1
mov cr0, eax
jmp 0x08:protected_entry

align 8
gdt:
dq 0
; 平坦 32 位代码段与数据段，base=0、limit=4GB。
dq 0x00cf9a000000ffff
dq 0x00cf92000000ffff
gdt_end:
gdt_descriptor:
dw gdt_end-gdt-1
dd gdt

bits 32
protected_entry:
mov ax, 0x10
mov ds, ax
mov es, ax
mov fs, ax
mov gs, ax
mov ss, ax
mov esp, 0x90000
xor ebp, ebp
; 只安装可供查看的最小 IDT：向量 3 指向下方的 IRETD 处理器。
; 本课仍保持 IF=0，不触发中断；不要把它当作完整异常处理表。
lidt [idt_descriptor]
inspection_ready:
mov esi, message
mov edi, 0xb8000
print_next:
lodsb
test al, al
jz print_done
mov ah, 0x0a
mov [edi], ax
add edi, 2
mov bl, al
serial_wait:
mov dx, 0x3fd
in al, dx
test al, 0x20
jz serial_wait
mov dx, 0x3f8
mov al, bl
out dx, al
jmp print_next
print_done:
call learning_entry
after_call:
idle:
hlt
jmp idle

; 在下面两个函数里设置断点，观察 EAX、ESP、EBP 与返回地址。
learning_entry:
push ebp
mov ebp, esp
mov eax, 0x11223344
push eax
call learning_nested
add esp, 4
pop ebp
ret
protected_worker:
learning_nested:
push ebp
mov ebp, esp
mov ebx, [ebp+8]
; EDI 指向下面的数据区；复制寄存器 EDI 的值到内存地址框，观察三个双字。
mov edi, inspection_data
learning_breakpoint:
nop
; 在内存查看器中观察第三个双字：单步执行后由 0 变为 1。
inc dword [inspection_data+8]
inspection_changed:
pop ebp
ret

inspection_handler:
iretd

align 8
idt:
dq 0
dq 0
dq 0
; 32 位中断门：偏移低 16 位、代码选择子、保留字节、P/DPL/type、高 16 位。
; 整个 stage2 位于 0x8000..0x83ff，因此处理器偏移的高 16 位为 0。
dw inspection_handler
dw 0x08
db 0
db 0x8e
dw 0
idt_end:
idt_descriptor:
dw idt_end-idt-1
dd idt
align 4
; 小端布局：44 33 22 11 88 77 66 55 00 00 00 00。
inspection_data:
dd 0x11223344, 0x55667788, 0
; 成功字符串位于第二个扇区，真实引导验证必须读到它。
times 768-($-$$) db 0
message db '${PROTECTED_MARKER}', 13, 10, 0
; 二阶段刻意超过 512B，验证从磁盘读取多个扇区。
times 1024-($-$$) db 0
`;
export interface Stage { source: string; loadAddress: number; lba: number }
export interface BuildUnit extends Stage { size: number; listingPath?: string }
export interface BuildResult { units: BuildUnit[]; imageBytes: number }
export interface ExternalBuild { command: string; args: string[]; cwd: string; timeout: number }
export interface ElfDebugConfiguration { elf: string; gdb: string; sourceMap?: Record<string, string>; entry?: string }
export interface Project { workspace: string; root: string; source: string; image: string; stages: Stage[]; nasm: string; qemu: string; qemuArgs: string[]; build?: ExternalBuild; debug?: ElfDebugConfiguration }
function string(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('配置必须是非空路径字符串');
  return value;
}
export function resolveProject(workspace: string, projectDir: unknown, data: unknown, tools: { nasm?: unknown; qemu?: unknown; qemuArgs?: unknown; gdb?: unknown } = {}): Project {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('项目配置必须是 JSON 对象');
  const config = data as Record<string, unknown>;
  const configuredPath = (value: unknown, fallback: string) => {
    const name = string(value, fallback);
    if (/^[a-z]:[^\\/]/i.test(name) || /^[a-z]:$/i.test(name)) throw new Error('不支持盘符相对路径，请使用完整绝对路径');
    return name;
  };
  const root = path.resolve(workspace, configuredPath(projectDir, '.'));
  const tool = (value: unknown, fallback: string) => {
    const name = configuredPath(value, fallback);
    return name.includes('/') || name.includes('\\') ? path.resolve(workspace, name) : name;
  };
  const args = tools.qemuArgs ?? [];
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('qemuArgs 必须为字符串数组');
  // Only machine resource options are supported; disk, daemon and chardev options would bypass lifecycle ownership.
  const allowed = new Set(['-m', '-cpu', '-smp']);
  if (args.length % 2 || args.some((a, i) => i % 2 === 0 ? !allowed.has(a) : a.startsWith('-') || !a.trim())) throw new Error('qemuArgs 仅支持 -m、-cpu、-smp 的选项/值对');
  const source = path.resolve(root, configuredPath(config.source, 'boot.asm'));
  const image = path.resolve(root, configuredPath(config.image, 'build/boot.img'));
  const withinRoot = (file: string) => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  let externalBuild: ExternalBuild | undefined;
  if (config.build !== undefined) {
    if (!config.build || typeof config.build !== 'object' || Array.isArray(config.build)) throw new Error('build 必须包含 command 与可选的 args、cwd、timeout');
    const value = config.build as Record<string, unknown>;
    if (typeof value.command !== 'string') throw new Error('build.command 必须为可执行文件路径');
    const command = configuredPath(value.command, '');
    const buildArgs = value.args === undefined ? [] : value.args;
    if (!Array.isArray(buildArgs) || buildArgs.length > 256 || buildArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('build.args 必须为最多 256 项的字符串数组');
    const cwd = path.resolve(root, configuredPath(value.cwd, '.'));
    if (!withinRoot(cwd)) throw new Error('build.cwd 必须位于项目内');
    const timeout = value.timeout === undefined ? 120000 : value.timeout;
    if (!Number.isInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 1800000) throw new Error('build.timeout 必须为 100..1800000 毫秒的整数');
    externalBuild = { command: command.includes('/') || command.includes('\\') ? path.resolve(root, command) : command, args: [...buildArgs], cwd, timeout: Number(timeout) };
  }
  let debug: ElfDebugConfiguration | undefined;
  if (config.debug !== undefined) {
    if (!config.debug || typeof config.debug !== 'object' || Array.isArray(config.debug)) throw new Error('debug 必须包含 elf 与可选的 gdbPath、sourceMap、entry');
    const value = config.debug as Record<string, unknown>;
    if (typeof value.elf !== 'string') throw new Error('debug.elf 必须为 ELF 文件路径');
    const elf = path.resolve(root, configuredPath(value.elf, ''));
    let sourceMap: Record<string, string> | undefined;
    if (value.sourceMap !== undefined) {
      if (!value.sourceMap || typeof value.sourceMap !== 'object' || Array.isArray(value.sourceMap) || Object.keys(value.sourceMap).length > 128) throw new Error('debug.sourceMap 必须为最多 128 项的路径映射对象');
      sourceMap = Object.create(null) as Record<string, string>;
      for (const [before, after] of Object.entries(value.sourceMap)) {
        string(before, '');
        if (typeof after !== 'string') throw new Error('debug.sourceMap 的目标必须为非空路径字符串');
        sourceMap[before] = path.resolve(root, configuredPath(after, ''));
      }
    }
    let entry: string | undefined;
    if (value.entry !== undefined) {
      entry = string(value.entry, '');
      if (!/^(?:0x[\da-f]{1,8}|[a-z_.$][\w.$:]*)$/i.test(entry)) throw new Error('debug.entry 必须为函数符号或 32 位十六进制地址');
    }
    const gdbName = configuredPath(value.gdbPath === undefined ? tools.gdb : value.gdbPath, 'gdb');
    const gdb = gdbName.includes('/') || gdbName.includes('\\') ? path.resolve(value.gdbPath === undefined ? workspace : root, gdbName) : gdbName;
    debug = { elf, gdb, ...(sourceMap ? { sourceMap } : {}), ...(entry ? { entry } : {}) };
  }
  if (config.stages !== undefined && (!Array.isArray(config.stages) || config.stages.length > 8)) throw new Error('stages 必须为最多 8 段的数组');
  const stages: Stage[] = (config.stages as unknown[] | undefined ?? []).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('stage 必须包含 source、loadAddress 与 lba');
    const stage = value as Record<string, unknown>;
    if (typeof stage.source !== 'string') throw new Error('stage 必须指定 source');
    if (!Number.isInteger(stage.loadAddress) || Number(stage.loadAddress) < 0x8000 || Number(stage.loadAddress) > 0x9ffff) throw new Error('stage loadAddress 必须为 0x8000..0x9ffff 的整数');
    if (!Number.isInteger(stage.lba) || Number(stage.lba) < 1 || Number(stage.lba) > 17) throw new Error('首版 stage lba 必须为 1..17（引导磁道剩余扇区）');
    return { source: path.resolve(root, configuredPath(stage.source, '')), loadAddress: Number(stage.loadAddress), lba: Number(stage.lba) };
  });
  if (externalBuild && stages.length) throw new Error('外部 build 自行生成镜像，不能同时配置 NASM stages');
  const relativeImage = path.relative(root, image);
  if ([source, ...stages.map(stage => stage.source)].includes(image) || relativeImage === '..' || relativeImage.startsWith(`..${path.sep}`) || path.isAbsolute(relativeImage)) throw new Error('镜像必须位于项目内且不能覆盖源码');
  if (image === path.join(root, 'qemu-asm.json')) throw new Error('镜像不能覆盖项目配置');
  if (debug?.elf === image) throw new Error('镜像不能覆盖 ELF 调试文件');
  return { workspace, root, source, image, stages, nasm: tool(tools.nasm, 'nasm'), qemu: tool(tools.qemu, 'qemu-system-i386'), qemuArgs: [...args], ...(externalBuild ? { build: externalBuild } : {}), ...(debug ? { debug } : {}) };
}
export async function createProject(root: string, template: 'boot' | 'protected' = 'boot'): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const created: string[] = [];
  const files: [string, string][] = template === 'protected'
    ? [['boot.asm', protectedBootExample], ['stage2.asm', protectedStageExample], ['qemu-asm.json', JSON.stringify({ source: 'boot.asm', image: 'build/boot.img', stages: [{ source: 'stage2.asm', loadAddress: 0x8000, lba: 1 }] }, null, 2) + '\n']]
    : [['boot.asm', example], ['qemu-asm.json', JSON.stringify({ source: 'boot.asm', image: 'build/boot.img' }, null, 2) + '\n']];
  try {
    for (const [name, body] of files) {
      const target = path.join(root, name);
      await fs.writeFile(target, body, { flag: 'wx' });
      created.push(target);
    }
  } catch (error) { await Promise.all(created.map(p => fs.unlink(p))); throw error; }
}
export class Processes {
  private children = new Set<ChildProcess>();
  private stopping = new WeakSet<ChildProcess>();
  private closed = false;
  start(command: string, args: string[], cwd: string, log: (text: string) => void): { child: ChildProcess; ready: Promise<void>; done: Promise<void> } {
    if (this.closed) throw new Error('插件正在退出');
    // External builders such as make create descendants. A dedicated process group keeps
    // stop/timeout restricted to our own launch while also terminating its compilers.
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    // A leader may finish while an unref'ed compiler still runs, including with
    // ignored stdio. Clean its group at exit, before forgetting the live PID.
    child.once('exit', () => this.terminate(child, 'SIGKILL'));
    child.stdout?.setEncoding('utf8').on('data', text => log(text));
    child.stderr?.setEncoding('utf8').on('data', text => log(text));
    const ready = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        this.children.delete(child);
        if (code === 0 || this.stopping.has(child)) resolve();
        else reject(new Error(signal ? `${command} 被信号 ${signal} 终止` : `${command} 退出码 ${code}`));
      });
    });
    void done.catch(() => undefined);
    return { child, ready, done };
  }
  terminate(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.children.has(child) || child.pid === undefined) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill(signal));
      killer.once('exit', code => { if (code !== 0) child.kill(signal); });
      return;
    }
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
  }
  async stop(): Promise<void> {
    await Promise.all([...this.children].map(child => new Promise<void>((resolve) => {
      if (!this.children.has(child)) { resolve(); return; }
      this.stopping.add(child);
      const timer = setTimeout(() => this.terminate(child, 'SIGKILL'), 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      this.terminate(child, 'SIGTERM');
    })));
  }
  async dispose(): Promise<void> { this.closed = true; await this.stop(); }
}
export async function execute(processes: Processes, command: string, args: string[], cwd: string, log: (text: string) => void, timeout = 15000, cancelled: () => boolean = () => false): Promise<void> {
  if (cancelled()) throw new Error('构建已停止');
  const run = processes.start(command, args, cwd, log);
  let expired = false;
  let stopped = false;
  const terminate = () => { if (processes.terminate) processes.terminate(run.child, 'SIGKILL'); else run.child.kill('SIGKILL'); };
  const timer = setTimeout(() => { expired = true; terminate(); }, timeout);
  const cancellation = setInterval(() => { if (cancelled()) { stopped = true; terminate(); } }, 50);
  try { await run.ready; await run.done; if (expired) throw new Error(`${command} 执行超时`); if (stopped || cancelled()) throw new Error('构建已停止'); }
  catch (error) { if (expired) throw new Error(`${command} 执行超时`); if (stopped || cancelled()) throw new Error('构建已停止'); throw error; }
  finally { clearTimeout(timer); clearInterval(cancellation); }
}
export async function build(project: Project, processes: Processes, log: (text: string) => void, cancelled: () => boolean = () => false, listingPath?: string): Promise<BuildResult> {
  const check = () => { if (cancelled()) throw new Error('构建已停止'); };
  check();
  await fs.mkdir(path.dirname(project.image), { recursive: true });
  const [actualRoot, actualParent] = await Promise.all([fs.realpath(project.root), fs.realpath(path.dirname(project.image))]);
  const relativeParent = path.relative(actualRoot, actualParent);
  if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) throw new Error('镜像目录不能通过符号链接指向项目外');
  check();
  // File identity also protects case-insensitive volumes, hardlinks and symlinked parent directories.
  const statIfExists = async (file: string) => {
    try { return await fs.stat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const sources = [project.source, ...project.stages.map(stage => stage.source)];
  const protectedPaths = [...sources, path.join(project.root, 'qemu-asm.json'), ...(project.debug ? [project.debug.elf] : [])];
  const protectedInfos = await Promise.all(protectedPaths.map(statIfExists));
  const outputs = [project.image, ...(listingPath ? [listingPath, ...project.stages.map((_, index) => `${listingPath}.stage${index + 1}.lst`)] : [])];
  const outputInfos = await Promise.all(outputs.map(statIfExists));
  const sameFile = (a: Awaited<ReturnType<typeof statIfExists>>, b: Awaited<ReturnType<typeof statIfExists>>) => a && b && a.dev === b.dev && a.ino === b.ino;
  for (let index = 0; index < outputs.length; index++) {
    if (protectedPaths.some((file, i) => path.resolve(outputs[index]) === path.resolve(file) || sameFile(outputInfos[index], protectedInfos[i]))) throw new Error('输出与源码、ELF 或项目配置指向同一文件，已取消构建');
    if (outputs.slice(0, index).some((file, i) => path.resolve(file) === path.resolve(outputs[index]) || sameFile(outputInfos[index], outputInfos[i]))) throw new Error('镜像与 listing 输出不能指向同一文件');
  }
  check();
  // Never accept an earlier artifact after a failed build. Use an exclusive temporary directory.
  await fs.rm(project.image, { force: true });
  if (project.build) {
    const assertExternalImageSafe = async () => {
      const parent = await fs.realpath(path.dirname(project.image));
      const relative = path.relative(actualRoot, parent);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('镜像目录不能通过符号链接指向项目外');
      const info = await statIfExists(project.image);
      const protectedNow = await Promise.all(protectedPaths.map(statIfExists));
      if (protectedNow.some(item => sameFile(info, item))) throw new Error('镜像与源码、ELF 或项目配置指向同一文件');
    };
    try {
      const cwd = await fs.realpath(project.build.cwd);
      const relative = path.relative(actualRoot, cwd);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('build.cwd 不能通过符号链接指向项目外');
      check();
      log(`执行外部构建：${project.build.command}\n`);
      await execute(processes, project.build.command, project.build.args, cwd, log, project.build.timeout, cancelled);
      check();
      await assertExternalImageSafe();
      const info = await fs.lstat(project.image);
      if (!info.isFile()) throw new Error('外部构建必须生成普通镜像文件，不能为目录或符号链接');
      if (info.size < 512 || info.size > 1474560 || info.size % 512 !== 0) throw new Error('外部引导镜像必须为 512..1474560 字节并按 512 字节扇区对齐');
      const image = await fs.open(project.image, 'r');
      try {
        const signature = Buffer.alloc(2);
        const { bytesRead } = await image.read(signature, 0, 2, 510);
        if (bytesRead !== 2 || signature[0] !== 0x55 || signature[1] !== 0xaa) throw new Error('外部引导镜像首扇区必须以 55 aa 结尾');
      } finally { await image.close(); }
      check();
      return { units: [], imageBytes: info.size };
    } catch (error) {
      // A builder owns its ELF and other outputs. Only invalidate this image, and
      // recheck aliases because a failed command may have changed its directory.
      try { await assertExternalImageSafe(); await fs.rm(project.image, { force: true }); } catch { /* Preserve protected or redirected files. */ }
      throw error;
    }
  }
  const temp = await fs.mkdtemp(path.join(path.dirname(project.image), '.qemu-asm-'));
  try {
    const output = path.join(temp, 'boot.img');
    const stageBuffers: Buffer[] = [];
    const stageUnits: BuildUnit[] = [];
    for (let index = 0; index < project.stages.length; index++) {
      check();
      const stage = project.stages[index];
      const stageOutput = path.join(temp, `stage${index + 1}.bin`);
      const stageListing = listingPath ? `${listingPath}.stage${index + 1}.lst` : undefined;
      await execute(processes, project.nasm, ['-f', 'bin', stage.source, '-o', stageOutput, ...(stageListing ? ['-l', stageListing] : [])], project.root, log);
      const bytes = await fs.readFile(stageOutput);
      const sectors = Math.ceil(bytes.length / 512);
      if (!sectors || stage.lba + sectors > 18) throw new Error('stage 必须非空，且补齐扇区后全部位于 LBA 1..17（最多 8704 字节）');
      if (stage.loadAddress + sectors * 512 > 0xa0000) throw new Error('stage 装载范围不能超出 0x9ffff 常规内存');
      for (const previous of stageUnits) {
        const previousBytes = Math.ceil(previous.size / 512) * 512;
        if (stage.lba * 512 < previous.lba * 512 + previousBytes && previous.lba * 512 < stage.lba * 512 + sectors * 512) throw new Error('stage 在镜像中的扇区范围不能重叠');
        if (stage.loadAddress < previous.loadAddress + previousBytes && previous.loadAddress < stage.loadAddress + sectors * 512) throw new Error('stage 装载后的内存范围不能重叠');
      }
      stageBuffers.push(bytes);
      stageUnits.push({ ...stage, size: bytes.length, ...(stageListing ? { listingPath: stageListing } : {}) });
    }
    check();
    await execute(processes, project.nasm, ['-f', 'bin', project.source, '-o', output, ...(listingPath ? ['-l', listingPath] : []), ...(stageUnits.length ? ['-D', `STAGE2_SECTORS=${Math.ceil(stageUnits[0].size / 512)}`] : [])], project.root, log);
    const bytes = await fs.readFile(output);
    if (bytes.length !== 512 || bytes[510] !== 0x55 || bytes[511] !== 0xaa) throw new Error('引导镜像必须为 512 字节并以 55 aa 结尾');
    const imageBytes = stageUnits.length ? 1474560 : 512;
    if (stageUnits.length) {
      const image = Buffer.alloc(imageBytes);
      bytes.copy(image);
      stageBuffers.forEach((stage, index) => stage.copy(image, stageUnits[index].lba * 512));
      await fs.writeFile(output, image);
    }
    check();
    await fs.rename(output, project.image);
    return { units: [{ source: project.source, loadAddress: 0x7c00, lba: 0, size: bytes.length, ...(listingPath ? { listingPath } : {}) }, ...stageUnits], imageBytes };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
export function qemuArguments(project: Project): string[] {
  // QEMU keyval syntax uses doubled commas for literal filename commas.
  return ['-accel', 'tcg', '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-nic', 'none', '-no-reboot', '-boot', 'a', '-drive', `file=${project.image.replace(/,/g, ',,')},format=raw,if=floppy,readonly=on`, ...project.qemuArgs];
}
export function parseErrors(text: string, root: string): { file: string; line: number; message: string }[] {
  return text.split(/\r?\n/).flatMap(line => {
    const match = /^(.*?):(\d+):\s*(.*)$/.exec(line);
    return match ? [{ file: path.resolve(root, match[1]), line: Math.max(0, Number(match[2]) - 1), message: match[3] }] : [];
  });
}
