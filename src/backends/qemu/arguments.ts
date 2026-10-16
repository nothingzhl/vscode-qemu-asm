import type { Project } from '../../project/model';
import { localHost, type HostPlatform } from '../../platform/host';

type MachineValueSource = 'profile' | 'qemuArgs' | 'qemu-default';

/** Diagnostics retain QEMU's resource syntax; unspecified defaults remain unknown. */
export interface QemuLaunchConfiguration {
  profile?: { name: string; source: 'launch' | 'selected' | 'default' };
  memory: { value: string | null; source: MachineValueSource };
  cpu: { value: string | null; source: MachineValueSource };
  display: { value: 'auto' | 'off'; source: 'profile' | 'workspace' | 'default' };
  arguments: string[];
}

/** Profile fields replace every matching legacy option; untouched pairs retain their order. */
export function qemuMachineArguments(project: Project): string[] {
  const profile = project.machineProfile?.settings;
  const overrides = new Map<string, string>();
  if (profile?.memoryMiB !== undefined) overrides.set('-m', `${profile.memoryMiB}M`);
  if (profile?.cpuModel !== undefined) overrides.set('-cpu', profile.cpuModel);
  const args: string[] = [];
  for (let index = 0; index < project.qemuArgs.length; index += 2) {
    const option = project.qemuArgs[index];
    if (!overrides.has(option)) args.push(option, project.qemuArgs[index + 1]);
  }
  for (const [option, value] of overrides) args.push(option, value);
  return args;
}

export function qemuLaunchConfiguration(project: Project): QemuLaunchConfiguration {
  const args = qemuMachineArguments(project);
  const profile = project.machineProfile;
  const resource = (option: string, overridden: boolean) => {
    let value: string | null = null;
    for (let index = 0; index < args.length; index += 2) {
      if (args[index] === option) value = args[index + 1];
    }
    const source: MachineValueSource = overridden ? 'profile' : value === null ? 'qemu-default' : 'qemuArgs';
    return { value, source };
  };
  const display = profile?.settings.display;
  return {
    ...(profile ? { profile: { name: profile.name, source: profile.source } } : {}),
    memory: resource('-m', profile?.settings.memoryMiB !== undefined),
    cpu: resource('-cpu', profile?.settings.cpuModel !== undefined),
    display: {
      value: display === undefined ? (project.displayMode ?? 'auto') : display ? 'auto' : 'off',
      source:
        display !== undefined
          ? 'profile'
          : (project.displayModeSource ?? (project.displayMode === undefined ? 'default' : 'workspace'))
    },
    arguments: args
  };
}

export function formatQemuLaunchConfiguration(configuration: QemuLaunchConfiguration): string {
  const sources = {
    launch: 'launch.json 指定',
    selected: '项目手选',
    default: '项目默认',
    profile: '启动方案',
    qemuArgs: '工作区 qemuArgs',
    'qemu-default': 'QEMU 默认（未查询）',
    workspace: '工作区设置'
  };
  const profile = configuration.profile;
  const describe = (setting: QemuLaunchConfiguration['memory']) =>
    `${setting.value ?? '未显式指定'}（来源：${sources[setting.source]}）`;
  return [
    `启动方案：${profile ? `${profile.name}（来源：${sources[profile.source]}）` : '旧配置 / 无方案'}`,
    `内存：${describe(configuration.memory)}`,
    `CPU：${describe(configuration.cpu)}`,
    `显示器：${configuration.display.value}（来源：${configuration.display.source === 'default' ? '插件默认' : sources[configuration.display.source]}）`,
    `有效机器参数：${JSON.stringify(configuration.arguments)}`
  ].join('\n');
}

/** Generated paths are relative to project.root; launch QEMU with that working directory. */
export function qemuArguments(
  project: Project,
  host: { identity: Pick<HostPlatform['identity'], 'platform'>; paths: HostPlatform['paths'] } = localHost
): string[] {
  let image = project.image;
  if (host.identity.platform === 'win32') {
    // Some Windows builds cannot decode Unicode argv, but inherit a Unicode cwd.
    const absolute = host.paths.resolve(project.root, image);
    const relative = host.paths.relative(project.root, absolute);
    image = host.paths.isAbsolute(relative) ? absolute : `.${host.paths.sep}${relative}`;
  }
  // QEMU keyval syntax uses doubled commas for literal filename commas.
  return [
    '-accel',
    'tcg',
    '-display',
    'none',
    '-monitor',
    'none',
    '-serial',
    'stdio',
    '-nic',
    'none',
    '-no-reboot',
    '-boot',
    'a',
    '-drive',
    `file=${image.replace(/,/g, ',,')},format=raw,if=floppy,readonly=on`,
    ...qemuMachineArguments(project)
  ];
}
