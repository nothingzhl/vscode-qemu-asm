/** Compatibility API; the injected DAP consumer contains no concrete backend imports. */
import type { AdapterOptions } from '../composition/options';
import { assemblyServices } from '../composition/sessionServices';
import { AssemblyDapAdapter } from '../integration/dap/assemblyAdapter';
export type { AdapterOptions, QemuDisplay as DebugDisplay } from '../composition/options';
export class AssemblyDebugAdapter extends AssemblyDapAdapter {
  constructor(options: AdapterOptions) {
    super(assemblyServices(options));
  }
}
