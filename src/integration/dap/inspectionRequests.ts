import { disassemble } from '../../application/disassembly';
import { inspectDescriptors, inspectMemory, type InspectionRuntime } from '../../debug/inspection';
import { inspectPaging } from '../../debug/paging';
import type { InstructionDecoder } from '../../ports/instructions';
import type { CapabilityRecorder, PhysicalMemoryReader } from '../../ports/machine';
import type { Request, Respond } from './protocol';
export class InspectionRequests {
  constructor(
    private readonly requireStopped: () => InspectionRuntime &
      PhysicalMemoryReader & { capabilities?: CapabilityRecorder },
    private readonly decoder: InstructionDecoder,
    private readonly instructions: () => unknown[],
    private readonly response: Respond
  ) {}
  async handle(request: Request): Promise<boolean> {
    const args = request.arguments ?? {};
    switch (request.command) {
      case 'disassemble': {
        const result = await disassemble(this.requireStopped(), args, this.decoder);
        this.response(request, { instructions: result.instructions });
        return true;
      }
      case 'qemuAsm.disassemble':
        this.response(request, {
          ...(await disassemble(this.requireStopped(), args, this.decoder)),
          breakpoints: this.instructions()
        });
        return true;
      case 'qemuAsm.inspectMemory':
        this.response(request, await inspectMemory(this.requireStopped(), args));
        return true;
      case 'qemuAsm.inspectDescriptors':
        this.response(request, await inspectDescriptors(this.requireStopped(), args));
        return true;
      case 'qemuAsm.inspectPaging':
        this.response(request, await inspectPaging(this.requireStopped(), args));
        return true;
    }
    return false;
  }
}
