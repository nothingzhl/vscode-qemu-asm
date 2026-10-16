export interface MachineProfile {
  memoryMiB?: number;
  cpuModel?: string;
  display?: boolean;
}

export interface SelectedMachineProfile {
  name: string;
  source: 'launch' | 'selected' | 'default';
  settings: MachineProfile;
}

export interface MachineProfileSelection {
  name: unknown;
  source: 'launch' | 'selected';
}

interface ResolvedProfiles {
  machineProfiles?: Record<string, MachineProfile>;
  defaultMachineProfile?: string;
  machineProfile?: SelectedMachineProfile;
  displayMode?: 'auto' | 'off';
  displayModeSource?: 'workspace' | 'default';
}

function profileName(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    [...value].length > 64 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new Error(`${field} 必须为 1..64 字符的方案名，不能包含首尾空白或控制字符`);
  return value;
}

function profile(value: unknown, name: string): MachineProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`machineProfiles.${name} 必须为配置对象`);
  const fields = value as Record<string, unknown>;
  for (const field of Object.keys(fields)) {
    if (!['memoryMiB', 'cpuModel', 'display'].includes(field))
      throw new Error(`machineProfiles.${name} 包含未知字段 ${field}`);
  }
  const result: MachineProfile = {};
  if (Object.hasOwn(fields, 'memoryMiB')) {
    if (
      !Number.isInteger(fields.memoryMiB) ||
      Number(fields.memoryMiB) < 1 ||
      Number(fields.memoryMiB) > 4096
    )
      throw new Error(`machineProfiles.${name}.memoryMiB 必须为 1..4096 MiB 的整数`);
    result.memoryMiB = Number(fields.memoryMiB);
  }
  if (Object.hasOwn(fields, 'cpuModel')) {
    if (typeof fields.cpuModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(fields.cpuModel))
      throw new Error(`machineProfiles.${name}.cpuModel 必须为不含空白、逗号或选项的单个 CPU 型号标识`);
    result.cpuModel = fields.cpuModel;
  }
  if (Object.hasOwn(fields, 'display')) {
    if (typeof fields.display !== 'boolean') throw new Error(`machineProfiles.${name}.display 必须为布尔值`);
    result.display = fields.display;
  }
  return result;
}

export function resolveMachineProfiles(
  config: Record<string, unknown>,
  displayMode: unknown,
  selection?: MachineProfileSelection
): ResolvedProfiles {
  if (displayMode !== undefined && displayMode !== 'auto' && displayMode !== 'off')
    throw new Error('displayMode 必须为 auto 或 off');
  const result: ResolvedProfiles =
    displayMode === undefined ? {} : { displayMode, displayModeSource: 'workspace' };
  if (config.machineProfiles !== undefined) {
    const profiles = config.machineProfiles;
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles))
      throw new Error('machineProfiles 必须为以方案名为键的配置对象');
    const parsed: Record<string, MachineProfile> = Object.create(null);
    for (const [name, settings] of Object.entries(profiles)) {
      profileName(name, 'machineProfiles 的键');
      parsed[name] = profile(settings, name);
    }
    result.machineProfiles = parsed;
  }
  const find = (name: string): MachineProfile => {
    if (!result.machineProfiles || !Object.hasOwn(result.machineProfiles, name))
      throw new Error(`启动方案不存在：${name}`);
    return result.machineProfiles[name];
  };
  if (config.defaultMachineProfile !== undefined) {
    result.defaultMachineProfile = profileName(config.defaultMachineProfile, 'defaultMachineProfile');
    find(result.defaultMachineProfile);
  }
  if (selection) {
    if (selection.source !== 'launch' && selection.source !== 'selected')
      throw new Error('启动方案选择来源必须为 launch 或 selected');
    const name = profileName(selection.name, 'machineProfile');
    result.machineProfile = { name, source: selection.source, settings: { ...find(name) } };
  } else if (result.defaultMachineProfile !== undefined) {
    const name = result.defaultMachineProfile;
    result.machineProfile = { name, source: 'default', settings: { ...find(name) } };
  }
  const display = result.machineProfile?.settings.display;
  if (display !== undefined) result.displayMode = display ? 'auto' : 'off';
  return result;
}
