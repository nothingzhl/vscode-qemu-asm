import * as path from 'node:path';
import { ElfDebugConfiguration, ExternalBuild, Project, Stage } from './model';

function string(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error('配置必须是非空路径字符串');
  return value;
}
export function resolveProject(
  workspace: string,
  projectDir: unknown,
  data: unknown,
  tools: { nasm?: unknown; qemu?: unknown; qemuArgs?: unknown; gdb?: unknown } = {}
): Project {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('项目配置必须是 JSON 对象');
  const config = data as Record<string, unknown>;
  const configuredPath = (value: unknown, fallback: string) => {
    const name = string(value, fallback);
    if (/^[a-z]:[^\\/]/i.test(name) || /^[a-z]:$/i.test(name))
      throw new Error('不支持盘符相对路径，请使用完整绝对路径');
    return name;
  };
  const root = path.resolve(workspace, configuredPath(projectDir, '.'));
  const tool = (value: unknown, fallback: string) => {
    const name = configuredPath(value, fallback);
    return name.includes('/') || name.includes('\\') ? path.resolve(workspace, name) : name;
  };
  const args = tools.qemuArgs ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0')))
    throw new Error('qemuArgs 必须为字符串数组');
  // Only machine resource options are supported; disk, daemon and chardev options would bypass lifecycle ownership.
  const allowed = new Set(['-m', '-cpu', '-smp']);
  if (
    args.length % 2 ||
    args.some((a, i) => (i % 2 === 0 ? !allowed.has(a) : a.startsWith('-') || !a.trim()))
  )
    throw new Error('qemuArgs 仅支持 -m、-cpu、-smp 的选项/值对');
  const source = path.resolve(root, configuredPath(config.source, 'boot.asm'));
  const image = path.resolve(root, configuredPath(config.image, 'build/boot.img'));
  const withinRoot = (file: string) => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  let externalBuild: ExternalBuild | undefined;
  if (config.build !== undefined) {
    if (!config.build || typeof config.build !== 'object' || Array.isArray(config.build))
      throw new Error('build 必须包含 command 与可选的 args、cwd、timeout');
    const value = config.build as Record<string, unknown>;
    if (typeof value.command !== 'string') throw new Error('build.command 必须为可执行文件路径');
    const command = configuredPath(value.command, '');
    const buildArgs = value.args === undefined ? [] : value.args;
    if (
      !Array.isArray(buildArgs) ||
      buildArgs.length > 256 ||
      buildArgs.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    )
      throw new Error('build.args 必须为最多 256 项的字符串数组');
    const cwd = path.resolve(root, configuredPath(value.cwd, '.'));
    if (!withinRoot(cwd)) throw new Error('build.cwd 必须位于项目内');
    const timeout = value.timeout === undefined ? 120000 : value.timeout;
    if (!Number.isInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 1800000)
      throw new Error('build.timeout 必须为 100..1800000 毫秒的整数');
    externalBuild = {
      command: command.includes('/') || command.includes('\\') ? path.resolve(root, command) : command,
      args: [...buildArgs],
      cwd,
      timeout: Number(timeout)
    };
  }
  let debug: ElfDebugConfiguration | undefined;
  if (config.debug !== undefined) {
    if (!config.debug || typeof config.debug !== 'object' || Array.isArray(config.debug))
      throw new Error('debug 必须包含 elf 与可选的 gdbPath、sourceMap、entry');
    const value = config.debug as Record<string, unknown>;
    if (typeof value.elf !== 'string') throw new Error('debug.elf 必须为 ELF 文件路径');
    const elf = path.resolve(root, configuredPath(value.elf, ''));
    let sourceMap: Record<string, string> | undefined;
    if (value.sourceMap !== undefined) {
      if (
        !value.sourceMap ||
        typeof value.sourceMap !== 'object' ||
        Array.isArray(value.sourceMap) ||
        Object.keys(value.sourceMap).length > 128
      )
        throw new Error('debug.sourceMap 必须为最多 128 项的路径映射对象');
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
      if (!/^(?:0x[\da-f]{1,8}|[a-z_.$][\w.$:]*)$/i.test(entry))
        throw new Error('debug.entry 必须为函数符号或 32 位十六进制地址');
    }
    const gdbName = configuredPath(value.gdbPath === undefined ? tools.gdb : value.gdbPath, 'gdb');
    const gdb =
      gdbName.includes('/') || gdbName.includes('\\')
        ? path.resolve(value.gdbPath === undefined ? workspace : root, gdbName)
        : gdbName;
    debug = { elf, gdb, ...(sourceMap ? { sourceMap } : {}), ...(entry ? { entry } : {}) };
  }
  if (config.stages !== undefined && (!Array.isArray(config.stages) || config.stages.length > 8))
    throw new Error('stages 必须为最多 8 段的数组');
  const stages: Stage[] = ((config.stages as unknown[] | undefined) ?? []).map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('stage 必须包含 source、loadAddress 与 lba');
    const stage = value as Record<string, unknown>;
    if (typeof stage.source !== 'string') throw new Error('stage 必须指定 source');
    if (
      !Number.isInteger(stage.loadAddress) ||
      Number(stage.loadAddress) < 0x8000 ||
      Number(stage.loadAddress) > 0x9ffff
    )
      throw new Error('stage loadAddress 必须为 0x8000..0x9ffff 的整数');
    if (!Number.isInteger(stage.lba) || Number(stage.lba) < 1 || Number(stage.lba) > 17)
      throw new Error('首版 stage lba 必须为 1..17（引导磁道剩余扇区）');
    return {
      source: path.resolve(root, configuredPath(stage.source, '')),
      loadAddress: Number(stage.loadAddress),
      lba: Number(stage.lba)
    };
  });
  if (externalBuild && stages.length) throw new Error('外部 build 自行生成镜像，不能同时配置 NASM stages');
  const relativeImage = path.relative(root, image);
  if (
    [source, ...stages.map((stage) => stage.source)].includes(image) ||
    relativeImage === '..' ||
    relativeImage.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeImage)
  )
    throw new Error('镜像必须位于项目内且不能覆盖源码');
  if (image === path.join(root, 'qemu-asm.json')) throw new Error('镜像不能覆盖项目配置');
  if (debug?.elf === image) throw new Error('镜像不能覆盖 ELF 调试文件');
  return {
    workspace,
    root,
    source,
    image,
    stages,
    nasm: tool(tools.nasm, 'nasm'),
    qemu: tool(tools.qemu, 'qemu-system-i386'),
    qemuArgs: [...args],
    ...(externalBuild ? { build: externalBuild } : {}),
    ...(debug ? { debug } : {})
  };
}
