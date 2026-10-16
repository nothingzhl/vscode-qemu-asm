import type { GdbConnection } from '../backends/gdb/connection';
import type { AssemblyBackend } from '../ports/machine';
import type { DebugDisplay } from '../ports/presentation';
import type { SourceBackend } from '../ports/source';
import type { build } from '../project/build';
import type { Project } from '../project/model';

/** QEMU attachment is confined to composition; session contracts do not expose raw arguments. */
export interface QemuDisplay extends DebugDisplay {
  readonly args: string[];
}
export interface AdapterOptions {
  getProject: () => Promise<Project>;
  isTrusted: () => boolean;
  log?: (text: string) => void;
  createDisplay?: () => Promise<QemuDisplay | undefined>;
  buildProject?: typeof build;
  runtimeFactory?: (project: Project, log: (text: string) => void, args: string[]) => AssemblyBackend;
}
/** Existing MI test seam is retained only at the compatibility/composition boundary. */
export interface CAdapterOptions extends Omit<AdapterOptions, 'runtimeFactory'> {
  runtimeFactory?: (project: Project, log: (text: string) => void, args: string[]) => GdbConnection;
  backendFactory?: (project: Project, log: (text: string) => void, args: string[]) => SourceBackend;
}
