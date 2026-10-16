import type { MachineProfile, SelectedMachineProfile } from './machineProfiles';
export type { MachineProfile, MachineProfileSelection, SelectedMachineProfile } from './machineProfiles';

export interface Stage {
  source: string;
  loadAddress: number;
  lba: number;
}
export interface BuildUnit extends Stage {
  size: number;
  listingPath?: string;
}
export interface BuildResult {
  units: BuildUnit[];
  imageBytes: number;
}
export interface ExternalBuild {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
}
export interface ElfDebugConfiguration {
  elf: string;
  gdb: string;
  sourceMap?: Record<string, string>;
  entry?: string;
}
export interface Project {
  workspace: string;
  root: string;
  source: string;
  image: string;
  stages: Stage[];
  nasm: string;
  qemu: string;
  qemuArgs: string[];
  machineProfiles?: Record<string, MachineProfile>;
  defaultMachineProfile?: string;
  machineProfile?: SelectedMachineProfile;
  displayMode?: 'auto' | 'off';
  displayModeSource?: 'workspace' | 'default';
  build?: ExternalBuild;
  debug?: ElfDebugConfiguration;
}
