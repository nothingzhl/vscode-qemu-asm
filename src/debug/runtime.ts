/** Compatibility constructor. Application consumers receive injected capability contracts. */
import { QemuRspBackend } from '../backends/qemu/rspBackend';
import { QemuVirtualMachine } from '../backends/qemu/virtualMachine';
import { Processes } from '../platform/processes';
import type { Project } from '../project/model';
export { monitorRegisters } from '../backends/qemu/monitor';
export { stoppedEvent } from '../backends/qemu/rspBackend';
export * from '../domain/x86/state';
export type { DataWatchpoint, StoppedEvent, WatchAccess } from '../ports/machine';
export class DebugRuntime extends QemuRspBackend {
  readonly processes: Processes;
  constructor(project: Project, log: (text: string) => void, args: readonly string[] = []) {
    const processes = new Processes();
    super(project, new QemuVirtualMachine(project, processes, log, args));
    this.processes = processes;
  }
}
