import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Processes, execute } from '../platform/processes';
import { BuildResult, BuildUnit, Project } from './model';
import { prepareArtifact } from './artifact';

export async function build(
  project: Project,
  processes: Processes,
  log: (text: string) => void,
  cancelled: () => boolean = () => false,
  listingPath?: string
): Promise<BuildResult> {
  const check = () => {
    if (cancelled()) throw new Error('构建已停止');
  };
  check();
  if (project.buildMode !== 'existing') await fs.mkdir(path.dirname(project.image), { recursive: true });
  const [actualRoot, actualParent] = await Promise.all([
    fs.realpath(project.root),
    fs.realpath(path.dirname(project.image))
  ]);
  const relativeParent = path.relative(actualRoot, actualParent);
  if (
    relativeParent === '..' ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  )
    throw new Error('镜像目录不能通过符号链接指向项目外');
  check();
  // File identity also protects case-insensitive volumes, hardlinks and symlinked parent directories.
  const statIfExists = async (file: string) => {
    try {
      return await fs.stat(file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const sources = [project.source, ...project.stages.map((stage) => stage.source)];
  const protectedPaths = [
    ...sources,
    path.join(project.root, 'qemu-asm.json'),
    ...(project.debug ? [project.debug.elf] : [])
  ];
  const protectedInfos = await Promise.all(protectedPaths.map(statIfExists));
  const outputs = [
    project.image,
    ...(listingPath
      ? [listingPath, ...project.stages.map((_, index) => `${listingPath}.stage${index + 1}.lst`)]
      : [])
  ];
  const outputInfos = await Promise.all(outputs.map(statIfExists));
  const sameFile = (
    a: Awaited<ReturnType<typeof statIfExists>>,
    b: Awaited<ReturnType<typeof statIfExists>>
  ) => a && b && a.dev === b.dev && a.ino === b.ino;
  for (let index = 0; index < outputs.length; index++) {
    if (
      protectedPaths.some(
        (file, i) =>
          path.resolve(outputs[index]) === path.resolve(file) ||
          sameFile(outputInfos[index], protectedInfos[i])
      )
    )
      throw new Error('输出与源码、ELF 或项目配置指向同一文件，已取消构建');
    if (
      outputs
        .slice(0, index)
        .some(
          (file, i) =>
            path.resolve(file) === path.resolve(outputs[index]) ||
            sameFile(outputInfos[index], outputInfos[i])
        )
    )
      throw new Error('镜像与 listing 输出不能指向同一文件');
  }
  check();
  if (project.build || project.buildMode === 'existing')
    return prepareArtifact(project, processes, log, cancelled);
  // Only the built-in NASM builder owns and replaces its output.
  await fs.rm(project.image, { force: true });
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
      await execute(
        processes,
        project.nasm,
        ['-f', 'bin', stage.source, '-o', stageOutput, ...(stageListing ? ['-l', stageListing] : [])],
        project.root,
        log
      );
      const bytes = await fs.readFile(stageOutput);
      const sectors = Math.ceil(bytes.length / 512);
      if (!sectors || stage.lba + sectors > 18)
        throw new Error('stage 必须非空，且补齐扇区后全部位于 LBA 1..17（最多 8704 字节）');
      if (stage.loadAddress + sectors * 512 > 0xa0000)
        throw new Error('stage 装载范围不能超出 0x9ffff 常规内存');
      for (const previous of stageUnits) {
        const previousBytes = Math.ceil(previous.size / 512) * 512;
        if (
          stage.lba * 512 < previous.lba * 512 + previousBytes &&
          previous.lba * 512 < stage.lba * 512 + sectors * 512
        )
          throw new Error('stage 在镜像中的扇区范围不能重叠');
        if (
          stage.loadAddress < previous.loadAddress + previousBytes &&
          previous.loadAddress < stage.loadAddress + sectors * 512
        )
          throw new Error('stage 装载后的内存范围不能重叠');
      }
      stageBuffers.push(bytes);
      stageUnits.push({
        ...stage,
        size: bytes.length,
        ...(stageListing ? { listingPath: stageListing } : {})
      });
    }
    check();
    await execute(
      processes,
      project.nasm,
      [
        '-f',
        'bin',
        project.source,
        '-o',
        output,
        ...(listingPath ? ['-l', listingPath] : []),
        ...(stageUnits.length ? ['-D', `STAGE2_SECTORS=${Math.ceil(stageUnits[0].size / 512)}`] : [])
      ],
      project.root,
      log
    );
    const bytes = await fs.readFile(output);
    if (bytes.length !== 512 || bytes[510] !== 0x55 || bytes[511] !== 0xaa)
      throw new Error('引导镜像必须为 512 字节并以 55 aa 结尾');
    const imageBytes = stageUnits.length ? 1474560 : 512;
    if (stageUnits.length) {
      const image = Buffer.alloc(imageBytes);
      bytes.copy(image);
      stageBuffers.forEach((stage, index) => stage.copy(image, stageUnits[index].lba * 512));
      await fs.writeFile(output, image);
    }
    check();
    await fs.rename(output, project.image);
    return {
      units: [
        {
          source: project.source,
          loadAddress: 0x7c00,
          lba: 0,
          size: bytes.length,
          ...(listingPath ? { listingPath } : {})
        },
        ...stageUnits
      ],
      imageBytes
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
