import { MachineBreakpoints } from '../../debug/machineBreakpoints';
import type { DataWatchpoint } from '../../ports/machine';
import type { Request, Respond } from './protocol';
export interface MachineBreakpointAccess {
  configure(): unknown;
  stopped(): unknown;
}
export interface MachineBreakpointInstall {
  instructions(addresses: number[]): Promise<void>;
  watches(points: DataWatchpoint[]): Promise<void>;
}
export class MachineRequests {
  constructor(
    private readonly machine: MachineBreakpoints,
    private readonly access: MachineBreakpointAccess,
    private readonly install: MachineBreakpointInstall,
    private readonly lastHit: () => unknown,
    private readonly response: Respond,
    private readonly warning?: string
  ) {}
  async handle(request: Request): Promise<boolean> {
    const args = request.arguments ?? {};
    switch (request.command) {
      case 'setInstructionBreakpoints':
        this.access.configure();
        this.response(request, {
          breakpoints: await this.machine.setNativeInstructions(args.breakpoints ?? [], (addresses) =>
            this.install.instructions(addresses)
          )
        });
        return true;
      case 'qemuAsm.instructionBreakpoints':
        this.access.stopped();
        this.response(
          request,
          await this.machine.changeInstruction(args, (addresses) => this.install.instructions(addresses))
        );
        return true;
      case 'setDataBreakpoints': {
        this.access.configure();
        const inputs = Array.isArray(args.breakpoints) ? (args.breakpoints as Record<string, unknown>[]) : [];
        const breakpoints = await this.machine.setNativeWatches(args.breakpoints ?? [], (points) =>
          this.install.watches(points)
        );
        this.response(request, {
          breakpoints: breakpoints.map((point, index) =>
            this.warning && point.verified && (inputs[index]?.accessType ?? 'write') === 'write'
              ? { ...point, message: this.warning }
              : point
          )
        });
        return true;
      }
      case 'qemuAsm.watchpoints':
        this.access.stopped();
        this.response(request, {
          ...(await this.machine.changeWatch(args, (points) => this.install.watches(points))),
          warnings: this.warning ? [this.warning] : [],
          ...(this.lastHit() ? { lastHit: this.lastHit() } : {})
        });
        return true;
    }
    return false;
  }
}
