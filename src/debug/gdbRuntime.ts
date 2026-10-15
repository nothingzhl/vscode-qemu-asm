/** Compatibility constructor; application composition supplies the machine dependency. */
import { QemuGdbBackend } from '../backends/gdb/qemuBackend';
import { QemuVirtualMachine } from '../backends/qemu/virtualMachine';
import { Processes } from '../platform/processes';
import type { Project } from '../project/model';
export { validateDebugElf } from '../backends/gdb/elf';
export { gdbPathQuote } from '../backends/gdb/path';
export class GdbRuntime extends QemuGdbBackend {
  readonly processes: Processes;
  constructor(project: Project, log: (text: string) => void, args: readonly string[] = []) {
    const processes = new Processes();
    super(project, log, new QemuVirtualMachine(project, processes, log, args));
    this.processes = processes;
  }
}
