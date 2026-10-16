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
export interface BootConfiguration {
  type: 'floppy' | 'iso';
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
  boot?: BootConfiguration;
  /** Explicit reuse of an artifact; absence preserves the legacy NASM build. */
  buildMode?: 'existing';
  build?: ExternalBuild;
  debug?: ElfDebugConfiguration;
}
