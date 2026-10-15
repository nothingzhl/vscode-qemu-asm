import { AssemblyDapAdapter } from '../integration/dap/assemblyAdapter';
import { SourceDapAdapter } from '../integration/dap/sourceAdapter';
import type { Project } from '../project/model';
import type { AdapterOptions } from './options';
import { assemblyServices, sourceServices } from './sessionServices';

export function createDebugAdapter(project: Project, options: Omit<AdapterOptions, 'runtimeFactory'>) {
  return project.debug
    ? new SourceDapAdapter(sourceServices(options))
    : new AssemblyDapAdapter(assemblyServices(options));
}
