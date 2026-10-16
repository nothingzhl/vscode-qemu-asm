import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execute, type Processes } from '../platform/processes';
import type { BuildResult, Project } from './model';
import { validateIso } from './iso';

/** Validate project-owned outputs without deleting or rewriting any artifact. */
export async function validateArtifact(project: Project): Promise<number> {
  const [root, parent] = await Promise.all([
    fs.realpath(project.root), fs.realpath(path.dirname(project.image))
  ]);
  const relative = path.relative(root, parent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('镜像目录不能通过符号链接指向项目外');
  const info = await fs.lstat(project.image, { bigint: true });
  if (!info.isFile()) throw new Error('引导产物必须是普通镜像文件，不能为目录或符号链接');
  for (const file of [project.source, path.join(project.root, 'qemu-asm.json'), project.debug?.elf]) {
    if (!file) continue;
    let input;
    try { input = await fs.stat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (input && info.dev === input.dev && info.ino === input.ino)
      throw new Error('镜像与源码、ELF 或项目配置指向同一文件');
  }
  const size = Number(info.size);
  const handle = await fs.open(project.image, 'r');
  try {
    if (project.boot?.type === 'iso') await validateIso(handle, size);
    else {
      if (size < 512 || size > 1474560 || size % 512 !== 0)
        throw new Error('软盘引导镜像必须为 512..1474560 字节并按 512 字节扇区对齐');
      const signature = Buffer.alloc(2);
      const { bytesRead } = await handle.read(signature, 0, 2, 510);
      if (bytesRead !== 2 || signature[0] !== 0x55 || signature[1] !== 0xaa)
        throw new Error('软盘引导镜像首扇区必须以 55 aa 结尾');
    }
  } finally { await handle.close(); }
  return size;
}

/** A failed/cancelled build rejects this launch; existing files remain owned by the project. */
export async function prepareArtifact(
  project: Project, processes: Processes, log: (text: string) => void, cancelled: () => boolean
): Promise<BuildResult> {
  const check = () => { if (cancelled()) throw new Error('构建已停止'); };
  check();
  if (project.build) {
    const [root, cwd] = await Promise.all([fs.realpath(project.root), fs.realpath(project.build.cwd)]);
    const relative = path.relative(root, cwd);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('build.cwd 不能通过符号链接指向项目外');
    check();
    log(`执行外部构建：${project.build.command}\n`);
    await execute(processes, project.build.command, project.build.args, cwd, log, project.build.timeout, cancelled);
  } else log('使用已有引导产物；不执行构建。\n');
  check();
  const imageBytes = await validateArtifact(project);
  check();
  return { units: [], imageBytes };
}
