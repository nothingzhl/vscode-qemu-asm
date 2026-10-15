/** Compatibility entry for standalone integrations; production selects a decoder in composition. */
export { decodeInstructions, DecoderDependencyError } from '../backends/iced/decoder';
export * from '../ports/instructions';
import { disassemble as inspect } from '../application/disassembly';
import { icedDecoder } from '../backends/iced/decoder';
import type { DisassemblyRuntime } from '../ports/instructions';
export const disassemble = (runtime: DisassemblyRuntime, args: unknown = {}) =>
  inspect(runtime, args, icedDecoder);
