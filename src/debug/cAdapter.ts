/** Compatibility API. GDB wiring is confined to the composition root. */
import type { CAdapterOptions } from '../composition/options';
import { sourceServices } from '../composition/sessionServices';
import { SourceDapAdapter } from '../integration/dap/sourceAdapter';
export type { GdbConnection as CSourceRuntime } from '../backends/gdb/connection';
export type { CAdapterOptions } from '../composition/options';
export { isSafeCExpression } from '../domain/source/expression';
export class CSourceDebugAdapter extends SourceDapAdapter {
  constructor(options: CAdapterOptions) {
    super(sourceServices(options));
  }
}
