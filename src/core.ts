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
cld
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
wait_tx:
mov dx, 0x3fd
in al, dx
test al, 0x20
jz wait_tx
mov dx, 0x3f8
mov al, bl
out dx, al
jmp next
done:
hlt
jmp done
message db '${MARKER}', 13, 10, 0
times 510-($-$$) db 0
dw 0xaa55
`;
export interface Project { workspace: string; root: string; source: string; image: string; nasm: string; qemu: string; qemuArgs: string[] }
function string(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('配置必须是非空路径字符串');
  return value;
}
export function resolveProject(workspace: string, projectDir: unknown, data: unknown, tools: { nasm?: unknown; qemu?: unknown; qemuArgs?: unknown } = {}): Project {
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
  const relativeImage = path.relative(root, image);
  if (source === image || relativeImage === '..' || relativeImage.startsWith(`..${path.sep}`) || path.isAbsolute(relativeImage)) throw new Error('镜像必须位于项目内且不能覆盖源码');
  if (image === path.join(root, 'qemu-asm.json')) throw new Error('镜像不能覆盖项目配置');
  return { workspace, root, source, image, nasm: tool(tools.nasm, 'nasm'), qemu: tool(tools.qemu, 'qemu-system-i386'), qemuArgs: [...args] };
}
export async function createProject(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const created: string[] = [];
  try {
    for (const [name, body] of [['boot.asm', example], ['qemu-asm.json', JSON.stringify({ source: 'boot.asm', image: 'build/boot.img' }, null, 2) + '\n']]) {
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
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
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
  async stop(): Promise<void> {
    await Promise.all([...this.children].map(child => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      this.stopping.add(child);
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    })));
  }
  async dispose(): Promise<void> { this.closed = true; await this.stop(); }
}
export async function execute(processes: Processes, command: string, args: string[], cwd: string, log: (text: string) => void, timeout = 15000): Promise<void> {
  const run = processes.start(command, args, cwd, log);
  let expired = false;
  const timer = setTimeout(() => { expired = true; run.child.kill('SIGKILL'); }, timeout);
  try { await run.ready; await run.done; if (expired) throw new Error(`${command} 执行超时`); }
  catch (error) { if (expired) throw new Error(`${command} 执行超时`); throw error; }
  finally { clearTimeout(timer); }
}
export async function build(project: Project, processes: Processes, log: (text: string) => void, cancelled: () => boolean = () => false): Promise<void> {
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
  const [imageInfo, sourceInfo, configInfo] = await Promise.all([project.image, project.source, path.join(project.root, 'qemu-asm.json')].map(statIfExists));
  if (imageInfo && [sourceInfo, configInfo].some(info => info && imageInfo.dev === info.dev && imageInfo.ino === info.ino)) throw new Error('镜像与源码或项目配置指向同一文件，已取消构建');
  check();
  // Never accept an earlier artifact after a failed build. Use an exclusive temporary directory.
  await fs.rm(project.image, { force: true });
  const temp = await fs.mkdtemp(path.join(path.dirname(project.image), '.qemu-asm-'));
  try {
    const output = path.join(temp, 'boot.img');
    check();
    await execute(processes, project.nasm, ['-f', 'bin', project.source, '-o', output], project.root, log);
    const bytes = await fs.readFile(output);
    if (bytes.length !== 512 || bytes[510] !== 0x55 || bytes[511] !== 0xaa) throw new Error('引导镜像必须为 512 字节并以 55 aa 结尾');
    check();
    await fs.rename(output, project.image);
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
